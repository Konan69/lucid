import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { Conflict, NotFound, type LibraryFolder, type LibraryFolderId } from '@vivid/contracts'
import type { Actor } from '../auth/access.ts'
import { returned } from '../database/client.ts'
import {
  readableScope,
  requireEditor,
  shelfCompany,
  shelfOf,
  shelfScope,
  shelfTopics,
} from './access.ts'
import {
  folderHasChildren,
  hierarchyWrite,
  requireAcyclic,
  requireFolderShelf,
} from './hierarchy.ts'
import type { DecodeFolder, LibraryDatabase, LibraryStoreService } from './store.ts'
import { libraryFolders } from './tables.ts'

/** Folder reads carry exactly the same shelf predicates as document reads. */
const folderReads = (database: LibraryDatabase, decodeFolder: DecodeFolder) => {
  /** Lists both readable shelves, preserving each row's derived shelf. */
  const listFolders = Effect.fn('LibraryStore.listFolders')(function* (actor: Actor) {
    const scope = yield* readableScope(database, libraryFolders, actor)
    const rows = yield* database.run(
      database
        .select()
        .from(libraryFolders)
        .where(scope)
        .orderBy(asc(sql`lower(${libraryFolders.name})`)),
    )
    return yield* Effect.forEach(rows, decodeFolder, { concurrency: 1 })
  })
  /** Browsing a shelf shows only direct children of the selected folder or root. */
  const listChildFolders: LibraryStoreService['listChildFolders'] = Effect.fn(
    'LibraryStore.listChildFolders',
  )(function* (actor, query) {
    const selected = yield* shelfScope(libraryFolders, actor, query.shelf)
    const readable = yield* readableScope(database, libraryFolders, actor)
    const scope = and(selected, readable)
    const parent =
      query.folderId === undefined
        ? isNull(libraryFolders.parentId)
        : eq(libraryFolders.parentId, query.folderId)
    const rows = yield* database.run(
      database
        .select()
        .from(libraryFolders)
        .where(and(scope, parent))
        .orderBy(asc(sql`lower(${libraryFolders.name})`)),
    )
    return yield* Effect.forEach(rows, decodeFolder, { concurrency: 1 })
  })
  /** No caller can probe a folder belonging to an unreadable shelf. */
  const getRow = Effect.fn('LibraryStore.getFolderRow')(function* (
    actor: Actor,
    id: LibraryFolderId,
  ) {
    const scope = yield* readableScope(database, libraryFolders, actor)
    const rows = yield* database.run(
      database
        .select()
        .from(libraryFolders)
        .where(and(eq(libraryFolders.id, id), scope))
        .limit(1),
    )
    return Option.fromUndefinedOr(rows[0])
  })
  /** Metadata lookup preserves absence until the RPC or destination check classifies it. */
  const getFolder = Effect.fn('LibraryStore.getFolder')(function* (
    actor: Actor,
    id: LibraryFolderId,
  ) {
    const row = yield* getRow(actor, id)
    return Option.isNone(row)
      ? Option.none<LibraryFolder>()
      : Option.some(yield* decodeFolder(row.value))
  })
  return { listFolders, listChildFolders, getFolder, getRow }
}

/** Hierarchy writes establish visibility, then author/admin authority, then same-shelf relations. */
export const folderOperations = (database: LibraryDatabase, decodeFolder: DecodeFolder) => {
  const reads = folderReads(database, decodeFolder)
  const requireDestination = requireFolderShelf((actor, id) => reads.getFolder(actor, id))
  const acyclic = requireAcyclic(database)
  const hasChildren = folderHasChildren(database)
  /** Every Member may add; personId records attribution, not Company read authority. */
  const createFolder: LibraryStoreService['createFolder'] = Effect.fn('LibraryStore.createFolder')(
    function* (actor, input) {
      const companyId = yield* shelfCompany(actor, input.shelf)
      yield* requireDestination(actor, input.parentId, input.shelf)
      const now = yield* Clock.currentTimeMillis
      const rows = yield* database.run(
        database
          .insert(libraryFolders)
          .values({
            id: crypto.randomUUID(),
            name: input.name,
            parentId: input.parentId,
            personId: actor.person.id,
            companyId,
            createdAt: now,
            updatedAt: now,
          })
          .returning(),
      )
      const row = yield* returned(rows, 'Library folder')
      return { value: yield* decodeFolder(row), moved: shelfTopics(row) }
    },
    (operation) => hierarchyWrite(database, operation),
  )
  /** Renames and moves are restricted to the contributor or an active Company admin. */
  const patchFolder: LibraryStoreService['patchFolder'] = Effect.fn('LibraryStore.patchFolder')(
    function* (actor, id, patch) {
      const scope = yield* readableScope(database, libraryFolders, actor)
      const current = yield* reads.getRow(actor, id)
      if (Option.isNone(current)) return { value: Option.none<LibraryFolder>(), moved: [] }
      yield* requireEditor(actor, current.value)
      const currentFolder = yield* decodeFolder(current.value)
      const parentId = patch.parentId === undefined ? currentFolder.parentId : patch.parentId
      yield* requireDestination(actor, parentId, shelfOf(current.value))
      yield* acyclic(actor, id, parentId)
      const now = yield* Clock.currentTimeMillis
      const rows = yield* database.run(
        database
          .update(libraryFolders)
          .set({
            name: patch.name === undefined ? current.value.name : patch.name,
            parentId,
            updatedAt: now,
          })
          .where(and(eq(libraryFolders.id, id), scope))
          .returning(),
      )
      const row = rows[0]
      return row === undefined
        ? { value: Option.none<LibraryFolder>(), moved: [] }
        : { value: Option.some(yield* decodeFolder(row)), moved: shelfTopics(row) }
    },
    (operation) => hierarchyWrite(database, operation),
  )
  /** A readable parent does not authorize deleting another contributor's descendants. */
  const removeFolder: LibraryStoreService['removeFolder'] = Effect.fn('LibraryStore.removeFolder')(
    function* (actor, id) {
      const scope = yield* readableScope(database, libraryFolders, actor)
      const row = yield* reads.getRow(actor, id)
      if (Option.isNone(row))
        return yield* Effect.fail(new NotFound({ message: 'Library folder not found' }))
      yield* requireEditor(actor, row.value)
      if (yield* hasChildren(actor, id))
        return yield* Effect.fail(new Conflict({ message: 'Library folder is not empty' }))
      const removed = yield* database.run(
        database
          .delete(libraryFolders)
          .where(and(eq(libraryFolders.id, id), scope))
          .returning({ personId: libraryFolders.personId, companyId: libraryFolders.companyId }),
      )
      const deleted = removed[0]
      return { value: undefined, moved: deleted === undefined ? [] : shelfTopics(deleted) }
    },
    (operation) => hierarchyWrite(database, operation),
  )
  return {
    listFolders: reads.listFolders,
    listChildFolders: reads.listChildFolders,
    getFolder: reads.getFolder,
    createFolder,
    patchFolder,
    removeFolder,
  }
}
