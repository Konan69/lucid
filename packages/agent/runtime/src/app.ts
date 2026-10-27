import * as NodeCrypto from 'node:crypto'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Harness } from '@earendil-works/pi-durable'
import {
  ConversationFrame,
  ConversationState,
  RuntimeAdmissionBody,
  RuntimeAdmissionReceipt,
  RuntimeAttachmentPath,
  RuntimeRefusal,
  RuntimeSettlement,
  RuntimeSettlementSearch,
  RuntimeStopped,
  RuntimeSubmissionPath,
  RuntimeThreadPath,
  type ThreadId,
} from '@vivid/contracts'
import { Effect, Layer, Option, Redacted, Schema, Stream } from 'effect'
import type * as HttpBody from 'effect/http/HttpBody'
import * as HttpRouter from 'effect/http/HttpRouter'
import type * as HttpServerError from 'effect/http/HttpServerError'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { admit } from './admission.ts'
import { runInputs } from './deliveries.ts'
import { Models } from './models.ts'
import { Persons } from './persons.ts'
import { isSubmissionId, settlement, submissionOf } from './response.ts'
import { RuntimeSettings } from './settings.ts'
import { frames, whole } from './state/link.ts'
import { picture } from './state/pictures.ts'
import type { StoreUnavailable } from './storage/errors.ts'
import { conversationOf, pi, type PiRejected, type ThreadUnknown } from './threads.ts'

/** The caller did not present the runtime token. */
class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  'Unauthorized',
  {},
  { title: 'Runtime token missing or wrong' },
) {}
/** The route and the body disagree about which Thread or whose it is. */
class WrongThread extends Schema.TaggedError<WrongThread>()(
  'WrongThread',
  {},
  { title: 'Delivery names another Thread or Person' },
) {}
/** The Thread has no conversation in this Person's store. */
class UnknownThread extends Schema.TaggedError<UnknownThread>()(
  'UnknownThread',
  {},
  { title: 'Thread has no conversation here' },
) {}
/** The number names no delivery of this Thread. */
class UnknownSubmission extends Schema.TaggedError<UnknownSubmission>()(
  'UnknownSubmission',
  {},
  { title: 'Submission is not of this Thread' },
) {}

const refuse = (error: RuntimeRefusal['error'], status: number) =>
  HttpServerResponse.schemaJson(RuntimeRefusal)({ error }, { status })

/**
 * The runtime token protects every route but `/health`. The application server is the only
 * holder: no browser, phone or desktop app talks to this process; they talk to the server's
 * gateway, which checks who they are and whether they may see the Thread before it forwards
 * anything here. The comparison takes the same time whatever the supplied value is.
 */
const authorize = Effect.fn('Runtime.authorize')(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const settings = yield* RuntimeSettings
  const supplied = Buffer.from(
    Option.getOrElse(Option.fromUndefinedOr(request.headers.authorization), () => ''),
  )
  const expected = Buffer.from(`Bearer ${Redacted.value(settings.token)}`)
  if (supplied.length !== expected.length || !NodeCrypto.timingSafeEqual(supplied, expected))
    return yield* new Unauthorized()
  return yield* Effect.void
})

/**
 * Every refusal has one status and one tag; a cause never crosses, because a schema issue or a
 * storage error can quote the request it failed on.
 *
 * - 400: the request is not one the runtime can read, or names the wrong Thread or Person.
 * - 404: nothing by that name here.
 * - 503: this Person's conversations could not be opened or failed while in use. The delivery may
 *   or may not be held; the same request again, with the same key, finds out.
 */
const unavailable = (tag: string) =>
  Effect.logError('Runtime request failed', tag).pipe(Effect.andThen(refuse('Unavailable', 503)))

