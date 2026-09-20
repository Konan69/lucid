import { VividRpcClient } from '@vivid/client-runtime'
import {
  LibraryFolderId,
  LibraryItemId,
  LibrarySearchResult,
  LibraryUploadResponse,
  RuntimeErrorResponse,
} from '@vivid/contracts'
import type { LibraryFolder, LibraryItem } from '@vivid/contracts'
import { Effect, Option, Schema } from 'effect'
import type * as RpcClientError from 'effect/unstable/rpc/RpcClientError'
import type { Program as RuntimeProgram } from './runtime'
import { clientFailure } from './runtime'

export type Program<Value> = RuntimeProgram<Value>
export type LibraryDocument = LibraryItem
export type SearchResult = typeof LibrarySearchResult.Type
export type { LibraryFolder }

export type DialogState =
  | { kind: 'new-folder' }
  | { kind: 'rename-folder'; folder: LibraryFolder }
  | { kind: 'move-folder'; folder: LibraryFolder }
  | { kind: 'rename-file'; document: LibraryDocument }
  | { kind: 'move-file'; document: LibraryDocument }

export type DialogResult = { folder?: LibraryFolder; document?: LibraryDocument }

const decodeUploadResponse = Schema.decodeUnknownOption(LibraryUploadResponse)
const decodeErrorResponse = Schema.decodeUnknownOption(RuntimeErrorResponse)

/** Loads the current folder and the complete folder index used by move dialogs. */
export const load = Effect.fn('Library.load')(function* (folderId: string | null) {
  const client = yield* VividRpcClient
  const [body, folderBody] = yield* Effect.all([
    client.ListLibrary(folderId === null ? {} : { folderId: LibraryFolderId.make(folderId) }),
    client.ListLibraryFolders(),
  ])
  return {
    documents: [...body.documents],
    folders: [...body.folders],
    allFolders: [...folderBody.folders],
  }
})

/** Uploads one file while reporting byte progress from the browser's byte endpoint. */
export const upload = Effect.fn('Library.upload')(function* (
  file: File,
  folderId: string | null,
  onProgress: (progress: number) => void,
) {
  return yield* Effect.callback<LibraryDocument, RpcClientError.RpcClientError>((resume) => {
    const form = new FormData()
    form.set('file', file)
    if (folderId !== null) form.set('folderId', folderId)
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/library')
    xhr.responseType = 'json'
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100))
    })
    xhr.addEventListener('error', () =>
      resume(Effect.fail(clientFailure('Upload failed', xhr.statusText))),
    )
    xhr.addEventListener('load', () => {
      const body = decodeUploadResponse(xhr.response)
      if (xhr.status >= 200 && xhr.status < 300 && Option.isSome(body)) {
        resume(Effect.succeed(body.value.document))
        return
      }
      const failure = decodeErrorResponse(xhr.response)
      const message = Option.isSome(failure) ? failure.value.error : undefined
      resume(Effect.fail(clientFailure(message ?? `Upload failed (${xhr.status})`, xhr.response)))
    })
    xhr.send(form)
  })
})

/** Searches ready Library documents in the current folder scope. */
export const search = Effect.fn('Library.search')(function* (
  query: string,
  folderId: string | null,
) {
  const client = yield* VividRpcClient
  const response = yield* client.SearchLibrary({
    query,
    limit: 8,
    folderId: folderId === null ? null : LibraryFolderId.make(folderId),
  })
  return [...response.results]
})

/** Deletes one Library document. */
export const removeDocument = Effect.fn('Library.removeDocument')(function* (id: string) {
  const client = yield* VividRpcClient
  yield* client.DeleteLibraryItem({ id: LibraryItemId.make(id) })
})

/** Deletes one empty Library folder. */
export const removeFolder = Effect.fn('Library.removeFolder')(function* (id: string) {
  const client = yield* VividRpcClient
  yield* client.DeleteLibraryFolder({ id: LibraryFolderId.make(id) })
})

/** Reads one Library document selected from search results. */
export const readDocument = Effect.fn('Library.readDocument')(function* (id: string) {
  const client = yield* VividRpcClient
  const response = yield* client.GetLibraryItem({ id: LibraryItemId.make(id) })
  return response.document
})

/** Applies one create, rename, or move dialog operation. */
export const saveDialog = Effect.fn('Library.saveDialog')(function* (
  state: DialogState,
  name: string,
  destination: string,
  currentFolderId: string | null,
) {
  const client = yield* VividRpcClient
  if (state.kind === 'new-folder') {
    const body = yield* client.CreateLibraryFolder({
      name,
      parentId: currentFolderId === null ? null : LibraryFolderId.make(currentFolderId),
    })
    return { folder: body.folder } satisfies DialogResult
  }
  if (state.kind === 'rename-folder' || state.kind === 'move-folder') {
    const body = yield* client.PatchLibraryFolder({
      id: state.folder.id,
      patch:
        state.kind === 'rename-folder'
          ? { name }
          : { parentId: destination ? LibraryFolderId.make(destination) : null },
    })
    return { folder: body.folder } satisfies DialogResult
  }
  const body = yield* client.PatchLibraryItem({
    id: state.document.id,
    patch:
      state.kind === 'rename-file'
        ? { name }
        : { folderId: destination ? LibraryFolderId.make(destination) : null },
  })
  return { document: body.document } satisfies DialogResult
})
