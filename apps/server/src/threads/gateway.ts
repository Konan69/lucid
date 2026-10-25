import { Effect, Option, Schema, Stream } from 'effect'
import * as Headers from 'effect/http/Headers'
import * as HttpRouter from 'effect/http/HttpRouter'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { PictureMediaType, RuntimeAttachmentPath, UnsupportedAttachment } from '@vivid/contracts'
import { authenticate, sessionWorkspace } from '../auth/session.ts'
import { Runtime, RuntimeRejected } from '../runtime/client.ts'
import { Database } from '../database/client.ts'
import { Changes } from '../live/changes.ts'
import { observeFailures } from '../observability/failure.ts'
import { requireThread } from './access.ts'
import { authorized } from './reach.ts'

/** Only attachment bytes remain on HTTP; conversations and sending use the product RPC socket. */
const Params = Schema.Struct({
  threadId: RuntimeAttachmentPath.fields.threadId,
  attachmentId: RuntimeAttachmentPath.fields.attachmentId,
})

const isRuntimeRejected = Schema.is(RuntimeRejected)
const isUnsupportedAttachment = Schema.is(UnsupportedAttachment)
const decodePictureType = Schema.decodeUnknownOption(PictureMediaType)
const refuse = (status: number, message: string) =>
  HttpServerResponse.jsonUnsafe({ error: { message } }, { status })

/** Authentication and Thread reach precede any runtime call; a revocation during it is checked again. */
const attachmentRead = Effect.fn('Gateway.attachment')(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const auth = yield* authenticate(new globalThis.Headers(Object.entries(request.headers)))
  const { threadId, attachmentId } = yield* HttpRouter.schemaPathParams(Params)
  const thread = yield* requireThread(threadId, auth.person.id)
  const response = yield* (yield* Runtime).attachment(thread.personId, thread.id, attachmentId)
  yield* sessionWorkspace(auth.person.id, auth.sessionId)
  yield* requireThread(thread.id, auth.person.id)
  const headers = yield* pictureHeaders(response.headers)
  const services = yield* Effect.context<Changes | Database>()
  return HttpServerResponse.stream(
    authorized(response.stream, thread, {
      personId: auth.person.id,
      sessionId: auth.sessionId,
    }).pipe(Stream.provideContext(services)),
    { status: 200, headers },
  )
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

/** Fixed outward errors never expose runtime tokens, private transport details or unsafe bytes. */
const answered = attachmentRead().pipe(
  observeFailures('http'),
  Effect.catch((error) =>
    Effect.succeed(
      isUnsupportedAttachment(error)
        ? HttpServerResponse.jsonUnsafe(
            { error: { _tag: error._tag, message: error.message } },
            { status: 400 },
          )
        : isRuntimeRejected(error)
          ? error.refusal.error === 'NotFound' || error.refusal.error === 'UnknownThread'
            ? refuse(404, 'Picture not found')
            : refuse(503, 'Vivid is unavailable right now')
          : refusalFor(error._tag),
    ),
  ),
)
const REFUSALS = new Map([
  ['Unauthenticated', refuse(401, 'Sign in to continue')],
  ['NotFound', refuse(404, 'Thread not found')],
  ['SchemaError', refuse(404, 'Thread not found')],
])
const refusalFor = (tag: string) => {
  const known = REFUSALS.get(tag)
  return known === undefined ? refuse(503, 'Vivid is unavailable right now') : known
}
export const gatewayRoutes = HttpRouter.add(
  'GET',
  '/api/vivid/:threadId/attachments/:attachmentId',
  answered,
)
