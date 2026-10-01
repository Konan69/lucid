import { and, desc, eq } from 'drizzle-orm'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import type { LibraryItem, LibraryItemId } from '@vivid/contracts'
import type {
  DecodeItem,
  LibraryDatabase,
  LibraryStoreService,
  StoredLibraryItem,
} from './store.ts'
import { libraryDocuments } from './tables.ts'
import { readableScope, shelfScope } from './access.ts'
import type { Actor } from '../auth/access.ts'

/** Builds item reads, keeping absence explicit at the store boundary. */
export const itemReads = (
  database: LibraryDatabase,
  decodeItem: DecodeItem,
): Pick<
  LibraryStoreService,
  'listItems' | 'getItem' | 'getStoredItem' | 'getStoredItemByName' | 'getItemByDigest'
> => {
  /** Selected-shelf filtering happens before rows leave PostgreSQL. */
  const listItems: LibraryStoreService['listItems'] = Effect.fn('LibraryStore.listItems')(
    function* (actor, query) {
      const selected = yield* shelfScope(libraryDocuments, actor, query.shelf)
      const readable = yield* readableScope(database, libraryDocuments, actor)
      const scope = and(selected, readable)
      const folder =
        query.folderId === undefined ? undefined : eq(libraryDocuments.folderId, query.folderId)
      const rows = yield* database.run(
        database
          .select()
          .from(libraryDocuments)
          .where(and(scope, folder))
          .orderBy(desc(libraryDocuments.createdAt)),
      )
      return yield* Effect.forEach(rows, decodeItem, { concurrency: 1 })
    },
  )

  /** Every id lookup is scoped before returning either metadata or bytes. */
  const getRow = Effect.fn('LibraryStore.getRow')(function* (actor: Actor, id: LibraryItemId) {
    const scope = yield* readableScope(database, libraryDocuments, actor)
    const rows = yield* database.run(
      database
        .select()
        .from(libraryDocuments)
        .where(and(eq(libraryDocuments.id, id), scope))
        .limit(1),
    )
    return Option.fromNullishOr(rows[0])
  })

  /** Absence remains explicit so every transport reports hidden and missing rows identically. */
  const getItem = Effect.fn('LibraryStore.getItem')(function* (actor: Actor, id: LibraryItemId) {
    const row = yield* getRow(actor, id)
    if (Option.isNone(row)) return Option.none<LibraryItem>()
    return Option.some(yield* decodeItem(row.value))
  })

  /** Bytes extend decoded public metadata only after the parent has passed its shelf check. */
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
      shelf: item.shelf,
      bytes: new Uint8Array(row.bytes),
      extractedText: row.extractedText,
    } satisfies StoredLibraryItem
  })

  /** Downloads and ingestion share the id lookup's ownership predicate. */
  const getStoredItem = Effect.fn('LibraryStore.getStoredItem')(function* (
    actor: Actor,
    id: LibraryItemId,
  ) {
    const row = yield* getRow(actor, id)
    if (Option.isNone(row)) return Option.none<StoredLibraryItem>()
    return Option.some(yield* stored(row.value))
  })

  /** Legacy source-name requests select the newest readable ready file, never a global match. */
  const getStoredItemByName = Effect.fn('LibraryStore.getStoredItemByName')(function* (
    actor: Actor,
    name: string,
  ) {
    const scope = yield* readableScope(database, libraryDocuments, actor)
    const rows = yield* database.run(
      database
        .select()
        .from(libraryDocuments)
        .where(and(eq(libraryDocuments.name, name), eq(libraryDocuments.status, 'ready'), scope))
        .orderBy(desc(libraryDocuments.updatedAt))
        .limit(1),
    )
    const row = rows[0]
    if (row === undefined) return Option.none<StoredLibraryItem>()
    return Option.some(yield* stored(row))
  })

  /** Deduplication covers the requested shelf alone, preserving independent Mine/Company copies. */
  const getItemByDigest: LibraryStoreService['getItemByDigest'] = Effect.fn(
    'LibraryStore.getItemByDigest',
  )(function* (actor, shelf, sha256) {
    const selected = yield* shelfScope(libraryDocuments, actor, shelf)
    const readable = yield* readableScope(database, libraryDocuments, actor)
    const scope = and(selected, readable)
    const rows = yield* database.run(
      database
        .select()
        .from(libraryDocuments)
        .where(and(eq(libraryDocuments.sha256, sha256), scope))
        .limit(1),
    )
    const row = rows[0]
    if (row === undefined) return Option.none<LibraryItem>()
    return Option.some(yield* decodeItem(row))
  })

  return { listItems, getItem, getStoredItem, getStoredItemByName, getItemByDigest }
}
