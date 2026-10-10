import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as HttpRouter from 'effect/http/HttpRouter'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import * as Multipart from 'effect/http/Multipart'
import { InvalidRequest, LibraryItemId, LibraryUploadMetadata, NotFound } from '@vivid/contracts'
import type { Actor } from '../auth/access.ts'
import { authenticate } from '../auth/session.ts'
import { libraryFailure } from '../library/failures.ts'
import { digestBytes, MAX_LIBRARY_FILE_BYTES } from '../library/ingest.ts'
import { LibraryStore, type StoredLibraryItem } from '../library/store.ts'
import { observeFailures } from '../observability/failure.ts'
import {
  multipartRequest,
  persistedUpload,
  requestBodyEnded,
  uploadLimitMessage,
  uploadLimits,
  uploadRefusal,
  UploadTooLarge,
} from './upload.ts'

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
  yield* multipartRequest(request.headers)
  const parts = yield* persistedUpload(request).pipe(
    Effect.provide(uploadLimits),
    Effect.mapError(uploadRefusal),
    Effect.tapErrorTag('UploadUnstored', () =>
      Effect.logError('Library upload could not persist multipart bytes'),
    ),
  )
  const files = parts.file
  const file = Array.isArray(files) ? files.find(Multipart.isPersistedFile) : undefined
  if (file === undefined) return yield* new InvalidRequest({ message: 'File is required' })
  const fileSystem = yield* FileSystem.FileSystem
  const bytes = yield* fileSystem.readFile(file.path)
  if (bytes.byteLength > MAX_LIBRARY_FILE_BYTES)
    return yield* new UploadTooLarge({ exceeded: 'File' })
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
  return HttpServerResponse.jsonUnsafe(result, { status: 201 })
})

/**
 * Hold success, refusal and defect outcomes until the upload ends, so Node proxies and closing
 * connections can finish writing before reading the final answer. Exit preserves the original
 * outcome rather than turning parser or persistence failures into a successful response. The
 * drain stays on the interruptible request path, never in a finalizer for a disconnected sender.
 * upload.ts owns both reads of the body: `persistedUpload` parses it and `requestBodyEnded`
 * reads what is left after parsing releases its reader, so the two reads never compete.
 */
const uploadAfterBody = Effect.fn('Http.Library.uploadAfterBody')(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const outcome = yield* Effect.exit(upload())
  yield* requestBodyEnded(request)
  return yield* outcome
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
  if (name === null) return yield* new InvalidRequest({ message: 'Source name is required' })
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

/** Derive the closed failure vocabulary from the routes so upload limit context stays typed. */
type BytesFailure = Effect.Error<
  ReturnType<typeof uploadAfterBody> | ReturnType<typeof source> | ReturnType<typeof content>
>

/** HTTP status mapping preserves authentication, isolation, validation and upload failures. */
const respond = <R>(
  operation: Effect.Effect<HttpServerResponse.HttpServerResponse, BytesFailure, R>,
) =>
  operation.pipe(
    // Recorded before the mapping below: once a failure is a status code it is no longer one.
    observeFailures('http'),
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
      UploadTooLarge: (error) =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe({ error: uploadLimitMessage(error) }, { status: 413 }),
        ),
      UploadMalformed: () =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            { error: 'Vivid could not read this upload.' },
            { status: 400 },
          ),
        ),
      UploadUnstored: () =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            { error: 'Vivid could not store this file. Try again.' },
            { status: 500 },
          ),
        ),
      UploadAbandoned: () => Effect.succeed(HttpServerResponse.empty({ status: 499 })),
      NotFound: () =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe({ error: 'Library item not found' }, { status: 404 }),
        ),
    }),
  )

export const bytesRoutes = Layer.mergeAll(
  HttpRouter.add('POST', '/api/library', respond(uploadAfterBody())),
  HttpRouter.add('GET', '/api/library/source', respond(source())),
  HttpRouter.add('GET', '/api/library/:id/content', respond(content())),
)
