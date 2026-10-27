import {
  applySqliteMigrations,
  type SqliteDatabase,
  type SqliteExecutor,
} from '@earendil-works/chord/sqlite'
import {
  isStandingLayer,
  MemoryAuthority,
  MemorySource,
  MemoryRevision,
  NoteAddress,
  NoteConflict,
  NoteIndex,
  NoteLine,
  NoteCursor,
  NotePage,
  NoteHit,
  NoteSearchInvalid,
  NoteSearchPage,
  type NoteSearch,
  SavedNote,
  type NoteListing,
  type NoteWrite,
  type NoteRetraction,
  type PersonId,
} from '@vivid/contracts'
import { Context, Effect, Schema } from 'effect'

export {
  Note,
  NoteFile,
  NoteIndex,
  NoteLine,
  NoteAddress,
  NoteConflict,
  NoteSearchInvalid,
} from '@vivid/contracts'

/** Failed persistence never means the Person has no memories. */
export class NotesUnavailable extends Schema.TaggedError<NotesUnavailable>()(
  'NotesUnavailable',
  {},
  { title: 'Notes unavailable' },
) {}

/** Retractions retain the last revision so an old writer cannot resurrect a removed entry. */
export class NoteMissing extends Schema.TaggedError<NoteMissing>()(
  'NoteMissing',
  {
    address: NoteAddress,
    revision: MemoryRevision,
  },
  { title: 'Memory entry absent' },
) {}

export const INDEX_BUDGET = 8000

interface NotesService {
  readonly index: (person: PersonId) => Effect.Effect<NoteIndex, NotesUnavailable>
  readonly list: (
    person: PersonId,
    listing: NoteListing,
  ) => Effect.Effect<NotePage, NotesUnavailable>
  readonly search: (
    person: PersonId,
    search: NoteSearch,
  ) => Effect.Effect<NoteSearchPage, NoteSearchInvalid | NotesUnavailable>
  readonly read: (
    person: PersonId,
    address: NoteAddress,
  ) => Effect.Effect<SavedNote, NoteMissing | NotesUnavailable>
  readonly write: (
    person: PersonId,
    write: NoteWrite,
  ) => Effect.Effect<SavedNote, NoteConflict | NotesUnavailable>
  readonly delete: (
    person: PersonId,
    retraction: NoteRetraction,
  ) => Effect.Effect<void, NoteConflict | NoteMissing | NotesUnavailable>
}

/** The cell binds acting authority and owns persistence. There is no process registry. */
export class Notes extends Context.Service<Notes, NotesService>()('@vivid/runtime/Notes') {}

const storedAuthority = Schema.fromJsonString(MemoryAuthority)
const Row = Schema.Struct({
  ...SavedNote.fields,
  authority: storedAuthority,
})
const decodeNote = Schema.decodeUnknownEffect(Row)
const decodeLines = Schema.decodeUnknownEffect(Schema.Array(NoteLine))
const decodeHits = Schema.decodeUnknownEffect(Schema.Array(NoteHit))
const encodeAuthority = Schema.encodeEffect(storedAuthority)
const RevisionRow = Schema.Struct({ revision: MemoryRevision })
const decodeRevision = Schema.decodeUnknownEffect(RevisionRow)
const decodeRevisionValue = Schema.decodeUnknownEffect(MemoryRevision)
const select =
  'layer, file, kind, description, body, basis, revision, updated_at AS updatedAt, authority'

/** Narrow Promise interop to chord's public executor. Its transaction owns rollback and queueing. */
const attempt = <A>(call: () => Promise<A>) =>
  Effect.tryPromise({
    try: call,
    catch: () => NotesUnavailable.make({}),
  })

/** A never-written address is revision zero. A retracted address keeps its real revision. */
const revisionOf = Effect.fn('Notes.revision')(function* (
  tx: SqliteExecutor,
  address: NoteAddress,
) {
  const row = yield* attempt(() =>
    tx.get<object>(
      'SELECT revision FROM memory_notes WHERE layer = ? AND file = ?',
      address.layer,
      address.file,
    ),
  )
  if (row === undefined) return MemoryRevision.make(0)
  return (yield* decodeRevision(row).pipe(Effect.mapError(() => NotesUnavailable.make({}))))
    .revision
})

/** Build an atomic snapshot, loading only standing bodies and the bounded index headers. */
const index = Effect.fn('Notes.index')(function* (database: SqliteDatabase) {
  const rows = yield* attempt(() =>
    database.transaction(
      // @effect-diagnostics-next-line asyncFunction:off -- Chord owns the Promise transaction callback and its queued handle.
      async (tx) => ({
        standing: await tx.all<object>(
          `SELECT ${select} FROM memory_notes WHERE body IS NOT NULL AND layer IN ('self', 'soul', 'person', 'attention') ORDER BY layer`,
        ),
        lines: await tx.all<object>(
          'SELECT layer, file, kind, description, basis, revision, updated_at AS updatedAt FROM memory_notes WHERE body IS NOT NULL ORDER BY updated_at DESC, layer, file',
        ),
      }),
    ),
  )
  const standing = yield* Effect.forEach(rows.standing, (row) => decodeNote(row)).pipe(
    Effect.mapError(() => NotesUnavailable.make({})),
  )
  const notes = yield* decodeLines(rows.lines).pipe(
    Effect.mapError(() => NotesUnavailable.make({})),
  )
  const lines: NoteLine[] = []
  let used = 0
  let more = false
  for (const note of notes) {
    const size = JSON.stringify(note).length
    if (!isStandingLayer(note.layer) && used + size > INDEX_BUDGET) {
      more = true
      break
    }
    if (!isStandingLayer(note.layer)) {
      used += size
      lines.push(note)
    }
  }
  return NoteIndex.make({ standing, lines, more })
})

