import {
  applySqliteMigrations,
  type SqliteDatabase,
  type SqliteExecutor,
} from '@earendil-works/chord/sqlite'
import {
  isStandingLayer,
  MemoryAuthority,
  MemoryCitations,
  MemoryScope,
  MemorySource,
  MemoryRevision,
  MemoryAddress,
  MemoryConflict,
  MemoryIndex,
  MemoryLine,
  MemoryCursor,
  MemoryPage,
  MemoryHit,
  MemorySearchInvalid,
  MemorySearchPage,
  type MemorySearch,
  SavedMemory,
  type MemoryListing,
  type MemoryWrite,
  type MemoryRetraction,
  type PersonId,
} from '@vivid/contracts'
import { Context, Effect, Schema } from 'effect'

export {
  MemoryEntry,
  MemoryFile,
  MemoryIndex,
  MemoryAddress,
  MemoryConflict,
  MemorySearchInvalid,
} from '@vivid/contracts'

/** Failed persistence never means the Person has no memories. */
export class MemoryUnavailable extends Schema.TaggedError<MemoryUnavailable>()(
  'MemoryUnavailable',
  {},
  { title: 'Memory unavailable' },
) {}

/** Retractions retain the last revision so an old writer cannot resurrect a removed entry. */
export class MemoryMissing extends Schema.TaggedError<MemoryMissing>()(
  'MemoryMissing',
  {
    address: MemoryAddress,
    revision: MemoryRevision,
  },
  { title: 'Memory entry absent' },
) {}

const INDEX_BUDGET = 8000

/**
 * Who writes memory in a call, and what the write rests on. The host builds both, from the Run
 * or the learner it serves; no tool argument reaches either.
 */
export interface MemoryWriter {
  readonly authority: MemoryAuthority
  readonly citations: MemoryCitations
}

interface MemoryService {
  readonly index: (person: PersonId) => Effect.Effect<MemoryIndex, MemoryUnavailable>
  readonly list: (
    person: PersonId,
    listing: MemoryListing,
  ) => Effect.Effect<MemoryPage, MemoryUnavailable>
  readonly search: (
    person: PersonId,
    search: MemorySearch,
  ) => Effect.Effect<MemorySearchPage, MemorySearchInvalid | MemoryUnavailable>
  readonly read: (
    person: PersonId,
    address: MemoryAddress,
  ) => Effect.Effect<SavedMemory, MemoryMissing | MemoryUnavailable>
  readonly write: (
    person: PersonId,
    write: MemoryWrite,
  ) => Effect.Effect<SavedMemory, MemoryConflict | MemoryUnavailable>
  readonly delete: (
    person: PersonId,
    retraction: MemoryRetraction,
  ) => Effect.Effect<void, MemoryConflict | MemoryMissing | MemoryUnavailable>
}

/** The cell binds acting authority and owns persistence. There is no process registry. */
export class Memory extends Context.Service<Memory, MemoryService>()('@vivid/runtime/Memory') {}

const storedAuthority = Schema.fromJsonString(MemoryAuthority)
const storedScope = Schema.fromJsonString(MemoryScope)
const storedCitations = Schema.fromJsonString(MemoryCitations)
const Row = Schema.Struct({
  ...SavedMemory.fields,
  authority: storedAuthority,
  scope: storedScope,
  citations: storedCitations,
})
const decodeEntry = Schema.decodeUnknownEffect(Row)
const decodeLines = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ ...MemoryLine.fields, scope: storedScope })),
)
const decodeHits = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ ...MemoryHit.fields, scope: storedScope })),
)
const encodeAuthority = Schema.encodeEffect(storedAuthority)
const encodeScope = Schema.encodeEffect(storedScope)
const encodeCitations = Schema.encodeEffect(storedCitations)
const RevisionRow = Schema.Struct({ revision: MemoryRevision })
const decodeRevision = Schema.decodeUnknownEffect(RevisionRow)
const decodeRevisionValue = Schema.decodeUnknownEffect(MemoryRevision)
const select =
  'layer, file, kind, description, body, basis, scope, revision, updated_at AS updatedAt, authority, citations'
