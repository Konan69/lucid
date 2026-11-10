import { VividRpcClient } from '@vivid/client-runtime'
import {
  LibraryUploadResponse,
  RuntimeErrorResponse,
  Workspace,
  type LibraryFolder,
  type LibraryFolderId,
  type LibraryItem,
  type LibraryItemId,
  type LibraryListResponse,
  type LibrarySearchResult,
  type LibraryShelf,
} from '@vivid/contracts'
import { Effect, Option, Result, Schema } from 'effect'

/**
 * The Library, shared by web, phone and desktop: its two shelves, what is in the folder in view,
 * the reads that answer once (search, one item, the folders a thing can move to), how the upload
 * route's answer is read, and what a shelf will look like once a change has been accepted.
 *
 * Sending the bytes is not here: each surface does it with its own platform API (the browser's
 * `XMLHttpRequest` for progress, the phone's file-backed `fetch`) and hands the answer to
 * `uploadOutcome`. What is on a shelf is a live query the screen reads; nothing here keeps a copy
 * of it.
 */

export type LibraryList = typeof LibraryListResponse.Type
export type SearchResult = typeof LibrarySearchResult.Type
export type { LibraryItem, LibraryShelf }

/** A shelf and what it is called where the Person is working. */
export interface ShelfChoice {
  readonly shelf: LibraryShelf
  readonly name: string
}

/**
 * The shelves a Person can look at. A personal space has one, and it is simply the Library. A
 * Company adds its own shelf, named after the Company, beside the Person's.
 */
export const shelvesOf = (workspace: Workspace): ReadonlyArray<ShelfChoice> =>
  Workspace.match(workspace, {
    Personal: () => [{ shelf: 'Mine' as const, name: 'Library' }],
    Company: ({ company }) => [
      { shelf: 'Mine' as const, name: 'Mine' },
      { shelf: 'Company' as const, name: company.name },
    ],
  })

/**
 * What one level of a shelf holds: the folders directly inside `folderId` and the items filed
 * there. The top of a shelf is `null`. A shelf's own result lists every item on it, whichever
 * folder it is in, so the level is always chosen here and never assumed.
 */
export const inFolder = (list: LibraryList, folderId: LibraryFolderId | null): LibraryList => ({
  documents: list.documents.filter((item) => item.folderId === folderId),
  folders: list.folders.filter((folder) => folder.parentId === folderId),
})

/** A size a Person can read: bytes, then kilobytes, then megabytes to one decimal place. */
export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Searches what Vivid has read, inside one folder or across everything the Person can read. */
export const search = Effect.fn('Library.search')(function* (
  query: string,
  folderId: LibraryFolderId | null,
) {
  const client = yield* VividRpcClient
  const response = yield* client.SearchLibrary({ query, limit: 8, folderId })
  return response.results
})

/** Reads one item a search result points at, which may be filed somewhere not on screen. */
export const readItem = Effect.fn('Library.readItem')(function* (id: LibraryItemId) {
  const client = yield* VividRpcClient
  const response = yield* client.GetLibraryItem({ id })
  return response.document
})

/** Every folder on one shelf, at every depth: the places something on that shelf can move to. */
export const shelfFolders = Effect.fn('Library.shelfFolders')(function* (shelf: LibraryShelf) {
  const client = yield* VividRpcClient
  const response = yield* client.ListLibraryFolders()
  return response.folders.filter((folder) => folder.shelf === shelf)
})

/** Why a file did not get into the Library, in a sentence the upload row can show. */
export class UploadRefused extends Schema.TaggedError<UploadRefused>()(
  'UploadRefused',
  { message: Schema.String },
  { title: 'Upload refused' },
) {}

/** A file the server took, and whether that shelf already held the same bytes. */
export interface Uploaded {
  readonly item: LibraryItem
  readonly duplicate: boolean
}

const decodeAccepted = Schema.decodeUnknownOption(Schema.fromJsonString(LibraryUploadResponse))
const decodeRefused = Schema.decodeUnknownOption(Schema.fromJsonString(RuntimeErrorResponse))

/**
 * Reads the upload route's answer. It is the one place its body is decoded: a 2xx answer must be
 * the upload contract, and anything else is a refusal carrying the server's sentence when it sent
 * one. A body that is neither is still a refusal, said with the status the server gave.
 */
export const uploadOutcome = (
  status: number,
  body: string,
): Result.Result<Uploaded, UploadRefused> => {
  const accepted = decodeAccepted(body)
  if (status >= 200 && status < 300 && Option.isSome(accepted)) {
    return Result.succeed({
      item: accepted.value.document,
      duplicate: accepted.value.duplicate === true,
    })
  }
  const refused = decodeRefused(body)
  return Result.fail(
    new UploadRefused({
      message: Option.isSome(refused)
        ? refused.value.error
        : `The upload did not go through (${status}).`,
    }),
  )
}

/** Where an upload goes: a shelf, and a folder on it or the top of the shelf. */
export interface UploadDestination {
  readonly shelf: LibraryShelf
  readonly folderId: LibraryFolderId | null
}

/**
 * A copy of an item with some fields replaced. An item is a plain decoded record, so copying its
 * own fields is a complete copy; the fields are named by the caller, never guessed.
 */
const revised = (item: LibraryItem, changes: Partial<LibraryItem>): LibraryItem =>
  Object.assign({}, item, changes)

/** Applies one change to the item with this id and leaves everything else as it is. */
const onItem =
  (id: LibraryItemId, edit: (item: LibraryItem) => LibraryItem) =>
  (current: LibraryList): LibraryList => ({
    documents: current.documents.map((item) => (item.id === id ? edit(item) : item)),
    folders: current.folders,
  })

/** A deleted item, gone from the shelf. */
export const itemRemoved =
  (id: LibraryItemId) =>
  (current: LibraryList): LibraryList => ({
    documents: current.documents.filter((item) => item.id !== id),
    folders: current.folders,
  })

/** An item under its new name. */
export const itemRenamed = (id: LibraryItemId, name: string) =>
  onItem(id, (item) => revised(item, { name }))

/** An item filed in another folder, or at the top of its shelf. */
export const itemMoved = (id: LibraryItemId, folderId: LibraryFolderId | null) =>
  onItem(id, (item) => revised(item, { folderId }))
