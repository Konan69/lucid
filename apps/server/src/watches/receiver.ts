import * as NodeCrypto from 'node:crypto'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import * as HttpRouter from 'effect/http/HttpRouter'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import {
  CheckinArming,
  CheckinRead,
  SignalCue,
  ThreadId,
  TimerOperationKey,
  WatchId,
  WatchPurpose,
  WatchState,
} from '@vivid/contracts'
import { ServerConfig } from '../config.ts'
import { Changes, Topic } from '../live/changes.ts'
import { observeFailures } from '../observability/failure.ts'
import {
  Conversation,
  DeliveryMessage,
  DeliverySpeaker,
  StoredRunOrigin,
} from '../threads/conversation.ts'
import { ThreadStore } from '../threads/store.ts'
import { secretFor, verify } from './signature.ts'
import { WatchStore, type WatchRecord } from './store.ts'
import { Watches } from './lifecycle.ts'
import { WatchedApps } from './apps.ts'

/**
 * Where Executor delivers a Watch's events: `POST /api/watches/:id`.
 *
 * Executor POSTs two kinds of signed request to a subscription's callback
 * (executor@2.0.0-beta.23 `packages/sdk/src/implementation/events.ts`): before it saves a
 * subscription, `{"type":"verification","challenge"}`, which must be echoed as
 * `{"challenge"}` with a 2xx (`verify`); then each event as
 * `{eventId,name,timestamp,data,cursor}`, which a 2xx acknowledges. Deliveries are at least once,
 * retried with backoff for about four and a half hours, and only 410 and 413 end one for good.
 *
 * The signature is the only authority here: the Watch's secret is derived from the server's own
 * secret, so a request that verifies came from Executor for this Watch.
 */

/** The largest body Executor sends: one event, signed (`defaultEventDeliveryLimits.maxBodyBytes`). */
const MAX_BODY_BYTES = 256 * 1024

class WatchBodyTooLarge extends Schema.TaggedError<WatchBodyTooLarge>()(
  'WatchBodyTooLarge',
  {},
  { title: 'Watch body too large' },
) {}
/** The callback path does not contain a valid Watch identifier. */
class WatchUnknown extends Schema.TaggedError<WatchUnknown>()(
  'WatchUnknown',
  {},
  { title: 'Watch unknown' },
) {}
class WatchUnsigned extends Schema.TaggedError<WatchUnsigned>()(
  'WatchUnsigned',
  {},
  { title: 'Watch unsigned' },
) {}
/** A verified request for a stopped or deleted Watch ends that delivery at Executor for good. */
class WatchGone extends Schema.TaggedError<WatchGone>()('WatchGone', {}, { title: 'Watch gone' }) {}
class WatchNotArmed extends Schema.TaggedError<WatchNotArmed>()(
  'WatchNotArmed',
  {},
  { title: 'Watch not armed' },
) {}
class WatchBodyInvalid extends Schema.TaggedError<WatchBodyInvalid>()(
  'WatchBodyInvalid',
  {},
  { title: 'Watch body invalid' },
) {}

/** The two bodies Executor sends, decoded at ingress. */
const Verification = Schema.Struct({
  type: Schema.Literal('verification'),
  challenge: Schema.String,
})
const WatchEvent = Schema.Struct({
  eventId: Schema.NonEmptyString,
  name: Schema.String,
  timestamp: Schema.String,
  data: Schema.Json,
})
type WatchEvent = typeof WatchEvent.Type
const Body = Schema.Union([Verification, WatchEvent])
const decodeTimerKey = Schema.decodeUnknownOption(
  Schema.Struct({ operationKey: TimerOperationKey }),
)
const decodeBody = Schema.decodeUnknownEffect(Schema.fromJsonString(Body))
const isVerification = Schema.is(Verification)
const decodeId = Schema.decodeUnknownEffect(WatchId.check(Schema.isNonEmpty()))

