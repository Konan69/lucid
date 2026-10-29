import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import * as Headers from 'effect/http/Headers'
import * as HttpRouter from 'effect/http/HttpRouter'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import {
  AttachmentTooLarge,
  Conflict,
  InvalidAttachment,
  PictureMediaType,
  PicturesRequirePrivateThread,
  ThreadId,
  TooManyAttachments,
  UnsupportedAttachment,
} from '@vivid/contracts'
import { authenticate, sessionWorkspace } from '../auth/session.ts'
import { Runtime } from '../runtime/client.ts'
import { Database } from '../database/client.ts'
import { Changes } from '../live/changes.ts'
import { observeFailures } from '../observability/failure.ts'
import { authorized } from './reach.ts'
import { requireThread } from './access.ts'

/** Private picture bytes stay behind session and Thread access checks, including revocation. */

const Params = Schema.Struct({ threadId: ThreadId })

const decodePictureType = Schema.decodeUnknownOption(PictureMediaType)

const refuse = (status: number, message: string) =>
  HttpServerResponse.jsonUnsafe({ error: { message } }, { status })

/** The Person asking and the Thread they named, or the refusal to answer with. */
const admitted = Effect.fn('Gateway.admitted')(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const auth = yield* authenticate(new globalThis.Headers(Object.entries(request.headers)))
  const { threadId } = yield* HttpRouter.schemaPathParams(Params)
  const thread = yield* requireThread(threadId, auth.person.id)
  return { request, person: auth.person, sessionId: auth.sessionId, thread }
})

/** The refusal for each failure a client can act on. Everything else is "try again". */
const REFUSALS = new Map([
  ['Unauthenticated', refuse(401, 'Sign in to continue')],
  ['NotFound', refuse(404, 'Thread not found')],
  ['SchemaError', refuse(404, 'Thread not found')],
])

const refusalFor = (tag: string) => {
  const known = REFUSALS.get(tag)
  return known === undefined ? refuse(503, 'Vivid is unavailable right now') : known
}

const isConflict = Schema.is(Conflict)
const isTooLarge = Schema.is(AttachmentTooLarge)
const isPictureRefusal = Schema.is(
  Schema.Union([
    AttachmentTooLarge,
    InvalidAttachment,
    PicturesRequirePrivateThread,
    TooManyAttachments,
    UnsupportedAttachment,
  ]),
)

/** Attachment failures expose only their fixed, displayable sentence and stable contract tag. */
const pictureRefusal = (error: { readonly _tag: string; readonly message: string }) =>
  HttpServerResponse.jsonUnsafe(
    { error: { _tag: error._tag, message: error.message } },
    {
      status: isTooLarge(error) ? 413 : 400,
    },
  )

/** Ordinary Conflict responses retain their existing wire shape for clients already using them. */
const answerFailure = (error: { readonly _tag: string }) => {
  if (isConflict(error)) return refuse(409, error.message)
  if (isPictureRefusal(error)) return pictureRefusal(error)
  return refusalFor(error._tag)
}

/**
 * Preserves a busy-Thread Conflict's displayable message for every client of this gateway.
 * Other failures use fixed refusals, keeping database and runtime details private.
 */
const answered = <R>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, { readonly _tag: string }, R>,
) =>
  effect.pipe(
    // Recorded here because the next step turns every failure into a response.
    observeFailures('http'),
    Effect.catch((error) => Effect.succeed(answerFailure(error))),
  )

/** Attachment reads retain main's checks before headers and during body consumption. */
const attachmentRead = Effect.fn('Gateway.read')(function* () {
  const { person, sessionId, thread } = yield* admitted()
  const { attachmentId } = yield* HttpRouter.schemaPathParams(
    Schema.Struct({
      threadId: ThreadId,
      attachmentId: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
    }),
  )
  const runtime = yield* Runtime
  const services = yield* Effect.context<Changes | Database>()
  const response = yield* runtime.read({
    threadId: thread.id,
    suffix: `/attachments/${encodeURIComponent(attachmentId)}`,
  })
  yield* sessionWorkspace(person.id, sessionId)
  yield* requireThread(thread.id, person.id)
  if (response.status !== 200) return refuse(404, 'Picture not found')
  const headers = yield* pictureHeaders(response.headers)
  const body = authorized(response.stream, thread, { personId: person.id, sessionId }).pipe(
    Stream.provideContext(services),
  )
  return HttpServerResponse.stream(body, { status: response.status, headers })
})

/** Never forward runtime-supplied filenames, unsafe MIME types or public cache directives for private bytes. */
const pictureHeaders = Effect.fn('Gateway.pictureHeaders')(function* (headers: Headers.Headers) {
  const mediaType = Option.flatMap(Headers.get(headers, 'content-type'), decodePictureType)
  if (Option.isNone(mediaType))
    return yield* new UnsupportedAttachment({
      message: 'This attachment is not a supported picture.',
    })
  return Headers.fromInput({
    'content-type': mediaType.value,
    'content-disposition': 'inline',
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, no-store',
  })
})

export const gatewayRoutes = HttpRouter.add(
  'GET',
  '/api/vivid/:threadId/attachments/:attachmentId',
  answered(attachmentRead()),
)
