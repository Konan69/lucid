import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import * as Headers from 'effect/unstable/http/Headers'
import * as HttpRouter from 'effect/unstable/http/HttpRouter'
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import { Conflict, ThreadId, type PersonId } from '@vivid/contracts'
import { authenticate } from '../auth/session.ts'
import { Runtime } from '../runtime/client.ts'
import { Database } from '../database/client.ts'
import { Changes, Topic } from '../live/changes.ts'
import { canSee, findThread, requireThread, type StoredThread } from './access.ts'
import { Conversation, DeliveryMessage, StoredRunOrigin } from './conversation.ts'

/**
 * The conversation gateway: the only way any client reaches Flue.
 *
 * Flue's own routes are protected by one runtime token that carries no identity. The server
 * therefore keeps that token to itself and re-publishes the four things a client does with a
 * conversation under `/api/vivid/:threadId`, each behind the same two checks: who is asking (a
 * session), and whether they may see this Thread. A Thread the Person may not see answers 404,
 * exactly like one that does not exist.
 *
 * - `POST   …`               send a message; starts a Run attributed to the sender
 * - `GET    …?view=…`        history, or the live updates stream, passed through as it comes
 * - `GET    …/attachments/…` one attachment's bytes
 * - `POST   …/abort`         stop what is in progress
 *
 * The shapes on the wire are Flue's, so the Flue client in the browser, on a phone and in the
 * desktop app talks to this address without knowing the server is in between.
 */

const Params = Schema.Struct({ threadId: ThreadId })

/** What a client may send: its own words. Signals are the server's to deliver, never a client's. */
const Sent = Schema.Struct({
  kind: Schema.Literal('user'),
  body: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(100_000)),
  idempotencyKey: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
})

const decodeSent = Schema.decodeUnknownEffect(Sent)

const refuse = (status: number, message: string) =>
  HttpServerResponse.jsonUnsafe({ error: { message } }, { status })

/** The Person asking and the Thread they named, or the refusal to answer with. */
const admitted = Effect.fn('Gateway.admitted')(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const auth = yield* authenticate(new globalThis.Headers(Object.entries(request.headers)))
  const { threadId } = yield* HttpRouter.schemaPathParams(Params)
  const thread = yield* requireThread(threadId, auth.person.id)
  return { request, person: auth.person, thread }
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

/**
 * Preserves a busy-Thread Conflict's displayable message for every client of this gateway.
 * Other failures use fixed refusals, keeping database and runtime details private.
 */
const answered = <R>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, { readonly _tag: string }, R>,
) =>
  effect.pipe(
    Effect.catch((error) =>
      Effect.succeed(isConflict(error) ? refuse(409, error.message) : refusalFor(error._tag)),
    ),
  )

/**
 * The address this client used to reach the server, so the stream address handed back points to
 * the same place. A phone on the local network and a browser on the same machine reach one server
 * by different names; a configured public address would be right for only one of them.
 */
const originOf = (headers: Headers.Headers) => {
  const host = Option.orElse(Headers.get(headers, 'x-forwarded-host'), () =>
    Headers.get(headers, 'host'),
  )
  const scheme = Option.getOrElse(Headers.get(headers, 'x-forwarded-proto'), () => 'http')
  // The client follows this address with its credentials, so it is only ever built from a plain
  // host name and one of the two schemes a browser would use to reach us.
  return Option.filter(
    Option.map(host, (name) => `${scheme}://${name}`),
    () => SCHEMES.has(scheme) && Option.exists(host, (name) => HOST.test(name)),
  )
}

const SCHEMES = new Set(['http', 'https'])
const HOST = /^[a-z0-9.-]+(?::\d{1,5})?$|^\[[0-9a-f:]+\](?::\d{1,5})?$/iu

