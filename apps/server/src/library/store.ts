import { eq, sql } from 'drizzle-orm'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import {
  DatabaseFailure,
  LibraryFolder as LibraryFolderSchema,
  type LibraryFolder,
  type LibraryFolderId,
  LibraryItem as LibraryItemSchema,
  type LibraryItem,
  type LibraryItemId,
  LibrarySearchResult as LibrarySearchResultSchema,
  PatchLibraryFolderRequest,
  PatchLibraryItemRequest,
} from '@vivid/contracts'
import { createInsertSchema, createSelectSchema } from 'drizzle-orm/effect-schema'
import { Database, type DatabaseInfrastructureError, returned } from '../database/client.ts'
import { InvalidLibraryFolder, folderOperations } from './folders.ts'
import { itemOperations } from './items.ts'
import { searchOperation } from './search.ts'
import { libraryChunks, libraryDocuments, libraryFolders } from './tables.ts'

export { InvalidLibraryFolder } from './folders.ts'

export const LibraryDocumentRow = createSelectSchema(libraryDocuments)
export const LibraryDocumentInsert = createInsertSchema(libraryDocuments)
const FolderRow = createSelectSchema(libraryFolders)
export const LibraryChunkInsert = createInsertSchema(libraryChunks)
type LibrarySearchResult = typeof LibrarySearchResultSchema.Type
export type PatchLibraryFolderInput = typeof PatchLibraryFolderRequest.Type
export type PatchLibraryItemInput = typeof PatchLibraryItemRequest.Type

const RawCountRows = Schema.Struct({
  rows: Schema.Array(Schema.Struct({ count: Schema.Union([Schema.Number, Schema.String]) })),
})

export interface StoredLibraryItem extends LibraryItem {
  readonly bytes: Uint8Array
  readonly extractedText: string
}

export interface IndexedChunk {
  readonly page: number | null
  readonly text: string
}

export type LibraryDatabase = Database['Service']
export type LibraryDocumentRow = typeof libraryDocuments.$inferSelect
export type LibraryFolderRow = typeof libraryFolders.$inferSelect
export type DecodeItem = (
  row: LibraryDocumentRow,
) => Effect.Effect<LibraryItem, DatabaseInfrastructureError>
export type DecodeFolder = (
  row: LibraryFolderRow,
) => Effect.Effect<LibraryFolder, DatabaseInfrastructureError>

export interface LibraryStoreService {
  readonly listItems: (
    folderId: Option.Option<LibraryFolderId>,
  ) => Effect.Effect<ReadonlyArray<LibraryItem>, DatabaseInfrastructureError>
  readonly listFolders: () => Effect.Effect<
    ReadonlyArray<LibraryFolder>,
    DatabaseInfrastructureError
  >
  readonly listChildFolders: (
    parentId: LibraryFolderId | null,
  ) => Effect.Effect<ReadonlyArray<LibraryFolder>, DatabaseInfrastructureError>
  readonly getFolder: (
    id: LibraryFolderId,
  ) => Effect.Effect<Option.Option<LibraryFolder>, DatabaseInfrastructureError>
  readonly createFolder: (
    name: string,
    parentId: LibraryFolderId | null,
  ) => Effect.Effect<LibraryFolder, DatabaseInfrastructureError>
  readonly patchFolder: (
    id: LibraryFolderId,
    patch: PatchLibraryFolderInput,
  ) => Effect.Effect<
    Option.Option<LibraryFolder>,
    DatabaseInfrastructureError | InvalidLibraryFolder
  >
  readonly removeFolder: (
    id: LibraryFolderId,
  ) => Effect.Effect<'deleted' | 'not-found' | 'not-empty', DatabaseInfrastructureError>
  readonly getItem: (
    id: LibraryItemId,
  ) => Effect.Effect<Option.Option<LibraryItem>, DatabaseInfrastructureError>
  readonly getStoredItem: (
    id: LibraryItemId,
  ) => Effect.Effect<Option.Option<StoredLibraryItem>, DatabaseInfrastructureError>
  readonly getStoredItemByName: (
    name: string,
  ) => Effect.Effect<Option.Option<StoredLibraryItem>, DatabaseInfrastructureError>
  readonly getItemByDigest: (
    sha256: string,
  ) => Effect.Effect<Option.Option<LibraryItem>, DatabaseInfrastructureError>
  readonly createItem: (input: {
    readonly name: string
    readonly mimeType: string
    readonly bytes: Uint8Array
    readonly sha256: string
    readonly folderId: LibraryFolderId | null
  }) => Effect.Effect<LibraryItem, DatabaseInfrastructureError>
  readonly patchItem: (
    id: LibraryItemId,
    patch: PatchLibraryItemInput,
  ) => Effect.Effect<Option.Option<LibraryItem>, DatabaseInfrastructureError>
  readonly completeItem: (
    id: LibraryItemId,
    extractedText: string,
    chunks: ReadonlyArray<IndexedChunk>,
  ) => Effect.Effect<void, DatabaseInfrastructureError>
  readonly failItem: (
    id: LibraryItemId,
    message: string,
  ) => Effect.Effect<void, DatabaseInfrastructureError>
  readonly removeItem: (id: LibraryItemId) => Effect.Effect<boolean, DatabaseInfrastructureError>
  readonly search: (
    query: string,
    limit: number,
    folderId: Option.Option<LibraryFolderId>,
  ) => Effect.Effect<ReadonlyArray<LibrarySearchResult>, DatabaseInfrastructureError>
}