const lineColumns =
  'layer, file, kind, description, basis, scope, revision, updated_at AS updatedAt'

/** Narrow Promise interop to chord's public executor. Its transaction owns rollback and queueing. */
const attempt = <A>(call: () => Promise<A>) =>
  Effect.tryPromise({
    try: call,
    catch: () => MemoryUnavailable.make({}),
  })

/** A never-written address is revision zero. A retracted address keeps its real revision. */
const revisionOf = Effect.fn('Memory.revision')(function* (
  tx: SqliteExecutor,
  address: MemoryAddress,
) {
  const row = yield* attempt(() =>
    tx.get<object>(
      'SELECT revision FROM memory_entries WHERE layer = ? AND file = ?',
      address.layer,
      address.file,
    ),
  )
  if (row === undefined) return MemoryRevision.make(0)
  return (yield* decodeRevision(row).pipe(Effect.mapError(() => MemoryUnavailable.make({}))))
    .revision
})

/** Build an atomic snapshot, loading only standing bodies and the bounded index headers. */
const index = Effect.fn('Memory.index')(function* (database: SqliteDatabase) {
  const rows = yield* attempt(() =>
    database.transaction(
      // @effect-diagnostics-next-line asyncFunction:off -- Chord owns the Promise transaction callback and its queued handle.
      async (tx) => ({
        standing: await tx.all<object>(
          `SELECT ${select} FROM memory_entries WHERE body IS NOT NULL AND layer IN ('self', 'soul', 'person', 'attention') ORDER BY layer`,
        ),
        lines: await tx.all<object>(
          // The same order as `list`, so a cursor taken from the last index line continues it exactly.
          `SELECT ${lineColumns} FROM memory_entries WHERE body IS NOT NULL ORDER BY updated_at DESC, layer DESC, file DESC`,
        ),
      }),
    ),
  )
  const standing = yield* Effect.forEach(rows.standing, (row) => decodeEntry(row)).pipe(
    Effect.mapError(() => MemoryUnavailable.make({})),
  )
  const memory = yield* decodeLines(rows.lines).pipe(
    Effect.mapError(() => MemoryUnavailable.make({})),
  )
  const lines: MemoryLine[] = []
  let used = 0
  let more = false
  for (const entry of memory) {
    const size = JSON.stringify(entry).length
    if (!isStandingLayer(entry.layer) && used + size > INDEX_BUDGET) {
      more = true
      break
    }
    if (!isStandingLayer(entry.layer)) {
      used += size
      lines.push(entry)
    }
  }
  return MemoryIndex.make({ standing, lines, more })
})

/** Fetch one keyset page in SQLite so older entries remain reachable beyond the prompt index. */
const list = Effect.fn('Memory.list')(function* (database: SqliteDatabase, listing: MemoryListing) {
  const parameters: Array<string | number | null> = [listing.layer, listing.layer]
  let after = ''
  if (listing.after !== null) {
    after = 'AND (updated_at, layer, file) < (?, ?, ?)'
    parameters.push(listing.after.updatedAt, listing.after.layer, listing.after.file)
  }
  const rows = yield* attempt(() =>
    database.all<object>(
      `SELECT ${lineColumns}
      FROM memory_entries WHERE body IS NOT NULL AND (? IS NULL OR layer = ?) ${after}
      ORDER BY updated_at DESC, layer DESC, file DESC LIMIT ?`,
      ...parameters,
      listing.limit + 1,
    ),
  )
  const lines = yield* decodeLines(rows).pipe(Effect.mapError(() => MemoryUnavailable.make({})))
  const entries = lines.slice(0, listing.limit)
  const last = entries.at(-1)
  const next = lines.length > listing.limit && last !== undefined ? MemoryCursor.make(last) : null
  return MemoryPage.make({ entries, next })
})

