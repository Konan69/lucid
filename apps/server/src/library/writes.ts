import { and, eq } from 'drizzle-orm'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import {
  LibraryUploadResponse,
  NotFound,
  type LibraryItem,
  type LibraryItemId,
} from '@vivid/contracts'
import type { Actor } from '../auth/access.ts'
import { readableScope, requireEditor, shelfCompany, shelfOf } from './access.ts'
import { hierarchyWrite, requireFolderShelf } from './hierarchy.ts'
import type { DecodeItem, IndexedChunk, LibraryDatabase, LibraryStoreService } from './store.ts'
import { libraryChunks, libraryDocuments } from './tables.ts'
import type { EffectPgQueryEffectHKT, EffectPgQueryResultHKT } from 'drizzle-orm/effect-postgres'
import type { PgEffectTransaction } from 'drizzle-orm/pg-core/effect/session'

type LibraryTransaction = PgEffectTransaction<EffectPgQueryEffectHKT, EffectPgQueryResultHKT>
interface CompletedItemInput {
  readonly transaction: LibraryTransaction
  readonly actor: Actor
  readonly id: LibraryItemId
  readonly extractedText: string
  readonly chunks: ReadonlyArray<IndexedChunk>
  readonly now: number
}

/** The parent row lock serializes competing index completions and deletion of this document. */
const writeCompletedItem = Effect.fn('Library.writeCompletedItem')(function* (
  input: CompletedItemInput,
) {
  const { transaction, actor, id, extractedText, chunks, now } = input
  const rows = yield* transaction
    .select()
    .from(libraryDocuments)
    .where(and(eq(libraryDocuments.id, id), readableScope(libraryDocuments, actor)))
    .for('update')
  const row = rows[0]
  if (row === undefined)
    return yield* Effect.fail(new NotFound({ message: 'Library item not found' }))
  yield* requireEditor(actor, row)
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
    .where(and(eq(libraryDocuments.id, id), readableScope(libraryDocuments, actor)))
  return undefined
})

/** Mutation authority is checked only after the row has passed its SQL visibility predicate. */
const editorRow = (database: LibraryDatabase) =>
  Effect.fn('Library.editorRow')(function* (actor: Actor, id: LibraryItemId) {
    const rows = yield* database.run(
      database
        .select()
        .from(libraryDocuments)
        .where(and(eq(libraryDocuments.id, id), readableScope(libraryDocuments, actor)))
        .limit(1),
    )
    const row = rows[0]
    if (row === undefined) return Option.none<typeof libraryDocuments.$inferSelect>()
    yield* requireEditor(actor, row)
    return Option.some(row)
  })

/** A conflict-free insert handles simultaneous uploads using the per-shelf unique indexes. */
const createItemOperation = (
  database: LibraryDatabase,
  decodeItem: DecodeItem,
  dependencies: {
    readonly reads: Pick<LibraryStoreService, 'getItemByDigest'>
    readonly getFolder: LibraryStoreService['getFolder']
  },
): LibraryStoreService['createItem'] => {
  const destination = requireFolderShelf(dependencies.getFolder)
  return Effect.fn('LibraryStore.createItem')(
    function* (actor, input) {
      const companyId = yield* shelfCompany(actor, input.shelf)
      yield* destination(actor, input.folderId, input.shelf)
      const now = yield* Clock.currentTimeMillis
      const rows = yield* database.run(
        database
          .insert(libraryDocuments)
          .values({
            id: crypto.randomUUID(),
            personId: actor.person.id,
            companyId,
            name: input.name,
            mimeType: input.mimeType,
            size: input.bytes.byteLength,
            sha256: input.sha256,
            status: 'processing',
            bytes: Buffer.from(input.bytes),
            extractedText: '',
            error: null,
            createdAt: now,
            updatedAt: now,
            folderId: input.folderId,
          })
          .onConflictDoNothing()
          .returning(),
      )
      const row = rows[0]
      if (row !== undefined)
        return LibraryUploadResponse.make({ document: yield* decodeItem(row), duplicate: false })
      const existing = yield* dependencies.reads.getItemByDigest(actor, input.shelf, input.sha256)
      if (Option.isNone(existing))
        return yield* Effect.fail(
          new NotFound({ message: 'Duplicate Library item no longer exists' }),
        )
      return LibraryUploadResponse.make({ document: existing.value, duplicate: true })
    },
    (operation) => hierarchyWrite(database, operation),
  )
}