const answered = <R>(
  handler: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    | Unauthorized
    | WrongThread
    | UnknownThread
    | UnknownSubmission
    | ThreadUnknown
    | PiRejected
    | StoreUnavailable
    | Schema.SchemaError
    | HttpServerError.HttpServerError
    | HttpBody.HttpBodyError,
    R
  >,
) =>
  handler.pipe(
    Effect.catchTags({
      Unauthorized: () => refuse('Unauthorized', 401),
      SchemaError: () => refuse('InvalidRequest', 400),
      HttpServerError: () => refuse('InvalidRequest', 400),
      WrongThread: () => refuse('WrongThread', 400),
      UnknownThread: () => refuse('UnknownThread', 404),
      ThreadUnknown: () => refuse('UnknownThread', 404),
      UnknownSubmission: () => refuse('UnknownSubmission', 404),
      PiRejected: () => unavailable('PiRejected'),
      StoreUnavailable: () => unavailable('StoreUnavailable'),
    }),
    // Encoding one of the fixed bodies above cannot fail; this names what is sent if it ever does.
    Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 500 })),
  )

/**
 * Admit one delivery. The body is the contract the server encodes with, so the two cannot drift.
 * It must name the route's Thread, and the route's Person must be the Thread's creator: a Thread
 * lives in its creator's store and nowhere else, so a mismatch is refused before any store
 * is touched.
 */
const admission = Effect.fn('Runtime.admission')(function* () {
  yield* authorize()
  const path = yield* HttpRouter.schemaPathParams(RuntimeThreadPath)
  const body = yield* HttpServerRequest.schemaBodyJson(RuntimeAdmissionBody)
  if (body.threadId !== path.threadId || body.initialData.creator !== path.personId)
    return yield* new WrongThread()
  const persons = yield* Persons
  const receipt = yield* persons.use(path.personId, (person) => admit(person, body))
  return yield* HttpServerResponse.schemaJson(RuntimeAdmissionReceipt)(receipt, { status: 202 })
})

/**
 * Stop whatever is in progress in a Thread. Pi's `Conversation.abort()` withdraws queued inputs,
 * aborts every task of the current work and resolves once the conversation is idle. `aborted`
 * says whether there was a response to stop, as Flue's abort answered.
 */
const stop = Effect.fn('Runtime.stop')(function* () {
  yield* authorize()
  const path = yield* HttpRouter.schemaPathParams(RuntimeThreadPath)
  const persons = yield* Persons
  const aborted = yield* persons.use(path.personId, ({ harness }) =>
    stopThread(harness, path.threadId),
  )
  return yield* HttpServerResponse.schemaJson(RuntimeStopped)({ aborted })
})

/** A Thread with no conversation has nothing to stop; one that is idle is aborted to no effect. */
const stopThread = Effect.fn('Runtime.stopThread')(function* (
  harness: Harness,
  threadId: ThreadId,
) {
  const conversation = yield* conversationOf(harness, threadId)
  if (Option.isNone(conversation)) return false
  const busy = (yield* runInputs(harness, conversation.value.id)).length > 0
  yield* pi(() => conversation.value.abort(BACKGROUND_CONTEXT))
  return busy
})

/** How long a waiting settlement read is held before it answers `Pending` and the caller asks again. */
const WAIT = '25 seconds'

/**
 * The committed status of one submission. With `?wait` the request is held until the submission
 * settles, the caller goes away, or the bound passes; whichever ends the wait ends only the
 * wait. The Person's conversations stay open while a caller is waiting on them.
 */
const settled = Effect.fn('Runtime.settled')(function* () {
  yield* authorize()
  const path = yield* HttpRouter.schemaPathParams(RuntimeSubmissionPath)
  const search = yield* HttpServerRequest.schemaSearchParams(RuntimeSettlementSearch)
  const persons = yield* Persons
  const outcome = yield* persons.use(path.personId, ({ harness }) =>
    readSettlement(harness, path, search.wait !== undefined),
  )
  return yield* HttpServerResponse.schemaJson(RuntimeSettlement)(outcome)
})

/** Find the submission through its Thread, then read or wait for its settlement. */
const readSettlement = Effect.fn('Runtime.readSettlement')(function* (
  harness: Harness,
  path: RuntimeSubmissionPath,
  wait: boolean,
) {
  const conversation = yield* conversationOf(harness, path.threadId)
  if (Option.isNone(conversation)) return yield* new UnknownThread()
  if (!isSubmissionId(path.submissionId)) return yield* new UnknownSubmission()
  const submission = yield* submissionOf(harness, conversation.value.id, path.submissionId)
  if (Option.isNone(submission)) return yield* new UnknownSubmission()
  if (!wait) return yield* settlement(harness, submission.value, false)
  return yield* settlement(harness, submission.value, true).pipe(
    Effect.timeoutOption(WAIT),
    Effect.map(Option.getOrElse(() => RuntimeSettlement.cases.Pending.make({}))),
  )
})

