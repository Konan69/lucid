import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import { MemoryKind, type PersonId } from '@vivid/contracts'
import type { AgentFS } from 'agentfs-sdk'
import * as Arr from 'effect/Array'
import type * as Cause from 'effect/Cause'
import * as Context from 'effect/Context'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Latch from 'effect/Latch'
import * as RcMap from 'effect/RcMap'
import * as Option from 'effect/Option'
import * as Order from 'effect/Order'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'

/**
 * Vivid's memory: one small filesystem per Person, in one SQLite file (AgentFS), holding one note
 * per thing Vivid knows. Design, references and the proof behind it: docs/25-memory.md.
 *
 * The notes sit beside the runtime, not behind the application server, on purpose: the runtime is
 * the part of Vivid that will later run on the Person's own device, and there these are simply
 * local files. A Person's whole memory moves by copying one file.
 *
 * The folder of notes is the filesystem root and holds nothing else. In the first live run of the
 * design a model given room outside the folder wrote its index to the wrong place.
 */

/** A note's file name: short, lower-case, hyphenated, flat. Subfolders would hide a note from the index. */
export const NoteFile = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}\.md$/u),
).pipe(Schema.brand('NoteFile'))
export type NoteFile = typeof NoteFile.Type

/**
 * The longest note body. A tool result is cut at 4,000 characters before the model sees it
 * (`tools/result.ts`, `bounded`), so a longer note could be written and never read back whole.
 */
export const NOTE_BODY_LIMIT = 3500

/**
 * One thing Vivid knows. `description` is the single line the model sees on every response and
 * uses to decide whether to open the note; `body` is the fact itself, with the reason and how to
 * apply it when it is a preference or a decision. The kinds are the product's one memory vocabulary.
 */
export const Note = Schema.Struct({
  file: NoteFile,
  kind: MemoryKind,
  description: Schema.NonEmptyString.check(Schema.isMaxLength(200)),
  body: Schema.NonEmptyString.check(Schema.isMaxLength(NOTE_BODY_LIMIT)),
})
export interface Note extends Schema.Schema.Type<typeof Note> {}

/** A note as it appears in the index: everything but its body. */
export const NoteLine = Schema.Struct({
  file: NoteFile,
  kind: MemoryKind,
  description: Schema.String,
})
export interface NoteLine extends Schema.Schema.Type<typeof NoteLine> {}

/**
 * The index for one response: the notes changed most recently, within a budget, and whether older
 * ones were left out. It is derived from the notes themselves on every response and never stored,
 * so it cannot drift from them (a hand-kept index file can).
 */
export const NoteIndex = Schema.Struct({
  lines: Schema.Array(NoteLine),
  more: Schema.Boolean,
})
export interface NoteIndex extends Schema.Schema.Type<typeof NoteIndex> {}

/** The store could not be opened, read or written. Never reported to the model as "no notes". */
export class NotesUnavailable extends Schema.TaggedError<NotesUnavailable>()(
  'NotesUnavailable',
  {},
  { title: 'NotesUnavailable' },
) {}

/** The runtime's bounded set of open stores is full; the Person's file has not failed. */
export class NotesAtCapacity extends Schema.TaggedError<NotesAtCapacity>()(
  'NotesAtCapacity',
  {},
  { title: 'NotesAtCapacity' },
) {}

/** No note has that file name. */
export class NoteMissing extends Schema.TaggedError<NoteMissing>()(
  'NoteMissing',
  { file: NoteFile },
  { title: 'NoteMissing' },
) {}

/**
 * How much index goes in front of the model, in characters of file name and description. About
 * 2,000 tokens, the size Cloudflare's Think gives its writable memory block; at the measured 83
 * characters a line that is close to a hundred notes.
 */
export const INDEX_BUDGET = 8000

const Header = Schema.Struct({ kind: MemoryKind, description: Schema.NonEmptyString })
const decodeHeader = Schema.decodeUnknownOption(Header)
const decodeNote = Schema.decodeUnknownEffect(Note)

/**
 * The stored form: a header between `---` lines, then the body. It is the layout of Claude Code's
 * memory files, so a Person can read and edit a note as an ordinary Markdown file once the notes
 * are files on their own machine. `description` is folded to one line so it cannot pose as a
 * second header field.
 */
function stored(note: Note) {
  const description = note.description.replace(/\s+/gu, ' ').trim()
  return `---\nkind: ${note.kind}\ndescription: ${description}\n---\n\n${note.body.trim()}\n`
}

/** Read the header and body back. A file that is not in the stored form is not a note. */
function parsed(text: string) {
  const match = /^---\nkind: (.*)\ndescription: (.*)\n---\n\n([\s\S]*)$/u.exec(text)
  if (match === null) return Option.none<{ kind: MemoryKind; description: string; body: string }>()
  const [, kind, description, body] = match
  if (body === undefined)
    return Option.none<{ kind: MemoryKind; description: string; body: string }>()
  return Option.map(decodeHeader({ kind, description }), (header) => ({
    kind: header.kind,
    description: header.description,
    body: body.trimEnd(),
  }))
}

