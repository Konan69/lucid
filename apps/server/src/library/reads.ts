import { and, desc, eq } from 'drizzle-orm'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import type { LibraryFolderId, LibraryItem, LibraryItemId } from '@vivid/contracts'
import type {
  DecodeItem,
  LibraryDatabase,
  LibraryStoreService,
  StoredLibraryItem,
} from './store.ts'
import { libraryDocuments } from './tables.ts'

/** Builds item reads, keeping absence explicit at the store boundary. */
export const itemReads = (
  database: LibraryDatabase,
  decodeItem: DecodeItem,
): Pick<
  LibraryStoreService,
  'listItems' | 'getItem' | 'getStoredItem' | 'getStoredItemByName' | 'getItemByDigest'
> => {
  const listItems = Effect.fn('LibraryStore.listItems')(function* (
    folderId: Option.Option<LibraryFolderId>,
  ) {
    const rows = yield* Option.match(folderId, {
      onNone: () =>
        database.run(
          database.select().from(libraryDocuments).orderBy(desc(libraryDocuments.createdAt)),
        ),
      onSome: (id) =>
        database.run(
          database
            .select()
            .from(libraryDocuments)
            .where(eq(libraryDocuments.folderId, id))
            .orderBy(desc(libraryDocuments.createdAt)),
        ),
    })
    return yield* Effect.forEach(rows, decodeItem, { concurrency: 1 })
  })

  const getRow = Effect.fn('LibraryStore.getRow')(function* (id: LibraryItemId) {
    const rows = yield* database.run(
      database.select().from(libraryDocuments).where(eq(libraryDocuments.id, id)).limit(1),
    )
    return Option.fromNullishOr(rows[0])
  })

  const getItem = Effect.fn('LibraryStore.getItem')(function* (id: LibraryItemId) {
    const row = yield* getRow(id)
    if (Option.isNone(row)) return Option.none<LibraryItem>()
    return Option.some(yield* decodeItem(row.value))
  })

  const stored = Effect.fn('LibraryStore.stored')(function* (
    row: typeof libraryDocuments.$inferSelect,
  ) {
    const item = yield* decodeItem(row)
    return {
      id: item.id,
      name: item.name,
      mimeType: item.mimeType,
      size: item.size,
      sha256: item.sha256,
      status: item.status,
      error: item.error,
      preview: item.preview,
      chunkCount: item.chunkCount,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      folderId: item.folderId,
      bytes: new Uint8Array(row.bytes),
      extractedText: row.extractedText,
    } satisfies StoredLibraryItem
  })

  const getStoredItem = Effect.fn('LibraryStore.getStoredItem')(function* (id: LibraryItemId) {
    const row = yield* getRow(id)
    if (Option.isNone(row)) return Option.none<StoredLibraryItem>()
    return Option.some(yield* stored(row.value))
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
    const row = rows[0]
    if (row === undefined) return Option.none<StoredLibraryItem>()
    return Option.some(yield* stored(row))
  })

  const getItemByDigest = Effect.fn('LibraryStore.getItemByDigest')(function* (sha256: string) {
    const rows = yield* database.run(
      database.select().from(libraryDocuments).where(eq(libraryDocuments.sha256, sha256)).limit(1),
    )
    const row = rows[0]
    if (row === undefined) return Option.none<LibraryItem>()
    return Option.some(yield* decodeItem(row))
  })

  return { listItems, getItem, getStoredItem, getStoredItemByName, getItemByDigest }
}