/** Fetch one keyset page in SQLite so older entries remain reachable beyond the prompt index. */
const list = Effect.fn('Notes.list')(function* (database: SqliteDatabase, listing: NoteListing) {
  const parameters: Array<string | number | null> = [listing.layer, listing.layer]
  let after = ''
  if (listing.after !== null) {
    after = 'AND (updated_at, layer, file) < (?, ?, ?)'
    parameters.push(listing.after.updatedAt, listing.after.layer, listing.after.file)
  }
  const rows = yield* attempt(() =>
    database.all<object>(
      `SELECT layer, file, kind, description, basis, revision, updated_at AS updatedAt
      FROM memory_notes WHERE body IS NOT NULL AND (? IS NULL OR layer = ?) ${after}
      ORDER BY updated_at DESC, layer DESC, file DESC LIMIT ?`,
      ...parameters,
      listing.limit + 1,
    ),
  )
  const lines = yield* decodeLines(rows).pipe(Effect.mapError(() => NotesUnavailable.make({})))
  const entries = lines.slice(0, listing.limit)
  const last = entries.at(-1)
  const next = lines.length > listing.limit && last !== undefined ? NoteCursor.make(last) : null
  return NotePage.make({ entries, next })
})

/** Quote words before FTS5 sees punctuation as column filters or operators. Quoted phrases,
 * trailing prefix stars and the documented boolean operators retain their search meaning. */
const matchQuery = (query: string) => {
  const terms = query.match(/"(?:[^"]|"")*"\*?|[^\s"]+|"/gu)
  if (terms === null || terms.some((term) => term === '"'))
    return Effect.fail(NoteSearchInvalid.make({}))
  return Effect.succeed(
    terms
      .map((term) => {
        if (term.startsWith('"') || /^(AND|OR|NOT)$/u.test(term)) return term
        const prefix = term.endsWith('*')
        const word = prefix ? term.slice(0, -1) : term
        return `"${word}"${prefix ? '*' : ''}`
      })
      .join(' '),
  )
}

/** MATCH stays a bound parameter. Native rank/snippet handle retrieval without copying bodies into the prompt. */
const search = Effect.fn('Notes.search')(function* (database: SqliteDatabase, input: NoteSearch) {
  const query = yield* matchQuery(input.query)
  const rows = yield* Effect.tryPromise({
    try: () =>
      database.all<object>(
        `SELECT n.layer, n.file, n.kind, n.description, n.basis, n.revision,
          n.updated_at AS updatedAt, snippet(memory_search, 2, '', '', '…', 64) AS excerpt
        FROM memory_search JOIN memory_notes n ON n.id = memory_search.rowid
        WHERE memory_search MATCH ? AND n.body IS NOT NULL AND (? IS NULL OR n.layer = ?)
        ORDER BY memory_search.rank, n.layer, n.file LIMIT ? OFFSET ?`,
        query,
        input.layer,
        input.layer,
        input.limit + 1,
        input.offset,
      ),
    // A MATCH rejection is an invalid search, never evidence that memory is unavailable.
    catch: () => NoteSearchInvalid.make({}),
  })
  const hits = yield* decodeHits(rows).pipe(Effect.mapError(() => NotesUnavailable.make({})))
  return NoteSearchPage.make({
    entries: hits.slice(0, input.limit),
    nextOffset: hits.length > input.limit ? input.offset + input.limit : null,
  })
})

/** An absent body is a local retraction, distinct from unavailable storage. */
const read = Effect.fn('Notes.read')(function* (database: SqliteDatabase, address: NoteAddress) {
  const row = yield* attempt(() =>
    database.get<object>(
      `SELECT ${select} FROM memory_notes WHERE layer = ? AND file = ? AND body IS NOT NULL`,
      address.layer,
      address.file,
    ),
  )
  if (row === undefined)
    return yield* NoteMissing.make({ address, revision: yield* revisionOf(database, address) })
  return yield* decodeNote(row).pipe(Effect.mapError(() => NotesUnavailable.make({})))
})

