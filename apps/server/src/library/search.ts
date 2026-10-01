import { sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import {
  DatabaseFailure,
  LibrarySearchResult as LibrarySearchResultSchema,
  type LibraryFolderId,
} from '@vivid/contracts'
import { companyOf, inWorkspace, type Actor } from '../auth/access.ts'
import { Database } from '../database/client.ts'
import { findThread, canSee } from '../threads/access.ts'
import { NotFound, InvalidRequest } from '@vivid/contracts'
import type { LibraryDatabase, LibraryStoreService } from './store.ts'
import { readableScope } from './access.ts'
import { libraryDocuments, libraryFolders } from './tables.ts'

const documents = alias(libraryDocuments, 'd')
const folders = alias(libraryFolders, 'f')

const RawSearchRows = Schema.Struct({
  rows: Schema.Array(
    Schema.Struct({
      chunkId: Schema.String,
      documentId: Schema.String,
      filename: Schema.String,
      page: Schema.NullOr(Schema.Number),
      text: Schema.String,
      score: Schema.Union([Schema.Number, Schema.String]),
    }),
  ),
})
type RawSearchRow = (typeof RawSearchRows.Type)['rows'][number]
const rawSearchRowsDecoder = Schema.decodeUnknownEffect(RawSearchRows)
const librarySearchResultSchemaDecoder = Schema.decodeUnknownEffect(LibrarySearchResultSchema)

/** Converts one ranked database row into the public search result contract. */
const decodeSearchResult = Effect.fn('LibraryStore.decodeSearchResult')(function* (
  row: RawSearchRow,
) {
  return yield* librarySearchResultSchemaDecoder({
    ...row,
    score: Number(Number(row.score).toFixed(4)),
  }).pipe(
    Effect.mapError(
      () => new DatabaseFailure({ message: 'Database returned an invalid Library search result' }),
    ),
  )
})

/** Builds full-text search while keeping recursive folder filtering in SQL. */
export const searchOperation = (database: LibraryDatabase): LibraryStoreService['search'] =>
  Effect.fn('LibraryStore.search')(function* (
    actor: Actor,
    {
      query,
      limit,
      folderId,
    }: {
      readonly query: string
      readonly limit: number
      readonly folderId: Option.Option<LibraryFolderId>
    },
  ) {
    const scope = yield* searchScope(actor).pipe(Effect.provideService(Database, database))
    const folderScope = readableScope(folders, actor)
    const boundedLimit = Math.max(1, Math.min(limit, 10))
    const folderFilter = Option.isNone(folderId)
      ? sql``
      : sql`AND d.folder_id IN (SELECT id FROM folder_tree)`
    const selectedFolderId = Option.match(folderId, {
      onNone: () => null,
      onSome: (id) => id,
    })
    const result = yield* database.run(
      database.execute(sql`
        WITH RECURSIVE folder_tree(id) AS (
          SELECT f.id FROM vivid_library_folders f WHERE f.id = ${selectedFolderId} AND (${folderScope})
          UNION SELECT f.id FROM vivid_library_folders f JOIN folder_tree tree ON f.parent_id = tree.id WHERE (${folderScope})
        )
        SELECT c.id AS "chunkId", c.document_id AS "documentId", d.name AS filename, c.page, c.text,
          ts_rank_cd(c.search_vector, websearch_to_tsquery('simple', ${query})) AS score
        FROM vivid_library_chunks c JOIN vivid_library_documents d ON d.id = c.document_id
        WHERE (${scope}) AND d.status = 'ready' AND c.search_vector @@ websearch_to_tsquery('simple', ${query}) ${folderFilter}
        ORDER BY score DESC, c.ordinal ASC LIMIT ${boundedLimit}
      `),
    )
    const decoded = yield* rawSearchRowsDecoder(result).pipe(
      Effect.mapError(
        () => new DatabaseFailure({ message: 'Database returned invalid Library search rows' }),
      ),
    )
    return yield* Effect.forEach(decoded.rows, decodeSearchResult)
  })

/** In a shared Thread, even highly ranked Mine chunks must never enter the result set. */
const searchScope = Effect.fn('Library.searchScope')(function* (actor: Actor) {
  const company = companyOf(actor.workspace)
  const readable = readableScope(documents, actor)
  if (actor.by === 'person') return readable
  if (Option.isNone(actor.threadId))
    return yield* Effect.fail(
      new InvalidRequest({ message: 'Vivid Library search requires a Thread' }),
    )
  const thread = yield* findThread(actor.threadId.value)
  if (Option.isNone(thread) || !(yield* canSee(thread.value, actor.person.id)))
    return yield* Effect.fail(new NotFound({ message: 'Thread not found' }))
  if (thread.value.audience === 'private') return readable
  if (Option.isNone(company) || thread.value.companyId !== company.value.id)
    return yield* Effect.fail(
      new InvalidRequest({ message: 'Shared Thread must be in the active Company' }),
    )
  return inWorkspace(documents, actor)
})
