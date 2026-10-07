import { and, eq } from 'drizzle-orm'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import {
  DatabaseFailure,
  LibraryUploadResponse,
  NotFound,
  type LibraryItem,
  type LibraryItemId,
} from '@vivid/contracts'
import type { Actor } from '../auth/access.ts'
import { announce } from '../live/changes.ts'
import { readableScope, requireEditor, shelfCompany, shelfOf, shelfTopics } from './access.ts'
import { hierarchyWrite, requireFolderShelf } from './hierarchy.ts'
import type { DecodeItem, LibraryDatabase, LibraryStoreService } from './store.ts'
import { libraryDocuments } from './tables.ts'
import { LibraryIngestion, type libraryIngestion } from './ingestion.ts'

/** Mutation authority is checked only after the row has passed its SQL visibility predicate. */
const editorRow = (database: LibraryDatabase) =>
  Effect.fn('Library.editorRow')(function* (actor: Actor, id: LibraryItemId) {
    const scope = yield* readableScope(database, libraryDocuments, actor)
    const rows = yield* database.run(
      database
        .select()
        .from(libraryDocuments)
        .where(and(eq(libraryDocuments.id, id), scope))
        .limit(1),
    )
    const row = rows[0]
    if (row === undefined) return Option.none<typeof libraryDocuments.$inferSelect>()
    yield* requireEditor(actor, row)
    return Option.some(row)
  })

/**
 * A fresh insert, native offer and shelf notice share hierarchyWrite's transaction. The queue
 * captures the same SqlClient (rc.116 PQ:1297,1347-1353); a duplicate creates no new obligation.
 */
const createItemOperation = (
  database: LibraryDatabase,
  decodeItem: DecodeItem,
  dependencies: {
    readonly reads: Pick<LibraryStoreService, 'getItemByDigest'>
    readonly getFolder: LibraryStoreService['getFolder']
    readonly queue: Effect.Success<ReturnType<typeof libraryIngestion>>
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
      if (row !== undefined) {
        const document = yield* decodeItem(row)
        yield* dependencies.queue
          .offer(LibraryIngestion.make({ itemId: document.id }), { id: document.id })
          .pipe(
            Effect.mapError(
              () => new DatabaseFailure({ message: 'Library ingestion could not be recorded' }),
            ),
          )
        return {
          value: LibraryUploadResponse.make({ document, duplicate: false }),
          moved: shelfTopics(row),
        }
      }
      const existing = yield* dependencies.reads.getItemByDigest(actor, input.shelf, input.sha256)
      if (Option.isNone(existing))
        return yield* new NotFound({ message: 'Duplicate Library item no longer exists' })
      return {
        value: LibraryUploadResponse.make({ document: existing.value, duplicate: true }),
        moved: [],
      }
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
      const scope = yield* readableScope(database, libraryDocuments, actor)
      const current = yield* editable(actor, id)
      if (Option.isNone(current)) return { value: Option.none<LibraryItem>(), moved: [] }
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
          .where(and(eq(libraryDocuments.id, id), scope))
          .returning(),
      )
      const row = rows[0]
      return row === undefined
        ? { value: Option.none<LibraryItem>(), moved: [] }
        : { value: Option.some(yield* decodeItem(row)), moved: shelfTopics(row) }
    },
    (operation) => hierarchyWrite(database, operation),
  )
}

/** Deletion retains Actor visibility and stored-owner transactional announcement. */
const removalOperations = (database: LibraryDatabase): Pick<LibraryStoreService, 'removeItem'> => {
  const editable = editorRow(database)
  /**
   * An admin may delete Company files, while every Mine remains private to its owner. The editor
   * check and DELETE RETURNING share one transaction; its stored owners supply the commit notice.
   * live/changes.ts:111-126 announce uses this transaction's writing connection;
   * PgClient.ts:256-263 notify instead checks out a separate connection.
   */
  const removeItem: LibraryStoreService['removeItem'] = Effect.fn('LibraryStore.removeItem')(
    (actor, id) =>
      database.transaction((transaction) =>
        Effect.gen(function* () {
          const scope = yield* readableScope(database, libraryDocuments, actor)
          if (Option.isNone(yield* editable(actor, id))) return false
          const rows = yield* transaction
            .delete(libraryDocuments)
            .where(and(eq(libraryDocuments.id, id), scope))
            .returning({
              personId: libraryDocuments.personId,
              companyId: libraryDocuments.companyId,
            })
          const removed = rows[0]
          if (removed === undefined) return false
          yield* announce(transaction, shelfTopics(removed))
          return true
        }),
      ),
  )
  return { removeItem }
}

/** Item reads remain separate from author/admin mutation policy and transactional indexing. */
export const itemWrites = (
  database: LibraryDatabase,
  decodeItem: DecodeItem,
  dependencies: {
    readonly reads: Pick<LibraryStoreService, 'getItemByDigest'>
    readonly getFolder: LibraryStoreService['getFolder']
    readonly queue: Effect.Success<ReturnType<typeof libraryIngestion>>
  },
) => ({
  createItem: createItemOperation(database, decodeItem, dependencies),
  patchItem: patchItemOperation(database, decodeItem, dependencies.getFolder),
  ...removalOperations(database),
})
