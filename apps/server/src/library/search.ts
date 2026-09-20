import { sql } from 'drizzle-orm'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import {
  DatabaseFailure,
  LibrarySearchResult as LibrarySearchResultSchema,
  type LibraryFolderId,
} from '@vivid/contracts'
import type { LibraryDatabase, LibraryStoreService } from './store.ts'

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
    query: string,
    limit: number,
    folderId: Option.Option<LibraryFolderId>,
  ) {
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
          SELECT ${selectedFolderId}::text UNION ALL SELECT f.id FROM vivid_library_folders f JOIN folder_tree tree ON f.parent_id = tree.id
        )
        SELECT c.id AS "chunkId", c.document_id AS "documentId", d.name AS filename, c.page, c.text,
          ts_rank_cd(c.search_vector, websearch_to_tsquery('simple', ${query})) AS score
        FROM vivid_library_chunks c JOIN vivid_library_documents d ON d.id = c.document_id
        WHERE d.status = 'ready' AND c.search_vector @@ websearch_to_tsquery('simple', ${query}) ${folderFilter}
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