/** Quote words before FTS5 sees punctuation as column filters or operators. Quoted phrases,
 * trailing prefix stars and the documented boolean operators retain their search meaning. */
const matchQuery = (query: string) => {
  const terms = query.match(/"(?:[^"]|"")*"\*?|[^\s"]+|"/gu)
  if (terms === null || terms.some((term) => term === '"'))
    return Effect.fail(MemorySearchInvalid.make({}))
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
const search = Effect.fn('Memory.search')(function* (
  database: SqliteDatabase,
  input: MemorySearch,
) {
  const query = yield* matchQuery(input.query)
  const rows = yield* Effect.tryPromise({
    try: () =>
      database.all<object>(
        `SELECT n.layer, n.file, n.kind, n.description, n.basis, n.scope, n.revision,
          n.updated_at AS updatedAt, snippet(memory_search, 2, '', '', '…', 64) AS excerpt
        FROM memory_search JOIN memory_entries n ON n.id = memory_search.rowid
        WHERE memory_search MATCH ? AND n.body IS NOT NULL AND (? IS NULL OR n.layer = ?)
        ORDER BY memory_search.rank, n.layer, n.file LIMIT ? OFFSET ?`,
        query,
        input.layer,
        input.layer,
        input.limit + 1,
        input.offset,
      ),
    // A MATCH rejection is an invalid search, never evidence that memory is unavailable.
    catch: () => MemorySearchInvalid.make({}),
  })
  const hits = yield* decodeHits(rows).pipe(Effect.mapError(() => MemoryUnavailable.make({})))
  return MemorySearchPage.make({
    entries: hits.slice(0, input.limit),
    nextOffset: hits.length > input.limit ? input.offset + input.limit : null,
  })
})

/** An absent body is a local retraction, distinct from unavailable storage. */
const read = Effect.fn('Memory.read')(function* (database: SqliteDatabase, address: MemoryAddress) {
  const row = yield* attempt(() =>
    database.get<object>(
      `SELECT ${select} FROM memory_entries WHERE layer = ? AND file = ? AND body IS NOT NULL`,
      address.layer,
      address.file,
    ),
  )
  if (row === undefined)
    return yield* MemoryMissing.make({ address, revision: yield* revisionOf(database, address) })
  return yield* decodeEntry(row).pipe(Effect.mapError(() => MemoryUnavailable.make({})))
})

/** Compare and replace inside one native transaction. Stale callers receive the actual revision. */
const write = Effect.fn('Memory.write')(function* (database: SqliteDatabase, input: MemoryWrite) {
  const { entry, authority, expected, citations } = input
  const encoded = yield* encodeAuthority(authority).pipe(
    Effect.mapError(() => MemoryUnavailable.make({})),
  )
  const scope = yield* encodeScope(entry.scope).pipe(
    Effect.mapError(() => MemoryUnavailable.make({})),
  )
  const cited = yield* encodeCitations(citations).pipe(
    Effect.mapError(() => MemoryUnavailable.make({})),
  )
  const updatedAt = MemorySource.guards.HistoryLoad(authority.source)
    ? authority.source.updatedAt
    : Date.now()
  const result = yield* attempt(() =>
    database.transaction(
      // @effect-diagnostics-next-line asyncFunction:off -- Chord owns the Promise transaction callback and its queued handle.
      async (tx) => {
        const row = await tx.get<{ revision: number }>(
          'SELECT revision FROM memory_entries WHERE layer = ? AND file = ?',
          entry.layer,
          entry.file,
        )
        const actual = row === undefined ? 0 : row.revision
        if (actual !== expected) return { actual, saved: false }
        await tx.run(
          `INSERT INTO memory_entries (layer, file, kind, description, body, basis, revision, updated_at, authority, scope, citations)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (layer, file) DO UPDATE SET
        kind=excluded.kind, description=excluded.description, body=excluded.body, basis=excluded.basis,
        revision=excluded.revision, updated_at=excluded.updated_at, authority=excluded.authority,
        scope=excluded.scope, citations=excluded.citations`,
          entry.layer,
          entry.file,
          entry.kind,
          entry.description.replace(/\s+/gu, ' ').trim(),
          entry.body,
          entry.basis,
          actual + 1,
          updatedAt,
          encoded,
          scope,
          cited,
        )
        return { actual: actual + 1, saved: true }
      },
    ),
  )
  const revision = yield* decodeRevisionValue(result.actual).pipe(
    Effect.mapError(() => MemoryUnavailable.make({})),
  )
  if (!result.saved)
    return yield* MemoryConflict.make({
      address: MemoryAddress.make(entry),
      expected,
      actual: revision,
    })
  return SavedMemory.make({
    ...entry,
    description: entry.description.replace(/\s+/gu, ' ').trim(),
    revision,
    updatedAt,
    authority,
    citations,
  })
})

