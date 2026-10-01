import { and, eq, sql } from 'drizzle-orm'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { LibraryFolderId, NotFound, type LibraryShelf } from '@vivid/contracts'
import type { Actor } from '../auth/access.ts'
import { LibraryFolderCycle, LibraryFolderMismatch, readableScope } from './access.ts'
import type { LibraryDatabase, LibraryStoreService } from './store.ts'
import { libraryDocuments, libraryFolders } from './tables.ts'

/** A destination must be visible and on the source shelf; the root needs no relation. */
export const requireFolderShelf = (getFolder: LibraryStoreService['getFolder']) =>
  Effect.fn('Library.requireFolderShelf')(function* (
    actor: Actor,
    id: LibraryFolderId | null,
    shelf: LibraryShelf,
  ) {
    if (id === null) return undefined
    const folder = yield* getFolder(actor, id)
    if (Option.isNone(folder))
      return yield* Effect.fail(new NotFound({ message: 'Library folder not found' }))
    if (folder.value.shelf !== shelf)
      return yield* Effect.fail(new LibraryFolderMismatch({ folderId: id, shelf }))
    return undefined
  })

/** Parent traversal is limited to readable folders, and rejects cycles rather than hiding them. */
export const requireAcyclic = (database: LibraryDatabase) =>
  Effect.fn('Library.requireAcyclic')(function* (
    actor: Actor,
    id: LibraryFolderId,
    parentId: LibraryFolderId | null,
  ) {
    const rows = yield* database.run(
      database
        .select({ id: libraryFolders.id, parentId: libraryFolders.parentId })
        .from(libraryFolders)
        .where(readableScope(libraryFolders, actor)),
    )
    const parents = new Map(rows.map((row) => [row.id, row.parentId]))
    const visited = new Set<string>([id])
    let candidate: string | null = parentId
    while (candidate !== null) {
      if (visited.has(candidate))
        return yield* Effect.fail(new LibraryFolderCycle({ folderId: id }))
      visited.add(candidate)
      const next = parents.get(candidate)
      if (next === undefined)
        return yield* Effect.fail(new NotFound({ message: 'Library parent folder not found' }))
      candidate = next
    }
    return undefined
  })

/** Deletion never cascades through files or folders, even when the caller manages the parent. */
export const folderHasChildren = (database: LibraryDatabase) =>
  Effect.fn('Library.folderHasChildren')(function* (actor: Actor, id: LibraryFolderId) {
    const children = yield* database.run(
      database
        .select({ id: libraryFolders.id })
        .from(libraryFolders)
        .where(and(eq(libraryFolders.parentId, id), readableScope(libraryFolders, actor)))
        .limit(1),
    )
    const documents = yield* database.run(
      database
        .select({ id: libraryDocuments.id })
        .from(libraryDocuments)
        .where(and(eq(libraryDocuments.folderId, id), readableScope(libraryDocuments, actor)))
        .limit(1),
    )
    return children.length + documents.length > 0
  })

/**
 * The document folder column has no foreign key. Serialize hierarchy checks with folder deletes
 * so an upload/move cannot leave a dangling destination, and concurrent moves cannot form a cycle.
 * Drizzle rc.5 uses PgClient.withTransaction: all queries on this captured client reuse that
 * transaction's connection, including decoder queries (effect-postgres/session.js).
 */
export const hierarchyWrite = <A, E, R>(
  database: LibraryDatabase,
  operation: Effect.Effect<A, E, R>,
) =>
  database.transaction((transaction) =>
    Effect.gen(function* () {
      yield* transaction.execute(sql`LOCK TABLE vivid_library_folders IN SHARE ROW EXCLUSIVE MODE`)
      return yield* operation
    }),
  )
