import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
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
    if (folderId !== undefined && Option.isNone(yield* store.getFolder(folderId)))
      return yield* Effect.fail(new NotFound({ message: 'Library folder not found' }))
    return LibraryListResponse.make({
      documents: yield* store.listItems(Option.fromNullishOr(folderId)),
      folders: yield* store.listChildFolders(folderId === undefined ? null : folderId),
    })
  }),
  GetLibraryItem: Effect.fn('Rpc.GetLibraryItem')(function* ({ id }) {
    const store = yield* LibraryStore
    const document = yield* store.getItem(id)
    if (Option.isNone(document))
      return yield* Effect.fail(new NotFound({ message: 'Library item not found' }))
    return LibraryItemResponse.make({ document: document.value })
  }),
  PatchLibraryItem: Effect.fn('Rpc.PatchLibraryItem')(function* ({ id, patch }) {
    const store = yield* LibraryStore
    if (
      patch.folderId !== undefined &&
      patch.folderId !== null &&
      Option.isNone(yield* store.getFolder(patch.folderId))
    )
      return yield* Effect.fail(new NotFound({ message: 'Library folder not found' }))
    const document = yield* store.patchItem(id, patch)
    if (Option.isNone(document))
      return yield* Effect.fail(new NotFound({ message: 'Library item not found' }))
    return LibraryItemResponse.make({ document: document.value })
  }),
  DeleteLibraryItem: Effect.fn('Rpc.DeleteLibraryItem')(function* ({ id }) {
    const store = yield* LibraryStore
    if (!(yield* store.removeItem(id)))
      return yield* Effect.fail(new NotFound({ message: 'Library item not found' }))
    return undefined
  }),
  SearchLibrary: Effect.fn('Rpc.SearchLibrary')(function* ({ query, folderId, limit }) {
    const store = yield* LibraryStore
    if (
      folderId !== undefined &&
      folderId !== null &&
      Option.isNone(yield* store.getFolder(folderId))
    )
      return yield* Effect.fail(new NotFound({ message: 'Library folder not found' }))
    return LibrarySearchResponse.make({
      results: yield* store.search(query, limit ?? 6, Option.fromNullishOr(folderId)),
    })
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
      Option.isNone(yield* store.getFolder(parentId))
    )
      return yield* Effect.fail(new NotFound({ message: 'Parent Library folder not found' }))
    return LibraryFolderResponse.make({
      folder: yield* store.createFolder(name, parentId === undefined ? null : parentId),
    })
  }),
  PatchLibraryFolder: Effect.fn('Rpc.PatchLibraryFolder')(function* ({ id, patch }) {
    const store = yield* LibraryStore
    if (
      patch.parentId !== undefined &&
      patch.parentId !== null &&
      Option.isNone(yield* store.getFolder(patch.parentId))
    )
      return yield* Effect.fail(new NotFound({ message: 'Parent Library folder not found' }))
    const folder = yield* store.patchFolder(id, patch).pipe(Effect.mapError(invalidRequest))
    if (Option.isNone(folder))
      return yield* Effect.fail(new NotFound({ message: 'Library folder not found' }))
    return LibraryFolderResponse.make({ folder: folder.value })
  }),
  DeleteLibraryFolder: Effect.fn('Rpc.DeleteLibraryFolder')(function* ({ id }) {
    const store = yield* LibraryStore
    const result = yield* store.removeFolder(id)
    if (result === 'not-found')
      return yield* Effect.fail(new NotFound({ message: 'Library folder not found' }))
    if (result === 'not-empty')
      return yield* Effect.fail(new Conflict({ message: 'Library folder is not empty' }))
    return undefined
  }),
}