/** A Person's identifier becomes part of a path on disk, so only a plain identifier is accepted. */
const SAFE_PERSON = /^[A-Za-z0-9_-]{1,128}$/u

/** Stable owner policy; zero idle closes immediately, while an infinite TTL would defeat the bound. */
export const NotesSettings = Schema.Struct({
  directory: Schema.NonEmptyString,
  capacity: Schema.Int.check(Schema.isGreaterThan(0)),
  idle: Schema.Duration.check(Schema.makeFilter(Duration.isFinite)),
}).pipe(Schema.brand('NotesSettings'))
export type NotesSettings = typeof NotesSettings.Type

/** SQLite persistence and handle ownership stay inside this runtime authority. */
interface NotesService {
  readonly index: (person: PersonId) => Effect.Effect<NoteIndex, NotesUnavailable | NotesAtCapacity>
  readonly read: (
    person: PersonId,
    file: NoteFile,
  ) => Effect.Effect<Note, NoteMissing | NotesUnavailable | NotesAtCapacity>
  readonly write: (
    person: PersonId,
    note: Note,
  ) => Effect.Effect<boolean, NotesUnavailable | NotesAtCapacity>
  readonly delete: (
    person: PersonId,
    file: NoteFile,
  ) => Effect.Effect<void, NoteMissing | NotesUnavailable | NotesAtCapacity>
}

/** The authority owns both persistence and resource lifetime, rather than a hidden process cache. */
export class Notes extends Context.Service<Notes, NotesService>()('@vivid/runtime/Notes') {}

/**
 * Import the native SDK only on first use. Each Promise is one unsafe operation; a runtime that
 * never opens notes does not need to load its platform binary. AgentFS 0.6.4 open creates parents
 * only for its default location, so an explicit notes directory must be made first.
 */
const openStore = Effect.fn('Notes.open')(function* (directory: string, person: PersonId) {
  const sdk = yield* Effect.tryPromise({
    try: () => import('agentfs-sdk'),
    catch: () => NotesUnavailable.make({}),
  })
  yield* Effect.tryPromise({
    try: () => NodeFS.promises.mkdir(directory, { recursive: true }),
    catch: () => NotesUnavailable.make({}),
  })
  return yield* Effect.tryPromise({
    try: () => sdk.AgentFS.open({ path: NodePath.join(directory, `${person}.db`) }),
    catch: () => NotesUnavailable.make({}),
  })
})

/** Native close rejection is typed and ignored only at release, so it cannot become a defect. */
const closeStore = (store: AgentFS) =>
  Effect.tryPromise({
    try: () => store.close(),
    catch: () => NotesUnavailable.make({}),
  }).pipe(Effect.ignore)

const isMissing = Schema.is(Schema.Struct({ code: Schema.Literal('ENOENT') }))
const isNoteFile = Schema.is(NoteFile)

/** AgentFS cannot cancel native I/O. Retain the operation lease until the whole SDK call settles. */
function attempt<A>(file: NoteFile, call: () => Promise<A>) {
  return Effect.tryPromise({
    try: call,
    catch: (cause) => (isMissing(cause) ? NoteMissing.make({ file }) : NotesUnavailable.make({})),
  }).pipe(Effect.uninterruptible)
}

/**
 * The index for one response. Entries are listed with their statistics in one query
 * (`readdirPlus`), newest change first, and each note is read for its header. A file that is not
 * in the stored form is left out: it is not a note Vivid wrote.
 */
const noteIndex = Effect.fn('Notes.storeIndex')(function* (store: AgentFS) {
  const fs = store.fs
  const entries = yield* Effect.tryPromise({
    try: () => fs.readdirPlus('/'),
    catch: () => NotesUnavailable.make({}),
  }).pipe(Effect.uninterruptible)
  const files = Arr.sortWith(
    entries.filter((entry) => isNoteFile(entry.name)),
    (entry) => entry.stats.mtime,
    Order.flip(Order.Number),
  )
  const lines: Array<NoteLine> = []
  let used = 0
  for (const entry of files) {
    const file = NoteFile.make(entry.name)
    const note = parsed(yield* attempt(file, () => fs.readFile(`/${file}`, 'utf8')))
    if (Option.isNone(note)) continue
    used += file.length + note.value.description.length
    if (used > INDEX_BUDGET && lines.length > 0) return NoteIndex.make({ lines, more: true })
    lines.push(NoteLine.make({ file, kind: note.value.kind, description: note.value.description }))
  }
  return NoteIndex.make({ lines, more: false })
})

/** One note, whole. */
const readNote = Effect.fn('Notes.storeRead')(function* (store: AgentFS, file: NoteFile) {
  const fs = store.fs
  const note = parsed(yield* attempt(file, () => fs.readFile(`/${file}`, 'utf8')))
  if (Option.isNone(note)) return yield* NoteMissing.make({ file })
  // Persisted text is unknown input: a malformed body must be missing, never a constructor defect.
  return yield* decodeNote({ file, ...note.value }).pipe(
    Effect.mapError(() => NoteMissing.make({ file })),
  )
})

