import * as Effect from 'effect/Effect'
import {
  Conflict,
  LibraryFolderListResponse,
  LibraryFolderResponse,
  LibraryItemResponse,
  LibraryListResponse,
  LibrarySearchResponse,
  NotFound,
} from '@vivid/contracts'
import { invalidRequest } from '../rpc/failures.ts'
import { LibraryStore } from './store.ts'

export const libraryHandlers = {
  ListLibrary: Effect.fn('Rpc.ListLibrary')(function* ({ folderId }) {
    const store = yield* LibraryStore
    if (folderId !== undefined && (yield* store.getFolder(folderId)) === undefined)
      return yield* Effect.fail(new NotFound({ message: 'Library folder not found' }))
    return LibraryListResponse.make({
      documents: yield* store.listItems(folderId),
      folders: yield* store.listChildFolders(folderId ?? null),
    })
  }),
  GetLibraryItem: Effect.fn('Rpc.GetLibraryItem')(function* ({ id }) {
    const store = yield* LibraryStore
    const document = yield* store.getItem(id)
    if (document === undefined)
      return yield* Effect.fail(new NotFound({ message: 'Library item not found' }))
    return LibraryItemResponse.make({ document })
  }),
  PatchLibraryItem: Effect.fn('Rpc.PatchLibraryItem')(function* ({ id, patch }) {
    const store = yield* LibraryStore
    if (
      patch.folderId !== undefined &&
      patch.folderId !== null &&
      (yield* store.getFolder(patch.folderId)) === undefined
    )
      return yield* Effect.fail(new NotFound({ message: 'Library folder not found' }))
    const document = yield* store.patchItem(id, patch)
    if (document === undefined)
      return yield* Effect.fail(new NotFound({ message: 'Library item not found' }))
    return LibraryItemResponse.make({ document })
  }),
  DeleteLibraryItem: Effect.fn('Rpc.DeleteLibraryItem')(function* ({ id }) {
    const store = yield* LibraryStore
    if (!(yield* store.removeItem(id)))
      return yield* Effect.fail(new NotFound({ message: 'Library item not found' }))
  }),
  SearchLibrary: Effect.fn('Rpc.SearchLibrary')(function* ({ query, folderId, limit }) {
    const store = yield* LibraryStore
    if (
      folderId !== undefined &&
      folderId !== null &&
      (yield* store.getFolder(folderId)) === undefined
    )
      return yield* Effect.fail(new NotFound({ message: 'Library folder not found' }))
    return LibrarySearchResponse.make({ results: yield* store.search(query, limit ?? 6, folderId) })
  }),
  ListLibraryFolders: Effect.fn('Rpc.ListLibraryFolders')(function* () {
    const store = yield* LibraryStore
    return LibraryFolderListResponse.make({ folders: yield* store.listFolders() })
  }),
  CreateLibraryFolder: Effect.fn('Rpc.CreateLibraryFolder')(function* ({ name, parentId }) {
    const store = yield* LibraryStore
    if (
      parentId !== undefined &&
      parentId !== null &&
      (yield* store.getFolder(parentId)) === undefined
    )
      return yield* Effect.fail(new NotFound({ message: 'Parent Library folder not found' }))
    return LibraryFolderResponse.make({ folder: yield* store.createFolder(name, parentId ?? null) })
  }),
  PatchLibraryFolder: Effect.fn('Rpc.PatchLibraryFolder')(function* ({ id, patch }) {
    const store = yield* LibraryStore
    if (
      patch.parentId !== undefined &&
      patch.parentId !== null &&
      (yield* store.getFolder(patch.parentId)) === undefined
    )
      return yield* Effect.fail(new NotFound({ message: 'Parent Library folder not found' }))
    const folder = yield* store.patchFolder(id, patch).pipe(Effect.mapError(invalidRequest))
    if (folder === undefined)
      return yield* Effect.fail(new NotFound({ message: 'Library folder not found' }))
    return LibraryFolderResponse.make({ folder })
  }),
  DeleteLibraryFolder: Effect.fn('Rpc.DeleteLibraryFolder')(function* ({ id }) {
    const store = yield* LibraryStore
    const result = yield* store.removeFolder(id)
    if (result === 'not-found')
      return yield* Effect.fail(new NotFound({ message: 'Library folder not found' }))
    if (result === 'not-empty')
      return yield* Effect.fail(new Conflict({ message: 'Library folder is not empty' }))
  }),
}
