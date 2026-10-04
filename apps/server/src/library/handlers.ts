import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import {
  CreateLibraryFolderRequest,
  LibraryFolderListResponse,
  LibraryFolderResponse,
  LibraryItemResponse,
  LibraryListQuery,
  LibrarySearchRequest,
  LibrarySearchResponse,
  NotFound,
  PatchLibraryFolderRequest,
  PatchLibraryItemRequest,
  type LibraryFolderId,
  type LibraryItemId,
} from '@vivid/contracts'
import { requireActor, type Actor } from '../auth/access.ts'
import { live } from '../live/query.ts'
import { libraryFailure } from './failures.ts'
import { LibraryStore } from './store.ts'

/** The live and plain calls use one loader, including folder and selected-shelf validation. */
const loadLibrary = Effect.fn('Library.load')(function* (
  actor: Actor,
  query: typeof LibraryListQuery.Type,
) {
  return yield* (yield* LibraryStore).list(actor, query).pipe(Effect.mapError(libraryFailure))
})

export const libraryHandlers = {
  /** Actor resolution is identical for a Person and Vivid's tools. */
  ListLibrary: Effect.fn('Rpc.ListLibrary')(function* (query: typeof LibraryListQuery.Type) {
    return yield* loadLibrary(yield* requireActor(), query)
  }),
  /** Workspace switches and ownership changes rerun the same shelf loader. */
  WatchLibrary: (query: typeof LibraryListQuery.Type) => live((actor) => loadLibrary(actor, query)),
  /** Unreadable ids and absent ids produce the same response. */
  GetLibraryItem: Effect.fn('Rpc.GetLibraryItem')(function* ({
    id,
  }: {
    readonly id: LibraryItemId
  }) {
    const document = yield* (yield* LibraryStore)
      .getItem(yield* requireActor(), id)
      .pipe(Effect.mapError(libraryFailure))
    if (Option.isNone(document))
      return yield* Effect.fail(new NotFound({ message: 'Library item not found' }))
    return LibraryItemResponse.make({ document: document.value })
  }),
  /** Only successful mutations publish; the store owns shelf and contributor policy. */
  PatchLibraryItem: Effect.fn('Rpc.PatchLibraryItem')(function* ({
    id,
    patch,
  }: {
    readonly id: LibraryItemId
    readonly patch: typeof PatchLibraryItemRequest.Type
  }) {
    const actor = yield* requireActor()
    const document = yield* (yield* LibraryStore)
      .patchItem(actor, id, patch)
      .pipe(Effect.mapError(libraryFailure))
    if (Option.isNone(document))
      return yield* Effect.fail(new NotFound({ message: 'Library item not found' }))
    return LibraryItemResponse.make({ document: document.value })
  }),
  /** Deleting metadata also deletes its indexed chunks through the database relation. */
  DeleteLibraryItem: Effect.fn('Rpc.DeleteLibraryItem')(function* ({
    id,
  }: {
    readonly id: LibraryItemId
  }) {
    const actor = yield* requireActor()
    if (!(yield* (yield* LibraryStore).removeItem(actor, id).pipe(Effect.mapError(libraryFailure))))
      return yield* Effect.fail(new NotFound({ message: 'Library item not found' }))
    return undefined
  }),
  /** Search visibility is decided in SQL before ranking, including shared-Thread privacy. */
  SearchLibrary: Effect.fn('Rpc.SearchLibrary')(function* (
    request: typeof LibrarySearchRequest.Type,
  ) {
    const actor = yield* requireActor()
    const store = yield* LibraryStore
    if (
      request.folderId !== undefined &&
      request.folderId !== null &&
      Option.isNone(
        yield* store.getFolder(actor, request.folderId).pipe(Effect.mapError(libraryFailure)),
      )
    )
      return yield* Effect.fail(new NotFound({ message: 'Library folder not found' }))
    return LibrarySearchResponse.make({
      results: yield* store
        .search(actor, {
          query: request.query,
          limit: request.limit === undefined ? 6 : request.limit,
          folderId: Option.fromNullishOr(request.folderId),
        })
        .pipe(Effect.mapError(libraryFailure)),
    })
  }),
  /** The folder picker includes both readable shelves; each folder identifies its own shelf. */
  ListLibraryFolders: Effect.fn('Rpc.ListLibraryFolders')(function* () {
    return LibraryFolderListResponse.make({
      folders: yield* (yield* LibraryStore)
        .listFolders(yield* requireActor())
        .pipe(Effect.mapError(libraryFailure)),
    })
  }),
  /** Every Member can add a Company folder; Mine always follows its Person. */
  CreateLibraryFolder: Effect.fn('Rpc.CreateLibraryFolder')(function* (
    request: typeof CreateLibraryFolderRequest.Type,
  ) {
    const actor = yield* requireActor()
    const folder = yield* (yield* LibraryStore)
      .createFolder(actor, {
        name: request.name,
        shelf: request.shelf,
        parentId: request.parentId === undefined ? null : request.parentId,
      })
      .pipe(Effect.mapError(libraryFailure))
    return LibraryFolderResponse.make({ folder })
  }),
  /** Folder hierarchy validation stays in the store for every surface and caller. */
  PatchLibraryFolder: Effect.fn('Rpc.PatchLibraryFolder')(function* ({
    id,
    patch,
  }: {
    readonly id: LibraryFolderId
    readonly patch: typeof PatchLibraryFolderRequest.Type
  }) {
    const actor = yield* requireActor()
    const folder = yield* (yield* LibraryStore)
      .patchFolder(actor, id, patch)
      .pipe(Effect.mapError(libraryFailure))
    if (Option.isNone(folder))
      return yield* Effect.fail(new NotFound({ message: 'Library folder not found' }))
    return LibraryFolderResponse.make({ folder: folder.value })
  }),
  /** Nonempty folders fail visibly instead of deleting another contributor's contents. */
  DeleteLibraryFolder: Effect.fn('Rpc.DeleteLibraryFolder')(function* ({
    id,
  }: {
    readonly id: LibraryFolderId
  }) {
    const actor = yield* requireActor()
    yield* (yield* LibraryStore).removeFolder(actor, id).pipe(Effect.mapError(libraryFailure))
    return undefined
  }),
}
