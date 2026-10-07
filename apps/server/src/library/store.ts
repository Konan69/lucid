import { eq, sql } from 'drizzle-orm'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import {
  DatabaseFailure,
  CompanyId,
  PersonId,
  LibraryFolder as LibraryFolderSchema,
  type LibraryFolder,
  type LibraryFolderId,
  LibraryItem as LibraryItemSchema,
  type LibraryItem,
  type LibraryItemId,
  LibrarySearchResult as LibrarySearchResultSchema,
  PatchLibraryFolderRequest,
  PatchLibraryItemRequest,
  LibraryListQuery,
  LibraryListResponse,
  LibraryUploadMetadata,
  LibraryUploadResponse,
  NotFound,
  Conflict,
  InvalidRequest,
} from '@vivid/contracts'
import { createInsertSchema, createSelectSchema } from 'drizzle-orm/effect-schema'
import { Database, type DatabaseInfrastructureError, returned } from '../database/client.ts'
import { folderOperations } from './folders.ts'
import {
  LibraryFolderMismatch,
  shelfOf,
  type LibraryShelfUnavailable,
  type LibraryMutationDenied,
  type LibraryFolderCycle,
} from './access.ts'
import type { Actor } from '../auth/access.ts'
import { ingestionBackoff, libraryIngestion } from './ingestion.ts'
import { itemOperations } from './items.ts'
import { searchOperation } from './search.ts'
import { libraryChunks, libraryDocuments, libraryFolders } from './tables.ts'

export type LibraryFailure =
  | DatabaseInfrastructureError
  | LibraryShelfUnavailable
  | LibraryMutationDenied
  | LibraryFolderMismatch
  | LibraryFolderCycle
  | NotFound
  | Conflict
  | InvalidRequest

export const LibraryDocumentRow = createSelectSchema(libraryDocuments)
export const LibraryDocumentInsert = createInsertSchema(libraryDocuments)
// Drizzle's generated scalar schemas erase $type brands; restore and validate stored ownership.
const FolderRow = createSelectSchema(libraryFolders, {
  personId: PersonId,
  companyId: Schema.NullOr(CompanyId),
})
export const LibraryChunkInsert = createInsertSchema(libraryChunks)
type LibrarySearchResult = typeof LibrarySearchResultSchema.Type
export type PatchLibraryFolderInput = typeof PatchLibraryFolderRequest.Type
export type PatchLibraryItemInput = typeof PatchLibraryItemRequest.Type

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

/** Store operations always carry the Actor; ownership cannot be omitted by a new caller. */
export interface LibraryStoreService {
  readonly list: (
    actor: Actor,
    query: typeof LibraryListQuery.Type,
  ) => Effect.Effect<typeof LibraryListResponse.Type, LibraryFailure>
  readonly listItems: (
    actor: Actor,
    query: typeof LibraryListQuery.Type,
  ) => Effect.Effect<ReadonlyArray<LibraryItem>, LibraryFailure>
  readonly listFolders: (
    actor: Actor,
  ) => Effect.Effect<ReadonlyArray<LibraryFolder>, LibraryFailure>
  readonly listChildFolders: (
    actor: Actor,
    query: typeof LibraryListQuery.Type,
  ) => Effect.Effect<ReadonlyArray<LibraryFolder>, LibraryFailure>
  readonly getFolder: (
    actor: Actor,
    id: LibraryFolderId,
  ) => Effect.Effect<Option.Option<LibraryFolder>, LibraryFailure>
  readonly createFolder: (
    actor: Actor,
    input: {
      readonly name: string
      readonly shelf: LibraryItem['shelf']
      readonly parentId: LibraryFolderId | null
    },
  ) => Effect.Effect<LibraryFolder, LibraryFailure>
  readonly patchFolder: (
    actor: Actor,
    id: LibraryFolderId,
    patch: PatchLibraryFolderInput,
  ) => Effect.Effect<Option.Option<LibraryFolder>, LibraryFailure>
  readonly removeFolder: (actor: Actor, id: LibraryFolderId) => Effect.Effect<void, LibraryFailure>
  readonly getItem: (
    actor: Actor,
    id: LibraryItemId,
  ) => Effect.Effect<Option.Option<LibraryItem>, LibraryFailure>
  readonly getStoredItem: (
    actor: Actor,
    id: LibraryItemId,
  ) => Effect.Effect<Option.Option<StoredLibraryItem>, LibraryFailure>
  readonly getStoredItemByName: (
    actor: Actor,
    name: string,
  ) => Effect.Effect<Option.Option<StoredLibraryItem>, LibraryFailure>
  readonly getItemByDigest: (
    actor: Actor,
    shelf: LibraryItem['shelf'],
    sha256: string,
  ) => Effect.Effect<Option.Option<LibraryItem>, LibraryFailure>
  readonly createItem: (
    actor: Actor,
    input: typeof LibraryUploadMetadata.Type & {
      readonly bytes: Uint8Array
      readonly sha256: string
    },
  ) => Effect.Effect<typeof LibraryUploadResponse.Type, LibraryFailure>
  readonly patchItem: (
    actor: Actor,
    id: LibraryItemId,
    patch: PatchLibraryItemInput,
  ) => Effect.Effect<Option.Option<LibraryItem>, LibraryFailure>
  readonly removeItem: (actor: Actor, id: LibraryItemId) => Effect.Effect<boolean, LibraryFailure>
  readonly search: (
    actor: Actor,
    input: {
      readonly query: string
      readonly limit: number
      readonly folderId: Option.Option<LibraryFolderId>
    },
  ) => Effect.Effect<ReadonlyArray<LibrarySearchResult>, LibraryFailure>
}

