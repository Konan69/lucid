import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import { createInsertSchema, createSelectSchema } from 'drizzle-orm/effect-schema'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
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
import { Database, type DatabaseInfrastructureError, returned } from '../database/client.ts'
import { libraryChunks, libraryDocuments, libraryFolders } from './tables.ts'

export const LibraryDocumentRow = createSelectSchema(libraryDocuments)
export const LibraryDocumentInsert = createInsertSchema(libraryDocuments)
const FolderRow = createSelectSchema(libraryFolders)
export const LibraryChunkInsert = createInsertSchema(libraryChunks)
type LibrarySearchResult = typeof LibrarySearchResultSchema.Type
type PatchLibraryFolderInput = typeof PatchLibraryFolderRequest.Type
type PatchLibraryItemInput = typeof PatchLibraryItemRequest.Type
const RawCountRows = Schema.Struct({
  rows: Schema.Array(Schema.Struct({ count: Schema.Union([Schema.Number, Schema.String]) })),
})
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

export interface StoredLibraryItem extends LibraryItem {
  readonly bytes: Uint8Array
  readonly extractedText: string
}
export interface IndexedChunk {
  readonly page: number | null
  readonly text: string
}

export class InvalidLibraryFolder extends Schema.TaggedError<InvalidLibraryFolder>()(
  'InvalidLibraryFolder',
  { message: Schema.String },
) {}

const invalidRow = (subject: string) =>
  new DatabaseFailure({ message: `Database returned an invalid ${subject}` })

export interface LibraryStoreService {
  readonly listItems: (
    folderId: LibraryFolderId | null | undefined,
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
  ) => Effect.Effect<LibraryFolder | undefined, DatabaseInfrastructureError>
  readonly createFolder: (
    name: string,
    parentId: LibraryFolderId | null,
  ) => Effect.Effect<LibraryFolder, DatabaseInfrastructureError>
  readonly patchFolder: (
    id: LibraryFolderId,
    patch: PatchLibraryFolderInput,
  ) => Effect.Effect<LibraryFolder | undefined, DatabaseInfrastructureError | InvalidLibraryFolder>
  readonly removeFolder: (
    id: LibraryFolderId,
  ) => Effect.Effect<'deleted' | 'not-found' | 'not-empty', DatabaseInfrastructureError>
  readonly getItem: (
    id: LibraryItemId,
  ) => Effect.Effect<LibraryItem | undefined, DatabaseInfrastructureError>
  readonly getStoredItem: (
    id: LibraryItemId,
  ) => Effect.Effect<StoredLibraryItem | undefined, DatabaseInfrastructureError>
  readonly getStoredItemByName: (
    name: string,
  ) => Effect.Effect<StoredLibraryItem | undefined, DatabaseInfrastructureError>
  readonly getItemByDigest: (
    sha256: string,
  ) => Effect.Effect<LibraryItem | undefined, DatabaseInfrastructureError>
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
  ) => Effect.Effect<LibraryItem | undefined, DatabaseInfrastructureError>
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
    folderId: LibraryFolderId | null | undefined,
  ) => Effect.Effect<ReadonlyArray<LibrarySearchResult>, DatabaseInfrastructureError>
}

export class LibraryStore extends Context.Service<LibraryStore, LibraryStoreService>()(
  'vivid/LibraryStore',
) {}

const libraryItemSchemaDecoder = Schema.decodeUnknownEffect(LibraryItemSchema)
const folderRowResultDecoder = Schema.decodeUnknownResult(FolderRow)
const rawCountRowsDecoder = Schema.decodeUnknownEffect(RawCountRows)
const libraryFolderSchemaDecoder = Schema.decodeUnknownEffect(LibraryFolderSchema)
const rawSearchRowsDecoder = Schema.decodeUnknownEffect(RawSearchRows)
const librarySearchResultSchemaDecoder = Schema.decodeUnknownEffect(LibrarySearchResultSchema)

