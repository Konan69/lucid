import { Schema } from 'effect'
import { LibraryFolderId, LibraryItemId } from './identity.js'

/**
 * Which shelf something is on. `Mine` is the Person's own, in this workspace. `Company` is the
 * shelf every Member reads and Vivid searches in every Member's Threads. A personal space has only
 * `Mine`.
 */
export const LibraryShelf = Schema.Literals(['Mine', 'Company'] as const)
export type LibraryShelf = typeof LibraryShelf.Type

/** Closed Library processing lifecycle values encoded by the current HTTP protocol. */
export const LibraryItemStatus = Schema.Literals(['processing', 'ready', 'failed'] as const)

/** Library item metadata returned by list and mutation routes. */
export const LibraryItem = Schema.Struct({
  id: LibraryItemId,
  name: Schema.String,
  mimeType: Schema.String,
  size: Schema.Number,
  sha256: Schema.String,
  status: LibraryItemStatus,
  error: Schema.NullOr(Schema.String),
  preview: Schema.String,
  chunkCount: Schema.Number,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  folderId: Schema.NullOr(LibraryFolderId),
  shelf: LibraryShelf,
}).annotate({ identifier: 'LibraryItem', title: 'Library item' })
/** Decoded Library item. */
export interface LibraryItem extends Schema.Schema.Type<typeof LibraryItem> {}

/** Recursive Library folder metadata returned by the runtime. */
export const LibraryFolder = Schema.Struct({
  id: LibraryFolderId,
  name: Schema.String,
  parentId: Schema.NullOr(LibraryFolderId),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  itemCount: Schema.Number,
  shelf: LibraryShelf,
}).annotate({ identifier: 'LibraryFolder', title: 'Library folder' })
/** Decoded Library folder. */
export interface LibraryFolder extends Schema.Schema.Type<typeof LibraryFolder> {}

/** One ranked Library search match. */
export const LibrarySearchResult = Schema.Struct({
  chunkId: Schema.String,
  documentId: LibraryItemId,
  filename: Schema.String,
  page: Schema.NullOr(Schema.Number),
  text: Schema.String,
  score: Schema.Number,
})
/** Optional folder filter for Library list routes. */
export const LibraryListQuery = Schema.Struct({
  shelf: LibraryShelf,
  folderId: Schema.optionalKey(LibraryFolderId),
})
/** Source-name query for Library content lookup. */
export const LibrarySourceQuery = Schema.Struct({ name: Schema.String })
/** Library item path parameters. */
export const LibraryItemParams = Schema.Struct({ id: LibraryItemId })
/** Library folder path parameters. */
export const LibraryFolderParams = Schema.Struct({ id: LibraryFolderId })
/** Library list response. */
export const LibraryListResponse = Schema.Struct({
  documents: Schema.Array(LibraryItem),
  folders: Schema.Array(LibraryFolder),
})
/** Single Library item response. */
export const LibraryItemResponse = Schema.Struct({ document: LibraryItem })
/** Single Library folder response. */
export const LibraryFolderResponse = Schema.Struct({ folder: LibraryFolder })
/** Library folder list response. */
export const LibraryFolderListResponse = Schema.Struct({ folders: Schema.Array(LibraryFolder) })
/** Decoded metadata extracted from a multipart Library upload. */
export const LibraryUploadMetadata = Schema.Struct({
  name: Schema.String,
  mimeType: Schema.Literals(['application/pdf', 'text/markdown', 'text/plain'] as const),
  size: Schema.Number,
  folderId: Schema.NullOr(LibraryFolderId),
  shelf: LibraryShelf,
})
/** Library upload response. */
export const LibraryUploadResponse = Schema.Struct({
  document: LibraryItem,
  duplicate: Schema.optionalKey(Schema.Boolean),
})
/** Library search request. */
export const LibrarySearchRequest = Schema.Struct({
  query: Schema.String,
  folderId: Schema.optionalKey(Schema.NullOr(LibraryFolderId)),
  limit: Schema.optionalKey(Schema.Number),
})
/** Library search response. */
export const LibrarySearchResponse = Schema.Struct({ results: Schema.Array(LibrarySearchResult) })
/** Library folder creation request. */
export const CreateLibraryFolderRequest = Schema.Struct({
  name: Schema.String,
  shelf: LibraryShelf,
  parentId: Schema.optionalKey(Schema.NullOr(LibraryFolderId)),
})
/** Library folder patch request. */
export const PatchLibraryFolderRequest = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  parentId: Schema.optionalKey(Schema.NullOr(LibraryFolderId)),
})
/** Library item patch request. */
export const PatchLibraryItemRequest = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  folderId: Schema.optionalKey(Schema.NullOr(LibraryFolderId)),
})