/** Remove content locally, retaining a revision fence. This is not the full forget contract. */
const retract = Effect.fn('Memory.delete')(function* (
  database: SqliteDatabase,
  input: MemoryRetraction,
) {
  const { address, expected } = input
  const encoded = yield* encodeAuthority(input.authority).pipe(
    Effect.mapError(() => MemoryUnavailable.make({})),
  )
  const result = yield* attempt(() =>
    database.transaction(
      // @effect-diagnostics-next-line asyncFunction:off -- Chord owns the Promise transaction callback and its queued handle.
      async (tx) => {
        const row = await tx.get<{ revision: number; body: string | null }>(
          'SELECT revision, body FROM memory_entries WHERE layer = ? AND file = ?',
          address.layer,
          address.file,
        )
        const actual = row === undefined ? 0 : row.revision
        if (actual !== expected) return { actual, outcome: 'conflict' as const }
        if (row === undefined || row.body === null) return { actual, outcome: 'missing' as const }
        await tx.run(
          'UPDATE memory_entries SET body = NULL, description = ?, revision = ?, updated_at = ?, authority = ? WHERE layer = ? AND file = ?',
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
    Effect.mapError(() => MemoryUnavailable.make({})),
  )
  if (result.outcome === 'conflict')
    return yield* MemoryConflict.make({ address, expected, actual })
  if (result.outcome === 'missing') return yield* MemoryMissing.make({ address, revision: actual })
})
/**
 * Chord applies ordered migrations on the same queue as Pi, with a distinct ledger. The base
 * table is Drizzle-generated; the owner approved the native FTS5 migration on 27 October 2026.
 */
export const openMemory = Effect.fn('Memory.open')(function* (
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
    list: (listing: MemoryListing) => list(database, listing),
    search: (input: MemorySearch) => search(database, input),
    read: (address: MemoryAddress) => read(database, address),
    write: (input: MemoryWrite) => write(database, input),
    delete: (input: MemoryRetraction) => retract(database, input),
  }
})

/** Native RPC transports the existing typed outcomes, including stale-revision conflicts. */
export const MemoryReadResult = Schema.toCodecJson(
  Schema.Result(SavedMemory, Schema.Union([MemoryMissing, MemoryUnavailable])),
)
export const MemoryWriteResult = Schema.toCodecJson(
  Schema.Result(SavedMemory, Schema.Union([MemoryConflict, MemoryUnavailable])),
)
export const MemoryDeleteResult = Schema.toCodecJson(
  Schema.Result(Schema.Boolean, Schema.Union([MemoryConflict, MemoryMissing, MemoryUnavailable])),
)

export const MemorySearchResult = Schema.toCodecJson(
  Schema.Result(MemorySearchPage, Schema.Union([MemorySearchInvalid, MemoryUnavailable])),
)