const send = Effect.fn('Gateway.send')(function* () {
  const { request, person, thread } = yield* admitted()
  const sent = yield* decodeSent(yield* request.json).pipe(Effect.option)
  if (Option.isNone(sent)) return refuse(400, 'A message needs text')
  const origin = originOf(request.headers)
  if (Option.isNone(origin)) return refuse(400, 'The request has no host')
  const conversation = yield* Conversation
  const receipt = yield* conversation.admit({
    threadId: thread.id,
    personId: person.id,
    message: DeliveryMessage.cases.Said.make({ body: sent.value.body }),
    origin: StoredRunOrigin.cases.Message.make({}),
    idempotencyKey:
      sent.value.idempotencyKey === undefined ? crypto.randomUUID() : sent.value.idempotencyKey,
  })
  const streamUrl = `${origin.value}/api/vivid/${encodeURIComponent(thread.id)}`
  return HttpServerResponse.jsonUnsafe(
    {
      streamUrl,
      offset: receipt.offset,
      submissionId: receipt.runId,
      uid: receipt.incarnation,
    },
    { status: 202, headers: { location: streamUrl, 'stream-next-offset': receipt.offset } },
  )
})

/** Headers that describe one hop's connection and must not be copied onto the next. */
const HOP_HEADERS = ['connection', 'keep-alive', 'transfer-encoding', 'content-length']

/**
 * Completes when the Person can no longer see the Thread. A live read is a connection that stays
 * open for as long as the Thread is on screen; being allowed to open it is not being allowed to
 * keep it. Every time the Thread, the Person or their Company changes, access is asked again, and
 * the first "no" (or a Thread that is gone) ends the stream.
 */
const accessLost = Effect.fn('Gateway.accessLost')(function* (
  thread: StoredThread,
  personId: PersonId,
) {
  const changes = yield* Changes
  const topics = [Topic.thread(thread.id), Topic.person(personId)]
  const moved = yield* changes.subscribe(
    thread.companyId === null ? topics : [...topics, Topic.company(thread.companyId)],
  )
  const stillSees = findThread(thread.id).pipe(
    Effect.flatMap((found) =>
      Option.isNone(found) ? Effect.succeed(false) : canSee(found.value, personId),
    ),
    Effect.catch(() => Effect.succeed(false)),
  )
  yield* moved.pipe(
    Stream.mapEffect(() => stillSees),
    Stream.filter((sees) => !sees),
    Stream.take(1),
    Stream.runDrain,
  )
})

const read = (suffix: (params: { readonly attachmentId: string }) => string) =>
  Effect.fn('Gateway.read')(function* () {
    const { request, person, thread } = yield* admitted()
    const params = yield* HttpRouter.params
    const attachmentId = params.attachmentId
    const runtime = yield* Runtime
    const services = yield* Effect.context<Changes | Database>()
    const response = yield* runtime.read({
      threadId: thread.id,
      suffix: attachmentId === undefined ? '' : suffix({ attachmentId }),
      search: new URL(request.url, 'http://gateway').search,
      accept: Option.getOrElse(Headers.get(request.headers, 'accept'), () => '*/*'),
    })
    const until = accessLost(thread, person.id).pipe(Effect.scoped, Effect.provideContext(services))
    return HttpServerResponse.stream(Stream.interruptWhen(response.stream, until), {
      status: response.status,
      headers: HOP_HEADERS.reduce(Headers.remove, response.headers),
    })
  })

const stop = Effect.fn('Gateway.stop')(function* () {
  const { thread } = yield* admitted()
  const runtime = yield* Runtime
  return HttpServerResponse.jsonUnsafe({ aborted: yield* runtime.stop(thread.id) })
})

const conversationRead = read(() => '')
const attachmentRead = read(
  ({ attachmentId }) => `/attachments/${encodeURIComponent(attachmentId)}`,
)

export const gatewayRoutes = Layer.mergeAll(
  HttpRouter.add('POST', '/api/vivid/:threadId', answered(send())),
  HttpRouter.add('GET', '/api/vivid/:threadId', answered(conversationRead())),
  HttpRouter.add(
    'GET',
    '/api/vivid/:threadId/attachments/:attachmentId',
    answered(attachmentRead()),
  ),
  HttpRouter.add('POST', '/api/vivid/:threadId/abort', answered(stop())),
)