export class LibraryStore extends Context.Service<LibraryStore, LibraryStoreService>()(
  'vivid/LibraryStore',
) {}

const libraryItemSchemaDecoder = Schema.decodeUnknownEffect(LibraryItemSchema)
const folderRowResultDecoder = Schema.decodeUnknownResult(FolderRow)
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
      shelf: shelfOf(row),
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
      database
        .select({
          count: sql<number>`
        (SELECT count(*) FROM vivid_library_folders child WHERE child.parent_id = ${row.id}) +
        (SELECT count(*) FROM vivid_library_documents document WHERE document.folder_id = ${row.id})
      `.mapWith(Number),
        })
        .from(libraryFolders)
        .where(eq(libraryFolders.id, row.id)),
    )
    const countRow = yield* returned(counts, 'Library folder count')
    return yield* libraryFolderSchemaDecoder({
      ...row,
      itemCount: countRow.count,
      shelf: shelfOf(row),
    }).pipe(
      Effect.mapError(
        () => new DatabaseFailure({ message: 'Database returned an invalid Library folder' }),
      ),
    )
  })

/** Acquires the database once; exported operations close over one shelf authority boundary. */
export const libraryStoreLayer = Layer.effect(
  LibraryStore,
  Effect.gen(function* () {
    const database = yield* Database
    const decodeItem = makeDecodeItem(database)
    const decodeFolder = makeDecodeFolder(database)
    const folders = folderOperations(database, decodeFolder)
    const queue = yield* libraryIngestion(ingestionBackoff)
    const items = itemOperations(database, decodeItem, folders.getFolder, queue)
    const search = searchOperation(database)

    /** List and Watch share this loader, including selected folder visibility and shelf validation. */
    const list: LibraryStoreService['list'] = Effect.fn('LibraryStore.list')(
      function* (actor, query) {
        if (query.folderId !== undefined) {
          const folder = yield* folders.getFolder(actor, query.folderId)
          if (Option.isNone(folder))
            return yield* new NotFound({ message: 'Library folder not found' })
          if (folder.value.shelf !== query.shelf)
            return yield* new LibraryFolderMismatch({
              folderId: query.folderId,
              shelf: query.shelf,
            })
        }
        return LibraryListResponse.make({
          documents: yield* items.listItems(actor, query),
          folders: yield* folders.listChildFolders(actor, query),
        })
      },
    )
    return LibraryStore.of({
      list,
      ...folders,
      ...items,
      search,
    })
  }),
)
