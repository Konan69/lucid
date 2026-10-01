import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as HttpRouter from 'effect/unstable/http/HttpRouter'
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import * as Multipart from 'effect/unstable/http/Multipart'
import {
  InvalidRequest,
  LibraryItemId,
  LibraryUploadMetadata,
  LibraryUploadResponse,
  NotFound,
} from '@vivid/contracts'
import type { Actor } from '../auth/access.ts'
import { authenticate } from '../auth/session.ts'
import { changed } from '../live/changes.ts'
import { libraryFailure } from '../library/failures.ts'
import { digestBytes, ingestLibraryItem, MAX_LIBRARY_FILE_BYTES } from '../library/ingest.ts'
import { LibraryStore, type StoredLibraryItem } from '../library/store.ts'

const mimeByExtension = new Map([
  ['pdf', 'application/pdf'],
  ['md', 'text/markdown'],
  ['markdown', 'text/markdown'],
  ['txt', 'text/plain'],
])

/** File extensions normalize common browser MIME declarations before the metadata ingress. */
const inferMimeType = (name: string, declared: string) => {
  const extension = name.toLocaleLowerCase().split('.').pop()
  const inferred = extension === undefined ? undefined : mimeByExtension.get(extension)
  return inferred === undefined ? declared : inferred
}

/** Bytes accept cookie or bearer sessions only; authentication supplies the Actor used by SQL. */
const authenticatedActor = Effect.fn('Http.Library.actor')(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const auth = yield* authenticate(new globalThis.Headers(Object.entries(request.headers)))
  return {
    person: auth.person,
    workspace: auth.workspace,
    by: 'person',
    threadId: Option.none(),
  } satisfies Actor
})

const decodeUpload = Schema.decodeUnknownEffect(LibraryUploadMetadata)
const decodeItemId = Schema.decodeUnknownEffect(LibraryItemId)

/** Malformed destination ids are rejected, never silently turned into the shelf root. */
const upload = Effect.fn('Http.Library.upload')(function* () {
  const actor = yield* authenticatedActor()
  const request = yield* HttpServerRequest.HttpServerRequest
  const parts = yield* request.multipart
  const files = parts.file
  const file = Array.isArray(files) ? files.find(Multipart.isPersistedFile) : undefined
  if (file === undefined)
    return yield* Effect.fail(new InvalidRequest({ message: 'File is required' }))
  const fileSystem = yield* FileSystem.FileSystem
  const bytes = yield* fileSystem.readFile(file.path)
  if (bytes.byteLength > MAX_LIBRARY_FILE_BYTES)
    return yield* Effect.fail(
      new InvalidRequest({ message: 'Library item exceeds the size limit' }),
    )
  const metadata = yield* decodeUpload({
    name: file.name,
    mimeType: inferMimeType(file.name, file.contentType),
    size: bytes.byteLength,
    folderId: parts.folderId === undefined ? null : parts.folderId,
    shelf: parts.shelf,
  }).pipe(Effect.mapError(() => new InvalidRequest({ message: 'Invalid Library upload metadata' })))
  const library = yield* LibraryStore
  const result = yield* library
    .createItem(actor, { ...metadata, bytes, sha256: digestBytes(bytes) })
    .pipe(Effect.mapError(libraryFailure))
  if (result.duplicate === true) return HttpServerResponse.jsonUnsafe(result, { status: 200 })
  yield* changed(actor)
  yield* ingestLibraryItem(actor, result.document.id).pipe(Effect.mapError(libraryFailure))
  const indexed = yield* library
    .getItem(actor, result.document.id)
    .pipe(Effect.mapError(libraryFailure))
  if (Option.isNone(indexed))
    return yield* Effect.fail(new NotFound({ message: 'Library item no longer exists' }))
  return HttpServerResponse.jsonUnsafe(
    LibraryUploadResponse.make({ document: indexed.value, duplicate: false }),
    { status: 201 },
  )
})

/** All byte responses come from a store lookup already scoped to the authenticated shelves. */
const byteResponse = (document: Option.Option<StoredLibraryItem>) => {
  if (Option.isNone(document))
    return Effect.fail(new NotFound({ message: 'Library item not found' }))
  return Effect.succeed(
    HttpServerResponse.uint8Array(document.value.bytes, {
      contentType: document.value.mimeType,
      headers: {
        'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(document.value.name)}`,
      },
    }),
  )
}

/** Legacy source-name downloads retain the same access boundary as id downloads. */
const source = Effect.fn('Http.Library.source')(function* () {
  const actor = yield* authenticatedActor()
  const request = yield* HttpServerRequest.HttpServerRequest
  const name = new URL(request.url, 'http://vivid.local').searchParams.get('name')
  if (name === null)
    return yield* Effect.fail(new InvalidRequest({ message: 'Source name is required' }))
  const document = yield* (yield* LibraryStore)
    .getStoredItemByName(actor, name)
    .pipe(Effect.mapError(libraryFailure))
  return yield* byteResponse(document)
})

/** An unreadable id is indistinguishable from a missing file. */
const content = Effect.fn('Http.Library.content')(function* () {
  const actor = yield* authenticatedActor()
  const route = yield* HttpRouter.RouteContext
  const id = yield* decodeItemId(route.params.id).pipe(
    Effect.mapError(() => new NotFound({ message: 'Library item not found' })),
  )
  const document = yield* (yield* LibraryStore)
    .getStoredItem(actor, id)
    .pipe(Effect.mapError(libraryFailure))
  return yield* byteResponse(document)
})

/** HTTP status mapping preserves authentication, isolation and validation failures. */
const respond = <
  A extends HttpServerResponse.HttpServerResponse,
  E extends { readonly _tag: string },
  R,
>(
  operation: Effect.Effect<A, E, R>,
) =>
  operation.pipe(
    Effect.catchTags({
      Unauthenticated: () =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe({ error: 'Authentication required' }, { status: 401 }),
        ),
      Forbidden: () =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe({ error: 'Library access denied' }, { status: 403 }),
        ),
      InvalidRequest: () =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe({ error: 'Invalid Library request' }, { status: 400 }),
        ),
      NotFound: () =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe({ error: 'Library item not found' }, { status: 404 }),
        ),
    }),
  )

export const bytesRoutes = Layer.mergeAll(
  HttpRouter.add('POST', '/api/library', respond(upload())),
  HttpRouter.add('GET', '/api/library/source', respond(source())),
  HttpRouter.add('GET', '/api/library/:id/content', respond(content())),
)