const encodeFrame = Schema.encodeEffect(
  Schema.fromJsonString(Schema.toCodecJson(ConversationFrame)),
)

/** A comment line: Server-Sent Events readers ignore it, and its arrival says the link is alive. */
const HEARTBEAT = ': alive\n\n'

/**
 * The state link as Server-Sent Events: one frame per event, encoded by the contract's schema.
 * The heartbeat is merged in and ends with the frames, so a link the runtime has ended is seen
 * to end.
 */
const stateEvents = (persons: Effect.Success<typeof Persons>, path: RuntimeThreadPath) =>
  frames(persons, path.personId, path.threadId).pipe(
    Stream.mapEffect((frame) => encodeFrame(frame)),
    Stream.map((json) => `data: ${json}\n\n`),
    Stream.merge(Stream.tick('15 seconds').pipe(Stream.drop(1), Stream.as(HEARTBEAT)), {
      haltStrategy: 'left',
    }),
    Stream.encodeText,
  )

/**
 * One Thread's conversation as a screen reads it. A caller that asks for an event stream gets
 * the link (`state/link.ts`): the whole state, then its changes, until it goes away. Any other
 * caller gets the whole state once as JSON, which is what the server's own readers need.
 */
const state = Effect.fn('Runtime.state')(function* () {
  yield* authorize()
  const path = yield* HttpRouter.schemaPathParams(RuntimeThreadPath)
  const request = yield* HttpServerRequest.HttpServerRequest
  const persons = yield* Persons
  const accept = request.headers.accept
  if (accept !== undefined && accept.includes('text/event-stream'))
    return HttpServerResponse.stream(stateEvents(persons, path), {
      contentType: 'text/event-stream',
      headers: { 'cache-control': 'no-store' },
    })
  const current = yield* persons.use(path.personId, ({ harness }) => whole(harness, path.threadId))
  return yield* HttpServerResponse.schemaJson(ConversationState)(current)
})

/** The bytes of one picture, or nothing by that name in this Thread. */
const attachment = Effect.fn('Runtime.attachment')(function* () {
  yield* authorize()
  const path = yield* HttpRouter.schemaPathParams(RuntimeAttachmentPath)
  const persons = yield* Persons
  const found = yield* persons.use(path.personId, ({ harness }) =>
    Effect.gen(function* () {
      const conversation = yield* conversationOf(harness, path.threadId)
      if (Option.isNone(conversation)) return yield* new UnknownThread()
      return yield* picture(conversation.value, path.attachmentId)
    }),
  )
  if (Option.isNone(found)) return yield* refuse('NotFound', 404)
  return HttpServerResponse.uint8Array(found.value.bytes, {
    contentType: found.value.mediaType,
    headers: { 'cache-control': 'private, max-age=31536000, immutable' },
  })
})

/** Open to anyone, as it has been: a liveness answer that names the selected model and no secret. */
const health = Effect.fn('Runtime.health')(function* () {
  const models = yield* Models
  return yield* HttpServerResponse.json({
    model: models.name,
    service: 'vivid-agent-runtime',
    status: 'ok',
  })
})

const THREAD = '/persons/:personId/threads/:threadId'

/** The whole HTTP surface. Anything else is refused the same way whether or not it exists. */
export const routes = Layer.mergeAll(
  HttpRouter.add('GET', '/health', answered(health())),
  HttpRouter.add('POST', THREAD, answered(admission())),
  HttpRouter.add('POST', `${THREAD}/abort`, answered(stop())),
  HttpRouter.add('GET', `${THREAD}/submissions/:submissionId`, answered(settled())),
  HttpRouter.add('GET', `${THREAD}/state`, answered(state())),
  HttpRouter.add('GET', `${THREAD}/attachments/:attachmentId`, answered(attachment())),
  HttpRouter.add('*', '/*', answered(authorize().pipe(Effect.andThen(refuse('NotFound', 404))))),
)
