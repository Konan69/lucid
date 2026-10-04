import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest'
import * as Multipart from 'effect/unstable/http/Multipart'
import * as MultipartParser from 'effect/unstable/http/MultipartParser'
import { MAX_LIBRARY_FILE_BYTES } from '../library/ingest.ts'

/** rc.116 counts part headers toward maxFileSize; reserve their bounded envelope separately. */
const PART_HEADER_ALLOWANCE = 2 * 1024
/** Shelf names and folder ids need no large form field buffers. */
const FIELD_BYTES = 1024
/** Bound the complete wire body, including both metadata parts and their headers. */
const MAX_BODY_BYTES =
  MAX_LIBRARY_FILE_BYTES + PART_HEADER_ALLOWANCE + 2 * (FIELD_BYTES + PART_HEADER_ALLOWANCE)
/** Declared lengths are untrusted HTTP ingress; the streaming parser enforces absent lengths. */
const uploadHeaders = Schema.Struct({
  'content-length': Schema.optionalKey(
    Schema.FiniteFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  ),
})
const decodeUploadHeaders = Schema.decodeUnknownEffect(uploadHeaders)

/** Bound SDK persistence before any file is read: file, shelf and optional folderId only. */
export const uploadLimits = Multipart.limitsServices({
  maxParts: 3,
  maxFieldSize: FIELD_BYTES,
  maxFileSize: MAX_LIBRARY_FILE_BYTES + PART_HEADER_ALLOWANCE,
  maxTotalSize: MAX_BODY_BYTES,
})

/** A size refusal is HTTP 413 and retains which independent parser bound was exceeded. */
export class UploadTooLarge extends Schema.TaggedError<UploadTooLarge>()(
  'UploadTooLarge',
  { exceeded: Schema.Literals(['File', 'Field', 'Body', 'Parts']) },
  { title: 'Library upload exceeds a limit' },
) {}

/** Invalid multipart syntax is HTTP 400; retrying the same bytes cannot repair it. */
export class UploadMalformed extends Schema.TaggedError<UploadMalformed>()(
  'UploadMalformed',
  {},
  { title: 'Library upload cannot be parsed' },
) {}

/** Temporary storage failure is HTTP 500 and may succeed when retried. */
export class UploadUnstored extends Schema.TaggedError<UploadUnstored>()(
  'UploadUnstored',
  {},
  { title: 'Library upload could not be persisted' },
) {}

/** The connection ended before the request body did, so no response can reach the Person. */
export class UploadAbandoned extends Schema.TaggedError<UploadAbandoned>()(
  'UploadAbandoned',
  {},
  { title: 'Library upload ended before its body' },
) {}

/**
 * The bytes of a Web `Request`, read by one reader at a time and handed back unlocked. A Web
 * body is exclusive: rc.116 Channel.readableStreamToPullUnsafe takes `getReader()` per stream
 * evaluation, and its default finalizer is `reader.cancel()`, which discards the unread rest
 * and never releases the lock. The SDK's Web `request.stream` and `request.multipart`
 * (HttpServerRequest.ts ServerRequestImpl) both use that default, so a second read of the same
 * request dies with "ReadableStream is locked". `releaseLockOnEnd` is the SDK's public option
 * for the other finalizer, `reader.releaseLock()`: the parser and the drain below then read in
 * turn, and a refused upload keeps its remainder for the drain instead of losing it to cancel.
 * A request without a body has already ended; the SDK stream fails for it instead.
 * Read failures keep the SDK's own multipart mapping (ServerRequestImpl.multipartStream).
 */
const webBody = (
  source: globalThis.Request,
): Stream.Stream<Uint8Array, Multipart.MultipartError> => {
  const body = source.body
  if (body === null) return Stream.empty
  return Stream.fromReadableStream({
    evaluate: () => body,
    onError: (cause) => Multipart.MultipartError.fromReason('InternalError', cause),
    releaseLockOnEnd: true,
  })
}

/** Read and drop a body to its end; any read failure means the sender left before it ended. */
const bodyEnded = <E>(body: Stream.Stream<Uint8Array, E>) =>
  Stream.runDrain(body).pipe(Effect.mapError(() => new UploadAbandoned({})))