export const libraryStoreLayer = Layer.effect(
  LibraryStore,
  Effect.gen(function* () {
    const database = yield* Database

    const decodeItem = Effect.fn('LibraryStore.decodeItem')(function* (
      row: typeof libraryDocuments.$inferSelect,
    ) {
      const countRows = yield* database.run(
        database
          .select({ count: sql<number>`count(*)`.mapWith(Number) })
          .from(libraryChunks)
          .where(eq(libraryChunks.documentId, row.id)),
      )
      return yield* libraryItemSchemaDecoder({
        id: row.id,
        name: row.name,
        mimeType: row.mimeType,
        size: row.size,
        sha256: row.sha256,
        status: row.status,
        error: row.error,
        preview: row.extractedText.slice(0, 320),
        chunkCount: countRows[0]?.count ?? 0,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        folderId: row.folderId,
      }).pipe(Effect.mapError(() => invalidRow('Library item')))
    })

    const decodeFolder = Effect.fn('LibraryStore.decodeFolder')(function* (
      value: typeof libraryFolders.$inferSelect,
    ) {
      const row = yield* Effect.fromResult(folderRowResultDecoder(value)).pipe(
        Effect.mapError(() => invalidRow('Library folder')),
      )
      const counts = yield* database.run(
        database.execute(sql`
        SELECT
          (SELECT count(*) FROM vivid_library_folders child WHERE child.parent_id = ${row.id}) +
          (SELECT count(*) FROM vivid_library_documents document WHERE document.folder_id = ${row.id}) AS count
      `),
      )
      const decodedCounts = yield* rawCountRowsDecoder(counts).pipe(
        Effect.mapError(() => invalidRow('Library folder count')),
      )
      const count = Number(decodedCounts.rows[0]?.count ?? 0)
      return yield* libraryFolderSchemaDecoder({
        ...row,
        itemCount: count,
      }).pipe(Effect.mapError(() => invalidRow('Library folder')))
    })

    const listItems = Effect.fn('LibraryStore.listItems')(function* (
      folderId: LibraryFolderId | null | undefined,
    ) {
      const condition =
        folderId === undefined
          ? undefined
          : folderId === null
            ? isNull(libraryDocuments.folderId)
            : eq(libraryDocuments.folderId, folderId)
      const rows = yield* database.run(
        database
          .select()
          .from(libraryDocuments)
          .where(condition)
          .orderBy(desc(libraryDocuments.createdAt)),
      )
      return yield* Effect.forEach(rows, decodeItem, { concurrency: 1 })
    })

    const listFolders = Effect.fn('LibraryStore.listFolders')(function* () {
      const rows = yield* database.run(
        database
          .select()
          .from(libraryFolders)
          .orderBy(asc(sql`lower(${libraryFolders.name})`)),
      )
      return yield* Effect.forEach(rows, decodeFolder, { concurrency: 1 })
    })

    const listChildFolders = Effect.fn('LibraryStore.listChildFolders')(function* (
      parentId: LibraryFolderId | null,
    ) {
      const condition =
        parentId === null ? isNull(libraryFolders.parentId) : eq(libraryFolders.parentId, parentId)
      const rows = yield* database.run(
        database
          .select()
          .from(libraryFolders)
          .where(condition)
          .orderBy(asc(sql`lower(${libraryFolders.name})`)),
      )
      return yield* Effect.forEach(rows, decodeFolder, { concurrency: 1 })
    })

    const getFolder = Effect.fn('LibraryStore.getFolder')(function* (id: LibraryFolderId) {
      const rows = yield* database.run(
        database.select().from(libraryFolders).where(eq(libraryFolders.id, id)).limit(1),
      )
      return rows[0] === undefined ? undefined : yield* decodeFolder(rows[0])
    })

    const createFolder = Effect.fn('LibraryStore.createFolder')(function* (
      name: string,
      parentId: LibraryFolderId | null,
    ) {
      const now = yield* Clock.currentTimeMillis
      const rows = yield* database.run(
        database
          .insert(libraryFolders)
          .values({ id: crypto.randomUUID(), name, parentId, createdAt: now, updatedAt: now })
          .returning(),
      )
      return yield* decodeFolder(yield* returned(rows, 'Library folder'))
    })

    const patchFolder = Effect.fn('LibraryStore.patchFolder')(function* (
      id: LibraryFolderId,
      patch: PatchLibraryFolderInput,
    ) {
      const current = yield* getFolder(id)
      if (current === undefined) return undefined
      const parentId = patch.parentId === undefined ? current.parentId : patch.parentId
      if (parentId === id)
        return yield* Effect.fail(
          new InvalidLibraryFolder({ message: 'A folder cannot contain itself' }),
        )
      if (parentId !== null) {
        const rows = yield* database.run(
          database
            .select({ id: libraryFolders.id, parentId: libraryFolders.parentId })
            .from(libraryFolders),
        )
        const parentById = new Map(rows.map((folder) => [folder.id, folder.parentId]))
        let candidate: string | null = parentId
        while (candidate !== null) {
          if (candidate === id)
            return yield* Effect.fail(
              new InvalidLibraryFolder({
                message: 'A folder cannot move inside one of its descendants',
              }),
            )
          candidate = parentById.get(candidate) ?? null
        }
      }
      const now = yield* Clock.currentTimeMillis
      const rows = yield* database.run(
        database
          .update(libraryFolders)
          .set({ name: patch.name ?? current.name, parentId, updatedAt: now })
          .where(eq(libraryFolders.id, id))
          .returning(),
      )
      return rows[0] === undefined ? undefined : yield* decodeFolder(rows[0])
    })

    const removeFolder = Effect.fn('LibraryStore.removeFolder')(function* (id: LibraryFolderId) {
      const folder = yield* getFolder(id)
      if (folder === undefined) return 'not-found' as const
      const [children, documents] = yield* Effect.all([
        database.run(
          database
            .select({ id: libraryFolders.id })
            .from(libraryFolders)
            .where(eq(libraryFolders.parentId, id)),
        ),
        database.run(
          database
            .select({ id: libraryDocuments.id })
            .from(libraryDocuments)
            .where(eq(libraryDocuments.folderId, id)),
        ),
      ])
      if (children.length + documents.length > 0) return 'not-empty' as const
      yield* database.run(database.delete(libraryFolders).where(eq(libraryFolders.id, id)))
      return 'deleted' as const
    })

    const getRow = Effect.fn('LibraryStore.getRow')(function* (id: LibraryItemId) {
      const rows = yield* database.run(
        database.select().from(libraryDocuments).where(eq(libraryDocuments.id, id)).limit(1),
      )
      return rows[0]
    })

    const getItem = Effect.fn('LibraryStore.getItem')(function* (id: LibraryItemId) {
      const row = yield* getRow(id)
      return row === undefined ? undefined : yield* decodeItem(row)
    })

    const stored = Effect.fn('LibraryStore.stored')(function* (
      row: typeof libraryDocuments.$inferSelect,
    ) {
      const item = yield* decodeItem(row)
      return {
        ...item,
        bytes: new Uint8Array(row.bytes),
        extractedText: row.extractedText,
      } satisfies StoredLibraryItem
    })

    const getStoredItem = Effect.fn('LibraryStore.getStoredItem')(function* (id: LibraryItemId) {
      const row = yield* getRow(id)
      return row === undefined ? undefined : yield* stored(row)
    })

    const getStoredItemByName = Effect.fn('LibraryStore.getStoredItemByName')(function* (
      name: string,
    ) {
      const rows = yield* database.run(
        database
          .select()
          .from(libraryDocuments)
          .where(and(eq(libraryDocuments.name, name), eq(libraryDocuments.status, 'ready')))
          .orderBy(desc(libraryDocuments.updatedAt))
          .limit(1),
      )
      return rows[0] === undefined ? undefined : yield* stored(rows[0])
    })

    const getItemByDigest = Effect.fn('LibraryStore.getItemByDigest')(function* (sha256: string) {
      const rows = yield* database.run(
        database
          .select()
          .from(libraryDocuments)
          .where(eq(libraryDocuments.sha256, sha256))
          .limit(1),
      )
      return rows[0] === undefined ? undefined : yield* decodeItem(rows[0])
    })

    const createItem: LibraryStoreService['createItem'] = Effect.fn('LibraryStore.createItem')(
      function* (input) {
        const now = yield* Clock.currentTimeMillis
        const values = {
          id: crypto.randomUUID(),
          name: input.name,
          mimeType: input.mimeType,
          size: input.bytes.byteLength,
          sha256: input.sha256,
          status: 'processing' as const,
          bytes: Buffer.from(input.bytes),
          extractedText: '',
          error: null,
          createdAt: now,
          updatedAt: now,
          folderId: input.folderId,
        }
        const rows = yield* database.run(
          database.insert(libraryDocuments).values(values).returning(),
        )
        const row = rows[0]
        if (row === undefined) return yield* Effect.fail(invalidRow('Library item insert'))
        return yield* decodeItem(row)
      },
    )

    const patchItem = Effect.fn('LibraryStore.patchItem')(function* (
      id: LibraryItemId,
      patch: PatchLibraryItemInput,
    ) {
      const current = yield* getItem(id)
      if (current === undefined) return undefined
      const now = yield* Clock.currentTimeMillis
      const rows = yield* database.run(
        database
          .update(libraryDocuments)
          .set({
            name: patch.name ?? current.name,
            folderId: patch.folderId === undefined ? current.folderId : patch.folderId,
            updatedAt: now,
          })
          .where(eq(libraryDocuments.id, id))
          .returning(),
      )
      return rows[0] === undefined ? undefined : yield* decodeItem(rows[0])
    })

    const completeItem = Effect.fn('LibraryStore.completeItem')(function* (
      id: LibraryItemId,
      extractedText: string,
      chunks: ReadonlyArray<IndexedChunk>,
    ) {
      const now = yield* Clock.currentTimeMillis
      yield* database.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.delete(libraryChunks).where(eq(libraryChunks.documentId, id))
          yield* Effect.forEach(
            chunks,
            (chunk, ordinal) =>
              tx.insert(libraryChunks).values({
                id: crypto.randomUUID(),
                documentId: id,
                ordinal,
                page: chunk.page,
                text: chunk.text,
              }),
            { discard: true, concurrency: 1 },
          )
          yield* tx
            .update(libraryDocuments)
            .set({ status: 'ready', extractedText, error: null, updatedAt: now })
            .where(eq(libraryDocuments.id, id))
        }),
      )
    })

    const failItem = Effect.fn('LibraryStore.failItem')(function* (
      id: LibraryItemId,
      message: string,
    ) {
      const now = yield* Clock.currentTimeMillis
      yield* database.run(
        database
          .update(libraryDocuments)
          .set({ status: 'failed', error: message.slice(0, 1000), updatedAt: now })
          .where(eq(libraryDocuments.id, id)),
      )
    })

    const removeItem = Effect.fn('LibraryStore.removeItem')(function* (id: LibraryItemId) {
      const rows = yield* database.run(
        database
          .delete(libraryDocuments)
          .where(eq(libraryDocuments.id, id))
          .returning({ id: libraryDocuments.id }),
      )
      return rows.length > 0
    })

    const search = Effect.fn('LibraryStore.search')(function* (
      query: string,
      limit: number,
      folderId: LibraryFolderId | null | undefined,
    ) {
      const boundedLimit = Math.max(1, Math.min(limit, 10))
      const folderFilter =
        folderId === undefined || folderId === null
          ? sql``
          : sql`AND d.folder_id IN (SELECT id FROM folder_tree)`
      const result = yield* database.run(
        database.execute(sql`
        WITH RECURSIVE folder_tree(id) AS (
          SELECT ${folderId ?? null}::text UNION ALL SELECT f.id FROM vivid_library_folders f JOIN folder_tree tree ON f.parent_id = tree.id
        )
        SELECT c.id AS "chunkId", c.document_id AS "documentId", d.name AS filename, c.page, c.text,
          ts_rank_cd(c.search_vector, websearch_to_tsquery('simple', ${query})) AS score
        FROM vivid_library_chunks c JOIN vivid_library_documents d ON d.id = c.document_id
        WHERE d.status = 'ready' AND c.search_vector @@ websearch_to_tsquery('simple', ${query}) ${folderFilter}
        ORDER BY score DESC, c.ordinal ASC LIMIT ${boundedLimit}
      `),
      )
      const decoded = yield* rawSearchRowsDecoder(result).pipe(
        Effect.mapError(() => invalidRow('Library search rows')),
      )
      return yield* Effect.forEach(decoded.rows, (row) =>
        librarySearchResultSchemaDecoder({
          ...row,
          score: Number(Number(row.score).toFixed(4)),
        }).pipe(Effect.mapError(() => invalidRow('Library search result'))),
      )
    })

    return LibraryStore.of({
      listItems,
      listFolders,
      listChildFolders,
      getFolder,
      createFolder,
      patchFolder,
      removeFolder,
      getItem,
      getStoredItem,
      getStoredItemByName,
      getItemByDigest,
      createItem,
      patchItem,
      completeItem,
      failItem,
      removeItem,
      search,
    })
  }),
)
