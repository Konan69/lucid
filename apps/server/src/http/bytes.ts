import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as HttpRouter from 'effect/unstable/http/HttpRouter'
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import * as Multipart from 'effect/unstable/http/Multipart'
import { LibraryItemId, LibraryUploadMetadata, LibraryUploadResponse } from '@vivid/contracts'
import { authenticate } from '../auth/session.ts'
import { digestBytes, ingestLibraryItem, LIBRARY_FILE_TYPES, MAX_LIBRARY_FILE_BYTES } from '../library/ingest.ts'
import { LibraryStore } from '../library/store.ts'

const mimeByExtension = new Map([
  ['pdf', 'application/pdf'],
  ['md', 'text/markdown'],
  ['markdown', 'text/markdown'],
  ['txt', 'text/plain'],
])

const inferMimeType = (name: string, declared: string) => {
  const extension = name.toLocaleLowerCase().split('.').pop()
  return (extension === undefined ? undefined : mimeByExtension.get(extension)) ?? declared
}

const requireAuthentication = Effect.fn('Http.requireAuthentication')(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  yield* authenticate(new globalThis.Headers(Object.entries(request.headers)))
})

const upload = Effect.fn('Http.Library.upload')(function* () {
  yield* requireAuthentication()
  const request = yield* HttpServerRequest.HttpServerRequest
  const parts = yield* request.multipart
  const files = parts.file
  const file = Array.isArray(files) ? files.find(Multipart.isPersistedFile) : undefined
  if (file === undefined) return HttpServerResponse.jsonUnsafe({ error: 'File is required' }, { status: 400 })
  const fileSystem = yield* FileSystem.FileSystem
  const bytes = yield* fileSystem.readFile(file.path)
  const mimeType = inferMimeType(file.name, file.contentType)
  const folderField = parts.folderId
  const folderId = typeof folderField === 'string' && folderField.length > 0 ? folderField : null
  const metadata = yield* Schema.decodeUnknownEffect(LibraryUploadMetadata)({ name: file.name, mimeType, size: bytes.byteLength, folderId }).pipe(Effect.option)
  if (Option.isNone(metadata) || !LIBRARY_FILE_TYPES.includes(mimeType as (typeof LIBRARY_FILE_TYPES)[number]) || bytes.byteLength > MAX_LIBRARY_FILE_BYTES) {
    return HttpServerResponse.jsonUnsafe({ error: 'Unsupported or oversized Library item' }, { status: 400 })
  }
  const library = yield* LibraryStore
  if (metadata.value.folderId !== null && (yield* library.getFolder(metadata.value.folderId)) === undefined) {
    return HttpServerResponse.jsonUnsafe({ error: 'Library folder not found' }, { status: 404 })
  }
  const digest = digestBytes(bytes)
  const existing = yield* library.getItemByDigest(digest)
  if (existing !== undefined) return HttpServerResponse.jsonUnsafe(LibraryUploadResponse.make({ document: existing, duplicate: true }), { status: 200 })
  const document = yield* library.createItem({ name: metadata.value.name, mimeType: metadata.value.mimeType, bytes, sha256: digest, folderId: metadata.value.folderId })
  yield* ingestLibraryItem(document.id)
  const indexed = (yield* library.getItem(document.id)) ?? document
  return HttpServerResponse.jsonUnsafe(LibraryUploadResponse.make({ document: indexed }), { status: 201 })
})

const source = Effect.fn('Http.Library.source')(function* () {
  yield* requireAuthentication()
  const request = yield* HttpServerRequest.HttpServerRequest
  const name = new URL(request.url, 'http://vivid.local').searchParams.get('name')
  if (name === null) return HttpServerResponse.jsonUnsafe({ error: 'Source name is required' }, { status: 400 })
  const library = yield* LibraryStore
  const document = yield* library.getStoredItemByName(name)
  return document === undefined
    ? HttpServerResponse.jsonUnsafe({ error: 'Library source not found' }, { status: 404 })
    : HttpServerResponse.uint8Array(document.bytes, { contentType: document.mimeType, headers: { 'content-disposition': `inline; filename="${document.name.replaceAll('"', '')}"` } })
})

const content = Effect.fn('Http.Library.content')(function* () {
  yield* requireAuthentication()
  const route = yield* HttpRouter.RouteContext
  const decoded = yield* Schema.decodeUnknownEffect(LibraryItemId)(route.params.id).pipe(Effect.option)
  if (Option.isNone(decoded)) return HttpServerResponse.jsonUnsafe({ error: 'Library item not found' }, { status: 404 })
  const library = yield* LibraryStore
  const document = yield* library.getStoredItem(decoded.value)
  return document === undefined
    ? HttpServerResponse.jsonUnsafe({ error: 'Library item not found' }, { status: 404 })
    : HttpServerResponse.uint8Array(document.bytes, { contentType: document.mimeType, headers: { 'content-disposition': `inline; filename="${document.name.replaceAll('"', '')}"` } })
})

export const bytesRoutes = Layer.mergeAll(
  HttpRouter.add('POST', '/api/library', upload()),
  HttpRouter.add('GET', '/api/library/source', source()),
  HttpRouter.add('GET', '/api/library/:id/content', content()),
)
