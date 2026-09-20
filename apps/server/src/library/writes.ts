import { eq } from 'drizzle-orm'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import type { LibraryItem, LibraryItemId } from '@vivid/contracts'
import { returned } from '../database/client.ts'
import type {
  DecodeItem,
  IndexedChunk,
  LibraryDatabase,
  LibraryStoreService,
  PatchLibraryItemInput,
} from './store.ts'
import { libraryChunks, libraryDocuments } from './tables.ts'
import type { EffectPgQueryEffectHKT, EffectPgQueryResultHKT } from 'drizzle-orm/effect-postgres'
import type { PgEffectTransaction } from 'drizzle-orm/pg-core/effect/session'

type LibraryTransaction = PgEffectTransaction<EffectPgQueryEffectHKT, EffectPgQueryResultHKT>

interface CompletedItemInput {
  readonly transaction: LibraryTransaction
  readonly id: LibraryItemId
  readonly extractedText: string
  readonly chunks: ReadonlyArray<IndexedChunk>
  readonly now: number
}

/** Writes chunks and the ready state together so search never sees a partial index. */
const writeCompletedItem = ({ transaction, id, extractedText, chunks, now }: CompletedItemInput) =>
  Effect.gen(function* () {
    yield* transaction.delete(libraryChunks).where(eq(libraryChunks.documentId, id))
    yield* Effect.forEach(
      chunks,
      (chunk, ordinal) =>
        transaction.insert(libraryChunks).values({
          id: crypto.randomUUID(),
          documentId: id,
          ordinal,
          page: chunk.page,
          text: chunk.text,
        }),
      { discard: true, concurrency: 1 },
    )
    yield* transaction
      .update(libraryDocuments)
      .set({ status: 'ready', extractedText, error: null, updatedAt: now })
      .where(eq(libraryDocuments.id, id))
  })

/** Creates the insert operation for a new uploaded item. */
const createItemOperation = (
  database: LibraryDatabase,
  decodeItem: DecodeItem,
): LibraryStoreService['createItem'] =>
  Effect.fn('LibraryStore.createItem')(function* (input) {
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
    const rows = yield* database.run(database.insert(libraryDocuments).values(values).returning())
    return yield* decodeItem(yield* returned(rows, 'Library item insert'))
  })

/** Creates the metadata patch operation while preserving missing-item absence. */
const patchItemOperation = (
  database: LibraryDatabase,
  decodeItem: DecodeItem,
  getItem: LibraryStoreService['getItem'],
): LibraryStoreService['patchItem'] =>
  Effect.fn('LibraryStore.patchItem')(function* (id: LibraryItemId, patch: PatchLibraryItemInput) {
    const current = yield* getItem(id)
    if (Option.isNone(current)) return Option.none<LibraryItem>()
    const now = yield* Clock.currentTimeMillis
    const rows = yield* database.run(
      database
        .update(libraryDocuments)
        .set({
          name: patch.name ?? current.value.name,
          folderId: patch.folderId === undefined ? current.value.folderId : patch.folderId,
          updatedAt: now,
        })
        .where(eq(libraryDocuments.id, id))
        .returning(),
    )
    const row = rows[0]
    if (row === undefined) return Option.none<LibraryItem>()
    return Option.some(yield* decodeItem(row))
  })

/** Creates the transactional index completion operation. */
const completeItemOperation = (database: LibraryDatabase): LibraryStoreService['completeItem'] =>
  Effect.fn('LibraryStore.completeItem')(function* (
    id: LibraryItemId,
    extractedText: string,
    chunks: ReadonlyArray<IndexedChunk>,
  ) {
    const now = yield* Clock.currentTimeMillis
    yield* database.transaction((transaction) =>
      writeCompletedItem({ transaction, id, extractedText, chunks, now }),
    )
  })

/** Creates the failure-state operation used when extraction cannot complete. */
const failItemOperation = (database: LibraryDatabase): LibraryStoreService['failItem'] =>
  Effect.fn('LibraryStore.failItem')(function* (id: LibraryItemId, message: string) {
    const now = yield* Clock.currentTimeMillis
    yield* database.run(
      database
        .update(libraryDocuments)
        .set({ status: 'failed', error: message.slice(0, 1000), updatedAt: now })
        .where(eq(libraryDocuments.id, id)),
    )
  })

/** Creates the delete operation and reports whether a row was actually removed. */
const removeItemOperation = (database: LibraryDatabase): LibraryStoreService['removeItem'] =>
  Effect.fn('LibraryStore.removeItem')(function* (id: LibraryItemId) {
    const rows = yield* database.run(
      database
        .delete(libraryDocuments)
        .where(eq(libraryDocuments.id, id))
        .returning({ id: libraryDocuments.id }),
    )
    return rows.length > 0
  })

/** Builds item writes separately from reads so each operation has one persistence concern. */
export const itemWrites = (
  database: LibraryDatabase,
  decodeItem: DecodeItem,
  getItem: LibraryStoreService['getItem'],
): Pick<
  LibraryStoreService,
  'createItem' | 'patchItem' | 'completeItem' | 'failItem' | 'removeItem'
> => ({
  createItem: createItemOperation(database, decodeItem),
  patchItem: patchItemOperation(database, decodeItem, getItem),
  completeItem: completeItemOperation(database),
  failItem: failItemOperation(database),
  removeItem: removeItemOperation(database),
})