/** Bound bytes while reading the stream, then decode once. */
const readBody = Effect.fn('Http.Watch.readBody')(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  const chunks: Array<Uint8Array> = []
  const length = yield* Stream.runFoldEffect(
    request.stream,
    () => 0,
    (previous, chunk) => {
      const next = previous + chunk.byteLength
      if (next > MAX_BODY_BYTES) return Effect.fail(new WatchBodyTooLarge({}))
      chunks.push(chunk)
      return Effect.succeed(next)
    },
  )
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
})

/**
 * The background Thread one event wakes Vivid in. Derived from the Watch and the event id,
 * so a redelivery lands in the same Thread; hashed, because an event id is the app's own text.
 * The `watch-` prefix is reserved: a client cannot create a Thread with it (`threads/store.ts`).
 */
export const threadOf = (watch: WatchId, eventId: string) =>
  ThreadId.make(
    `watch-${NodeCrypto.createHash('sha256').update(`${watch}\n${eventId}`).digest('hex').slice(0, 32)}`,
  )

/**
 * Wake Vivid for one event. The stable Thread and idempotency key select Conversation's
 * durable admission receipt, both while a Run is working and after it has finished.
 */
const wake = Effect.fn('Http.Watch.wake')(function* (record: WatchRecord, event: WatchEvent) {
  const watch = record.watch
  const thread = yield* (yield* ThreadStore).ensureBackground({
    id: threadOf(watch.id, event.eventId),
    title: watch.name,
    // The Watch's own name, given by its owner, never a title the model should replace.
    titleSource: 'Assigned',
    personId: record.personId,
    companyId: record.companyId,
  })
  const delivered = yield* deliveryOf(record, event)
  const run = yield* (yield* Conversation).deliver({
    // A Watch is the Person's own standing request, delivered as theirs.
    speaker: DeliverySpeaker.cases.Acting.make({}),
    threadId: thread.id,
    personId: record.personId,
    // The event goes to the runtime whole; the runtime words it for the model (`delivery.ts`).
    message: DeliveryMessage.cases.Signal.make({ cue: delivered.cue }),
    origin: delivered.origin,
    idempotencyKey: `watch:${watch.id}:${event.eventId}`,
  })
  // A check-in whose open work has ended completes here, bound to the Run that was told so.
  if (Option.isSome(delivered.closed))
    yield* (yield* Watches).finishCheckin(record, run.id, delivered.closed.value)
  yield* (yield* Changes).publish([Topic.person(record.personId)])
})

/**
 * What one event says to Vivid and what its Run records. An event Watch passes the event whole.
 * A check-in instead carries the server's fresh read of the open work it follows, so Vivid acts
 * on product records rather than on the timer's payload, and says whether that work has ended.
 */
const deliveryOf = Effect.fn('Http.Watch.delivery')(function* (
  record: WatchRecord,
  event: WatchEvent,
) {
  const watch = record.watch
  if (!WatchPurpose.guards.Checkin(watch.purpose))
    return {
      cue: SignalCue.cases.Watch.make({
        name: watch.name,
        event: watch.event,
        occurredAt: event.timestamp,
        instruction: watch.instruction,
        condition: watch.condition,
        data: event.data,
      }),
      // The Run keeps which Watch and which event, so a card it posts can say what caused it.
      origin: StoredRunOrigin.cases.Watch.make({
        watchId: watch.id,
        watchName: watch.name,
        eventId: event.eventId,
        event: watch.event,
        occurredAt: event.timestamp,
      }),
      closed: Option.none<string>(),
    }
  const reading = yield* (yield* Watches).readCheckin(record, watch.purpose)
  return {
    cue: SignalCue.cases.Checkin.make({
      name: watch.name,
      occurredAt: event.timestamp,
      instruction: watch.instruction,
      timing: watch.purpose.timing,
      operationKey: watch.purpose.arming.operationKey,
      reading,
      condition: watch.condition,
    }),
    origin: StoredRunOrigin.cases.Checkin.make({
      watchId: watch.id,
      watchName: watch.name,
      eventId: event.eventId,
    }),
    closed: CheckinRead.match(reading, {
      Open: () => Option.none<string>(),
      Closed: ({ evidence }) => Option.some(evidence),
    }),
  }
})

