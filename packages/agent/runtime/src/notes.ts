import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import { MemoryKind, type PersonId } from '@vivid/contracts'
import type { AgentFS } from 'agentfs-sdk'
import * as Arr from 'effect/Array'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Order from 'effect/Order'
import * as Schema from 'effect/Schema'

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
  return Option.map(decodeHeader({ kind, description }), (header) => ({
    ...header,
    body: body === undefined ? '' : body.trimEnd(),
  }))
}

/** A Person's identifier becomes part of a path on disk, so only a plain identifier is accepted. */
const SAFE_PERSON = /^[A-Za-z0-9_-]{1,128}$/u

/** One open filesystem per Person for the life of the process; opening costs 60 to 100 ms. */
const open = new Map<string, Promise<AgentFS>>()

/**
 * AgentFS is loaded only when a Person's notes are first opened. It ships a native SQLite binary
 * per platform; an installation that keeps no notes, or an image the binary does not support,
 * must still start, so the package is never loaded when the module is.
 */
function openStore(path: string) {
  return import('agentfs-sdk').then(({ AgentFS: store }) => {
    // AgentFS makes directories only for its own default location, not for a path it is given. The
    // notes directory is required but need not exist yet (a fresh checkout, a new volume), and
    // without this every note call would fail until someone made it by hand.
    return NodeFS.promises
      .mkdir(NodePath.dirname(path), { recursive: true })
      .then(() => store.open({ path }))
  })
}

/** Open, or reuse, the Person's filesystem. A failed open is forgotten so the next call tries again. */
const opened = Effect.fn('Notes.open')(function* (directory: string, person: PersonId) {
  if (!SAFE_PERSON.test(person)) return yield* NotesUnavailable.make({})
  const path = NodePath.join(directory, `${person}.db`)
  const existing = open.get(path)
  const pending = existing === undefined ? openStore(path) : existing
  open.set(path, pending)
  return yield* Effect.tryPromise({
    try: () => pending,
    catch: () => NotesUnavailable.make({}),
  }).pipe(Effect.tapError(() => Effect.sync(() => open.delete(path))))
})

const isMissing = Schema.is(Schema.Struct({ code: Schema.Literal('ENOENT') }))
const isNoteFile = Schema.is(NoteFile)

/** A narrow Promise boundary around one AgentFS call; its only expected failure is a missing file. */
function attempt<A>(file: NoteFile, call: () => Promise<A>) {
  return Effect.tryPromise({
    try: call,
    catch: (cause) => (isMissing(cause) ? NoteMissing.make({ file }) : NotesUnavailable.make({})),
  })
}

export interface NotesOf {
  readonly directory: string
  readonly person: PersonId
}

/**
 * The index for one response. Entries are listed with their statistics in one query
 * (`readdirPlus`), newest change first, and each note is read for its header. A file that is not
 * in the stored form is left out: it is not a note Vivid wrote.
 */
export const noteIndex = Effect.fn('Notes.index')(function* (notes: NotesOf) {
  const fs = (yield* opened(notes.directory, notes.person)).fs
  const entries = yield* Effect.tryPromise({
    try: () => fs.readdirPlus('/'),
    catch: () => NotesUnavailable.make({}),
  })
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
export const readNote = Effect.fn('Notes.read')(function* (notes: NotesOf, file: NoteFile) {
  const fs = (yield* opened(notes.directory, notes.person)).fs
  const note = parsed(yield* attempt(file, () => fs.readFile(`/${file}`, 'utf8')))
  if (Option.isNone(note)) return yield* NoteMissing.make({ file })
  return Note.make({ file, ...note.value })
})

/** Write a note, replacing the one with that file name if it exists. Reports which happened. */
export const writeNote = Effect.fn('Notes.write')(function* (notes: NotesOf, note: Note) {
  const fs = (yield* opened(notes.directory, notes.person)).fs
  const replaced = yield* attempt(note.file, () => fs.stat(`/${note.file}`)).pipe(
    Effect.as(true),
    Effect.catchTag('NoteMissing', () => Effect.succeed(false)),
  )
  yield* attempt(note.file, () => fs.writeFile(`/${note.file}`, stored(note)))
  return replaced
})

/** Delete a note. A file name with no note is a precise failure, never a silent success. */
export const deleteNote = Effect.fn('Notes.delete')(function* (notes: NotesOf, file: NoteFile) {
  const fs = (yield* opened(notes.directory, notes.person)).fs
  yield* attempt(file, () => fs.unlink(`/${file}`))
})