/** Compare and replace inside one native transaction. Stale callers receive the actual revision. */
const write = Effect.fn('Notes.write')(function* (database: SqliteDatabase, input: NoteWrite) {
  const { note, authority, expected } = input
  const encoded = yield* encodeAuthority(authority).pipe(
    Effect.mapError(() => NotesUnavailable.make({})),
  )
  const updatedAt = MemorySource.guards.HistoryLoad(authority.source)
    ? authority.source.updatedAt
    : Date.now()
  const result = yield* attempt(() =>
    database.transaction(
      // @effect-diagnostics-next-line asyncFunction:off -- Chord owns the Promise transaction callback and its queued handle.
      async (tx) => {
        const row = await tx.get<{ revision: number }>(
          'SELECT revision FROM memory_notes WHERE layer = ? AND file = ?',
          note.layer,
          note.file,
        )
        const actual = row === undefined ? 0 : row.revision
        if (actual !== expected) return { actual, saved: false }
        await tx.run(
          `INSERT INTO memory_notes (layer, file, kind, description, body, basis, revision, updated_at, authority)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (layer, file) DO UPDATE SET
        kind=excluded.kind, description=excluded.description, body=excluded.body, basis=excluded.basis,
        revision=excluded.revision, updated_at=excluded.updated_at, authority=excluded.authority`,
          note.layer,
          note.file,
          note.kind,
          note.description.replace(/\s+/gu, ' ').trim(),
          note.body,
          note.basis,
          actual + 1,
          updatedAt,
          encoded,
        )
        return { actual: actual + 1, saved: true }
      },
    ),
  )
  const revision = yield* decodeRevisionValue(result.actual).pipe(
    Effect.mapError(() => NotesUnavailable.make({})),
  )
  if (!result.saved)
    return yield* NoteConflict.make({
      address: NoteAddress.make(note),
      expected,
      actual: revision,
    })
  return SavedNote.make({
    ...note,
    description: note.description.replace(/\s+/gu, ' ').trim(),
    revision,
    updatedAt,
    authority,
  })
})

/** Remove content locally, retaining a revision fence. This is not the full forget contract. */
const retract = Effect.fn('Notes.delete')(function* (
  database: SqliteDatabase,
  input: NoteRetraction,
) {
  const { address, expected } = input
  const encoded = yield* encodeAuthority(input.authority).pipe(
    Effect.mapError(() => NotesUnavailable.make({})),
  )
  const result = yield* attempt(() =>
    database.transaction(
      // @effect-diagnostics-next-line asyncFunction:off -- Chord owns the Promise transaction callback and its queued handle.
      async (tx) => {
        const row = await tx.get<{ revision: number; body: string | null }>(
          'SELECT revision, body FROM memory_notes WHERE layer = ? AND file = ?',
          address.layer,
          address.file,
        )
        const actual = row === undefined ? 0 : row.revision
        if (actual !== expected) return { actual, outcome: 'conflict' as const }
        if (row === undefined || row.body === null) return { actual, outcome: 'missing' as const }
        await tx.run(
          'UPDATE memory_notes SET body = NULL, description = ?, revision = ?, updated_at = ?, authority = ? WHERE layer = ? AND file = ?',
          '',
          actual + 1,
          Date.now(),
          encoded,
          address.layer,
          address.file,
        )
        return { actual: actual + 1, outcome: 'removed' as const }
      },
    ),
  )
  const actual = yield* decodeRevisionValue(result.actual).pipe(
    Effect.mapError(() => NotesUnavailable.make({})),
  )
  if (result.outcome === 'conflict') return yield* NoteConflict.make({ address, expected, actual })
  if (result.outcome === 'missing') return yield* NoteMissing.make({ address, revision: actual })
})
/**
 * Chord applies ordered migrations on the same queue as Pi, with a distinct ledger. The base
 * table is Drizzle-generated; the owner approved the native FTS5 migration on 27 October 2026.
 */
export const openNotes = Effect.fn('Notes.open')(function* (
  database: SqliteDatabase,
  migrations: ReadonlyArray<string>,
) {
  yield* attempt(() =>
    applySqliteMigrations(
      database,
      migrations.map((migration, ordinal) => ({
        version: ordinal + 1,
        statements: migration.split('--> statement-breakpoint'),
      })),
      { table: 'memory_migrations' },
    ),
  )

  return {
    index: () => index(database),
    list: (listing: NoteListing) => list(database, listing),
    search: (input: NoteSearch) => search(database, input),
    read: (address: NoteAddress) => read(database, address),
    write: (input: NoteWrite) => write(database, input),
    delete: (input: NoteRetraction) => retract(database, input),
  }
})

/** Native RPC transports the existing typed outcomes, including stale-revision conflicts. */
export const NoteReadResult = Schema.toCodecJson(
  Schema.Result(SavedNote, Schema.Union([NoteMissing, NotesUnavailable])),
)
export const NoteWriteResult = Schema.toCodecJson(
  Schema.Result(SavedNote, Schema.Union([NoteConflict, NotesUnavailable])),
)
export const NoteDeleteResult = Schema.toCodecJson(
  Schema.Result(Schema.Boolean, Schema.Union([NoteConflict, NoteMissing, NotesUnavailable])),
)

export const NoteSearchResult = Schema.toCodecJson(
  Schema.Result(NoteSearchPage, Schema.Union([NoteSearchInvalid, NotesUnavailable])),
)