/**
 * Persist the multipart parts of an upload, leaving the body readable for `requestBodyEnded`.
 * The two installed request sources differ in who may read the body twice, so each is named:
 * a Web `Request` (the discriminator HttpServerRequest.toWebResult itself uses) is parsed here
 * with the SDK's public pieces, exactly as ServerRequestImpl.multipart composes them, but over
 * `webBody` so the reader is released. Every other source keeps its SDK adapter untouched: the
 * Node server's `request.multipart` is NodeMultipart.persisted, which pipes the IncomingMessage
 * into the native parser and leaves it readable by `request.stream` afterwards.
 */
export const persistedUpload = (request: HttpServerRequest.HttpServerRequest) =>
  request.source instanceof globalThis.Request
    ? Multipart.toPersisted(
        Stream.pipeThroughChannel(webBody(request.source), Multipart.makeChannel(request.headers)),
      )
    : request.multipart

/**
 * Finish consuming the upload before answering, without retaining its unread bytes. Node
 * v24.14.1 _http_client.socketOnData removes the request drain relay on a final response;
 * an unfinished proxy pipe then stalls. _http_server.resOnFinish also closes an unfinished
 * request when Connection is close. The SDK stream works for unread, paused and already-ended
 * Node bodies; a Web body is read through `webBody`, after `persistedUpload` released it.
 * Node's native request timeout bounds a sender that never finishes. Keep this drain
 * interruptible: disconnect and server shutdown must release the request, never wait in cleanup.
 */
export const requestBodyEnded = (request: HttpServerRequest.HttpServerRequest) =>
  request.source instanceof globalThis.Request
    ? bodyEnded(webBody(request.source))
    : bodyEnded(request.stream)

// Every installed SDK reason has an honest transport outcome; adding a reason fails typecheck.
const refusalByReason = {
  FileTooLarge: () => new UploadTooLarge({ exceeded: 'File' }),
  FieldTooLarge: () => new UploadTooLarge({ exceeded: 'Field' }),
  BodyTooLarge: () => new UploadTooLarge({ exceeded: 'Body' }),
  TooManyParts: () => new UploadTooLarge({ exceeded: 'Parts' }),
  Parse: () => new UploadMalformed({}),
  InternalError: () => new UploadUnstored({}),
} satisfies Record<
  Multipart.MultipartErrorReason['_tag'],
  () => UploadTooLarge | UploadMalformed | UploadUnstored
>

/** Decode the SDK's closed failure vocabulary once, retaining the limit that was exceeded. */
export const uploadRefusal = (error: Multipart.MultipartError) =>
  refusalByReason[error.reason._tag]()

// The limit vocabulary owns the copy mapping too; a new limit must select an explicit sentence.
const messageByLimit = {
  File: `This file is larger than ${MAX_LIBRARY_FILE_BYTES / 1024 / 1024} MB.`,
  Body: `This file is larger than ${MAX_LIBRARY_FILE_BYTES / 1024 / 1024} MB.`,
  Field: 'Vivid could not read this upload.',
  Parts: 'Vivid could not read this upload.',
} satisfies Record<UploadTooLarge['exceeded'], string>

/** Keep every limit's Person-facing response total as the closed vocabulary grows. */
export const uploadLimitMessage = (error: UploadTooLarge) => messageByLimit[error.exceeded]

/**
 * Refuse known oversized envelopes before parsing; the parser still limits chunked requests.
 * rc.116 NodeMultipartParser.MultipartStream emits InvalidBoundary before attaching listeners.
 * Probe headers with the same public SDK parser before constructing that Node adapter. No body
 * is read: only InvalidBoundary can fire during make; the other callbacks require write/end.
 * Remove this preflight once the Node adapter reports construction failures as MultipartError.
 */
export const multipartRequest = Effect.fn('Http.Library.multipartRequest')(function* (
  headers: Readonly<Record<string, string>>,
) {
  const envelope = yield* decodeUploadHeaders(headers).pipe(
    Effect.mapError(() => new UploadMalformed({})),
  )
  const size = envelope['content-length']
  if (size !== undefined && size > MAX_BODY_BYTES)
    return yield* Effect.fail(new UploadTooLarge({ exceeded: 'Body' }))
  let failure = Option.none<MultipartParser.MultipartError>()
  MultipartParser.make({
    headers,
    onField: () => {},
    onFile: () => () => {},
    onDone: () => {},
    onError: (error) => {
      failure = Option.some(error)
    },
  })
  return yield* Option.match(failure, {
    onNone: () => Effect.void,
    onSome: () => Effect.fail(new UploadMalformed({})),
  })
})