export class LibraryStore extends Context.Service<LibraryStore, LibraryStoreService>()(
  'vivid/LibraryStore',
) {}

const libraryItemSchemaDecoder = Schema.decodeUnknownEffect(LibraryItemSchema)
const folderRowResultDecoder = Schema.decodeUnknownResult(FolderRow)
const rawCountRowsDecoder = Schema.decodeUnknownEffect(RawCountRows)
const libraryFolderSchemaDecoder = Schema.decodeUnknownEffect(LibraryFolderSchema)

/** Decodes a document row and derives its chunk count for the metadata contract. */
const makeDecodeItem = (database: LibraryDatabase): DecodeItem =>
  Effect.fn('LibraryStore.decodeItem')(function* (row: LibraryDocumentRow) {
    const countRows = yield* database.run(
      database
        .select({ count: sql<number>`count(*)`.mapWith(Number) })
        .from(libraryChunks)
        .where(eq(libraryChunks.documentId, row.id)),
    )
    const countRow = yield* returned(countRows, 'Library item count')
    return yield* libraryItemSchemaDecoder({
      id: row.id,
      name: row.name,
      mimeType: row.mimeType,
      size: row.size,
      sha256: row.sha256,
      status: row.status,
      error: row.error,
      preview: row.extractedText.slice(0, 320),
      chunkCount: countRow.count,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      folderId: row.folderId,
    }).pipe(
      Effect.mapError(
        () => new DatabaseFailure({ message: 'Database returned an invalid Library item' }),
      ),
    )
  })

/** Decodes a folder row and derives the count of direct child records. */
const makeDecodeFolder = (database: LibraryDatabase): DecodeFolder =>
  Effect.fn('LibraryStore.decodeFolder')(function* (value: LibraryFolderRow) {
    const row = yield* Effect.fromResult(folderRowResultDecoder(value)).pipe(
      Effect.mapError(
        () => new DatabaseFailure({ message: 'Database returned an invalid Library folder' }),
      ),
    )
    const counts = yield* database.run(
      database.execute(sql`
        SELECT
          (SELECT count(*) FROM vivid_library_folders child WHERE child.parent_id = ${row.id}) +
          (SELECT count(*) FROM vivid_library_documents document WHERE document.folder_id = ${row.id}) AS count
      `),
    )
    const decodedCounts = yield* rawCountRowsDecoder(counts).pipe(
      Effect.mapError(
        () => new DatabaseFailure({ message: 'Database returned an invalid Library folder count' }),
      ),
    )
    const countRow = yield* returned(decodedCounts.rows, 'Library folder count')
    return yield* libraryFolderSchemaDecoder({
      ...row,
      itemCount: Number(countRow.count),
    }).pipe(
      Effect.mapError(
        () => new DatabaseFailure({ message: 'Database returned an invalid Library folder' }),
      ),
    )
  })

export const libraryStoreLayer = Layer.effect(
  LibraryStore,
  Effect.gen(function* () {
    const database = yield* Database
    const decodeItem = makeDecodeItem(database)
    const decodeFolder = makeDecodeFolder(database)
    const folders = folderOperations(database, decodeFolder)
    const items = itemOperations(database, decodeItem)
    const search = searchOperation(database)

    return LibraryStore.of({
      ...folders,
      ...items,
      search,
    })
  }),
)