/** Ignore old timer operations and retry a matching event until its actual receipt arrives. */
const acceptsTimer = Effect.fn('Http.Watch.acceptsTimer')(function* (
  record: WatchRecord,
  decoded: WatchEvent,
) {
  if (!WatchPurpose.guards.Checkin(record.watch.purpose)) return true
  const key = decodeTimerKey(decoded.data)
  if (Option.isNone(key) || key.value.operationKey !== record.watch.purpose.arming.operationKey)
    return false
  if (CheckinArming.guards.Awaiting(record.watch.purpose.arming))
    return yield* new WatchNotArmed({})
  return true
})

/** Verify, then answer the challenge or wake Vivid. */
const accept = Effect.fn('Http.Watch.accept')(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const route = yield* HttpRouter.RouteContext
  const id = yield* decodeId(route.params.id).pipe(Effect.mapError(() => new WatchUnknown({})))
  const body = yield* readBody(request)
  const headers = request.headers
  const signed = {
    id: headers['webhook-id'],
    timestamp: headers['webhook-timestamp'],
    signatures: headers['webhook-signature'],
  }
  if (signed.id === undefined || signed.timestamp === undefined || signed.signatures === undefined)
    return yield* new WatchUnsigned({})
  const secret = secretFor((yield* ServerConfig).AUTH_SECRET, id)
  const now = yield* Clock.currentTimeMillis
  if (
    !verify(
      secret,
      { id: signed.id, timestamp: signed.timestamp, signatures: signed.signatures, body },
      now,
    )
  )
    return yield* new WatchUnsigned({})
  const found = yield* (yield* WatchStore).find(id)
  if (Option.isNone(found)) return yield* new WatchGone({})
  const record = found.value
  if (WatchState.isAnyOf(['Stopped', 'Completed'])(record.watch.state))
    return yield* new WatchGone({})
  const decoded = yield* decodeBody(body).pipe(Effect.mapError(() => new WatchBodyInvalid({})))
  if (isVerification(decoded))
    return HttpServerResponse.jsonUnsafe({ challenge: decoded.challenge }, { status: 200 })
  // Retired subscription callbacks are acknowledged without waking Vivid after a revision.
  if (new URL(request.url, record.callbackUrl).search !== new URL(record.callbackUrl).search)
    return HttpServerResponse.jsonUnsafe({ received: true }, { status: 200 })
  if (WatchState.guards.Paused(record.watch.state))
    return HttpServerResponse.jsonUnsafe({ received: true }, { status: 200 })
  if (yield* (yield* WatchedApps).needsAuthorization(record.connectionId)) {
    yield* (yield* Watches).connectionChanged(record.connectionId)
    return HttpServerResponse.jsonUnsafe({ received: true }, { status: 200 })
  }
  if (!(yield* acceptsTimer(record, decoded)))
    return HttpServerResponse.jsonUnsafe({ received: true }, { status: 200 })
  yield* wake(record, decoded)
  return HttpServerResponse.jsonUnsafe({ received: true }, { status: 200 })
})

/** A status with no detail; Executor reads only the status of a delivery. */
const status = (code: number) => Effect.succeed(HttpServerResponse.empty({ status: code }))

/**
 * Typed failures map at the boundary. Anything that should be tried again (the database, the
 * runtime, a Thread busy with another Run) answers 5xx or 409, which Executor retries; only a
 * stopped or deleted Watch answers 410, which ends that delivery.
 */
export const watchRoutes = HttpRouter.add(
  'POST',
  '/api/watches/:id',
  accept().pipe(
    observeFailures('http'),
    Effect.catchTags({
      WatchNotArmed: () => status(503),
      WatchUnknown: () => status(404),
      WatchUnsigned: () => status(401),
      WatchGone: () => status(410),
      WatchBodyTooLarge: () => status(413),
      WatchBodyInvalid: () => status(400),
      HttpServerError: () => status(400),
      Conflict: () => status(409),
      RuntimeUnavailable: () => status(503),
      NotFound: () => status(500),
      DatabaseFailure: () => status(500),
      DatabaseUnavailable: () => status(503),
      DatabaseConstraintViolation: () => status(500),
    }),
  ),
)