/** Metadata writes preserve omitted patch fields and never permit a move between shelves. */
const patchItemOperation = (
  database: LibraryDatabase,
  decodeItem: DecodeItem,
  getFolder: LibraryStoreService['getFolder'],
): LibraryStoreService['patchItem'] => {
  const editable = editorRow(database)
  const destination = requireFolderShelf(getFolder)
  return Effect.fn('LibraryStore.patchItem')(
    function* (actor, id, patch) {
      const current = yield* editable(actor, id)
      if (Option.isNone(current)) return Option.none<LibraryItem>()
      const currentItem = yield* decodeItem(current.value)
      const folderId = patch.folderId === undefined ? currentItem.folderId : patch.folderId
      yield* destination(actor, folderId, shelfOf(current.value))
      const now = yield* Clock.currentTimeMillis
      const rows = yield* database.run(
        database
          .update(libraryDocuments)
          .set({
            name: patch.name === undefined ? current.value.name : patch.name,
            folderId,
            updatedAt: now,
          })
          .where(and(eq(libraryDocuments.id, id), readableScope(libraryDocuments, actor)))
          .returning(),
      )
      const row = rows[0]
      return row === undefined ? Option.none<LibraryItem>() : Option.some(yield* decodeItem(row))
    },
    (operation) => hierarchyWrite(database, operation),
  )
}

/** Each index state transition retains the initiating Actor's ownership scope. */
const indexOperations = (
  database: LibraryDatabase,
): Pick<LibraryStoreService, 'completeItem' | 'failItem' | 'removeItem'> => {
  const editable = editorRow(database)
  /** Chunks and ready metadata become visible in one transaction. */
  const completeItem: LibraryStoreService['completeItem'] = Effect.fn('LibraryStore.completeItem')(
    function* (actor, id, extractedText, chunks) {
      const now = yield* Clock.currentTimeMillis
      yield* database.transaction((transaction) =>
        writeCompletedItem({ transaction, actor, id, extractedText, chunks, now }),
      )
    },
  )
  /** Extraction failure is stored explicitly; a database outage remains a failed operation. */
  const failItem: LibraryStoreService['failItem'] = Effect.fn('LibraryStore.failItem')(
    function* (actor, id, message) {
      const row = yield* editable(actor, id)
      if (Option.isNone(row))
        return yield* Effect.fail(new NotFound({ message: 'Library item not found' }))
      const now = yield* Clock.currentTimeMillis
      yield* database.run(
        database
          .update(libraryDocuments)
          .set({ status: 'failed', error: message.slice(0, 1000), updatedAt: now })
          .where(and(eq(libraryDocuments.id, id), readableScope(libraryDocuments, actor))),
      )
      return undefined
    },
  )
  /** An admin may delete Company files, while every Mine remains private to its owner. */
  const removeItem: LibraryStoreService['removeItem'] = Effect.fn('LibraryStore.removeItem')(
    function* (actor, id) {
      if (Option.isNone(yield* editable(actor, id))) return false
      const rows = yield* database.run(
        database
          .delete(libraryDocuments)
          .where(and(eq(libraryDocuments.id, id), readableScope(libraryDocuments, actor)))
          .returning({ id: libraryDocuments.id }),
      )
      return rows.length > 0
    },
  )
  return { completeItem, failItem, removeItem }
}

/** Item reads remain separate from author/admin mutation policy and transactional indexing. */
export const itemWrites = (
  database: LibraryDatabase,
  decodeItem: DecodeItem,
  dependencies: {
    readonly reads: Pick<LibraryStoreService, 'getItemByDigest'>
    readonly getFolder: LibraryStoreService['getFolder']
  },
) => ({
  createItem: createItemOperation(database, decodeItem, dependencies),
  patchItem: patchItemOperation(database, decodeItem, dependencies.getFolder),
  ...indexOperations(database),
})