/** Write a note, replacing the one with that file name if it exists. Reports which happened. */
const writeNote = Effect.fn('Notes.storeWrite')(function* (store: AgentFS, note: Note) {
  const fs = store.fs
  const replaced = yield* attempt(note.file, () => fs.stat(`/${note.file}`)).pipe(
    Effect.as(true),
    Effect.catchTag('NoteMissing', () => Effect.succeed(false)),
  )
  yield* attempt(note.file, () => fs.writeFile(`/${note.file}`, stored(note)))
  return replaced
})

/** Delete a note. A file name with no note is a precise failure, never a silent success. */
const deleteNote = Effect.fn('Notes.storeDelete')(function* (store: AgentFS, file: NoteFile) {
  const fs = store.fs
  yield* attempt(file, () => fs.unlink(`/${file}`))
})

/**
 * One scoped RcMap owns every store. Effect 4.0.2 get leases the entry until the operation's scope
 * closes, so neither idle expiry nor capacity can close it between its native calls.
 *
 * Only the failed lookup invalidates. tapError sits OUTSIDE acquireRelease: acquisition is
 * uninterruptible, but expiry/owner close can remove its entry while native open is pending.
 * Restoring interruption before tapError prevents that old failure removing a new healthy
 * entry for the same Person (RcMap.invalidate is by key, not entry identity). Successful opens
 * always register close before interruption is restored. Invalidation starts immediately in a
 * detached fiber: when no caller remains, closing the entry awaits this lookup's exit and must
 * not run inside the lookup itself. Source: RcMap.ts get/release/invalidate and internal/effect.ts
 * acquireRelease/fiberRunIn in installed Effect 4.0.2.
 */
export const make = Effect.fn('Notes.make')(function* (settings: NotesSettings) {
  // Own sequential finalization even when the caller provides a parallel scope.
  const owner = yield* Scope.fork(yield* Effect.scope)
  const stores: RcMap.RcMap<PersonId, AgentFS, NotesUnavailable | Cause.ExceededCapacityError> =
    yield* RcMap.make({
      capacity: settings.capacity,
      idleTimeToLive: settings.idle,
      lookup: (person: PersonId) =>
        Effect.acquireRelease(openStore(settings.directory, person), closeStore).pipe(
          Effect.tapError(() =>
            Effect.forkDetach(RcMap.invalidate(stores, person), { startImmediately: true }),
          ),
        ),
    }).pipe(Scope.provide(owner))
  let closed = false
  let active = 0
  const drained = Latch.makeUnsafe(true)
  // RcMap shutdown closes entries regardless of reference counts. Stop admission and await
  // operation scopes before its finalizer runs, including a cancelled caller's native receipt.
  yield* Scope.addFinalizer(
    owner,
    Effect.suspend(() => {
      closed = true
      return drained.await
    }),
  )

  /** Admission and release cannot be interrupted. Operations stay cancellable between SDK calls. */
  const using = <A, E>(operation: Effect.Effect<A, E, Scope.Scope>) =>
    Effect.acquireUseRelease(
      Effect.suspend(() => {
        if (closed) return Effect.fail(NotesUnavailable.make({}))
        active++
        drained.closeUnsafe()
        return Effect.void
      }),
      () => Effect.scoped(operation),
      () =>
        Effect.sync(() => {
          active--
          if (active === 0) drained.openUnsafe()
        }),
    )
  const opened = Effect.fn('Notes.lease')(function* (person: PersonId) {
    // Validate before capacity admission; an unsafe disk path is never a full-store failure.
    if (!SAFE_PERSON.test(person)) return yield* NotesUnavailable.make({})
    return yield* RcMap.get(stores, person).pipe(
      Effect.catchTag('ExceededCapacityError', () =>
        Effect.logWarning('Notes store capacity reached').pipe(
          Effect.andThen(Effect.fail(NotesAtCapacity.make({}))),
        ),
      ),
    )
  })
  return Notes.of({
    index: Effect.fn('Notes.index')(function* (person: PersonId) {
      return yield* noteIndex(yield* opened(person)).pipe(
        Effect.catchTag('NoteMissing', () => Effect.fail(NotesUnavailable.make({}))),
      )
    }, using),
    read: Effect.fn('Notes.read')(function* (person: PersonId, file: NoteFile) {
      return yield* readNote(yield* opened(person), file)
    }, using),
    write: Effect.fn('Notes.write')(function* (person: PersonId, note: Note) {
      return yield* writeNote(yield* opened(person), note).pipe(
        Effect.catchTag('NoteMissing', () => Effect.fail(NotesUnavailable.make({}))),
      )
    }, using),
    delete: Effect.fn('Notes.delete')(function* (person: PersonId, file: NoteFile) {
      return yield* deleteNote(yield* opened(person), file)
    }, using),
  })
})

/** The Layer owns the map's scope, independently of the shorter scopes of its operations. */
export const layer = (settings: NotesSettings) => Layer.effect(Notes, make(settings))
