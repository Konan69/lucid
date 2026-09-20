import { asc, eq, isNull, sql } from 'drizzle-orm'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { type LibraryFolder, type LibraryFolderId } from '@vivid/contracts'
import { returned } from '../database/client.ts'
import type {
  DecodeFolder,
  LibraryDatabase,
  LibraryStoreService,
  PatchLibraryFolderInput,
} from './store.ts'
import { libraryDocuments, libraryFolders } from './tables.ts'

export class InvalidLibraryFolder extends Schema.TaggedError<InvalidLibraryFolder>()(
  'InvalidLibraryFolder',
  { message: Schema.String },
  { title: 'Invalid Library folder' },
) {}

/** Builds persistence operations that own Library folder hierarchy rules. */
export const folderOperations = (
  database: LibraryDatabase,
  decodeFolder: DecodeFolder,
): Pick<
  LibraryStoreService,
  'listFolders' | 'listChildFolders' | 'getFolder' | 'createFolder' | 'patchFolder' | 'removeFolder'
> => {
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
    const row = rows[0]
    if (row === undefined) return Option.none<LibraryFolder>()
    return Option.some(yield* decodeFolder(row))
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
    if (Option.isNone(current)) return Option.none<LibraryFolder>()
    const parentId = patch.parentId === undefined ? current.value.parentId : patch.parentId
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
        const next = parentById.get(candidate)
        candidate = next === undefined ? null : next
      }
    }
    const now = yield* Clock.currentTimeMillis
    const rows = yield* database.run(
      database
        .update(libraryFolders)
        .set({ name: patch.name ?? current.value.name, parentId, updatedAt: now })
        .where(eq(libraryFolders.id, id))
        .returning(),
    )
    const row = rows[0]
    if (row === undefined) return Option.none<LibraryFolder>()
    return Option.some(yield* decodeFolder(row))
  })

  const removeFolder = Effect.fn('LibraryStore.removeFolder')(function* (id: LibraryFolderId) {
    const folder = yield* getFolder(id)
    if (Option.isNone(folder)) return 'not-found' as const
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

  return { listFolders, listChildFolders, getFolder, createFolder, patchFolder, removeFolder }
}
