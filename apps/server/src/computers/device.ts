import * as NodeCrypto from 'node:crypto'
import { and, eq, gt } from 'drizzle-orm'
import {
  Clock,
  Context,
  Deferred,
  Effect,
  Layer,
  Option,
  Queue,
  Schema,
  Semaphore,
  Scope,
  Stream,
} from 'effect'
import {
  BrowseOutcome,
  DeviceAnswer,
  DeviceRequest,
  DeviceRequestId,
  Forbidden,
  NoDeviceConnected,
  type AnswerDeviceRequest,
  type BrowserAction,
  type PersonId,
  type SessionId,
  type ThreadId,
} from '@vivid/contracts'
import { Database, type DatabaseInfrastructureError } from '../database/client.ts'
import { deviceRequests } from './tables.ts'

/** Durable state never returns to dispatchable; unanswered dispatches remain uncertain after restart. */
export const DeviceReceipt = Schema.TaggedUnion({
  Dispatched: {},
  Answered: { answer: DeviceAnswer },
  OutcomeUnknown: {},
})
const encodeRequest = Schema.encodeSync(DeviceRequest)
const encodeReceipt = Schema.encodeSync(DeviceReceipt)
const SubscriptionId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('DeviceSubscriptionId'),
)

interface Subscription {
  readonly id: typeof SubscriptionId.Type
  readonly sessionId: SessionId
  readonly requests: Queue.Queue<DeviceRequest>
  readonly closed: Deferred.Deferred<void>
}
interface Pending {
  readonly subscription: Subscription
  readonly answer: Deferred.Deferred<DeviceAnswer>
}
interface DeviceService {
  readonly requireConnected: (personId: PersonId) => Effect.Effect<void, NoDeviceConnected>
  readonly watch: (
    personId: PersonId,
    sessionId: SessionId,
  ) => Effect.Effect<Stream.Stream<DeviceRequest>, never, Scope.Scope>
  readonly browse: (input: {
    readonly personId: PersonId
    readonly threadId: Option.Option<ThreadId>
    readonly action: BrowserAction
  }) => Effect.Effect<BrowseOutcome, NoDeviceConnected | DatabaseInfrastructureError>
  readonly answer: (
    personId: PersonId,
    sessionId: SessionId,
    input: AnswerDeviceRequest,
  ) => Effect.Effect<void, Forbidden | DatabaseInfrastructureError>
}

/**
 * Vivid-only deviation: Codex's model loop and helper are local (helper_transport.js::H.request).
 * Vivid's model Run is on the server, so this minimal authenticated subscription carries a request
 * and its receipt. It does not implement native access grants or replace the reference dispatcher.
 */
export class Device extends Context.Service<Device, DeviceService>()('vivid/Device') {}

/** Native refusals are final receipts; unknown is reserved for delivery whose answer was lost. */
const outcome = (answer: DeviceAnswer): BrowseOutcome =>
  DeviceAnswer.match<BrowseOutcome>(answer, {
    Done: ({ result }) => BrowseOutcome.cases.Completed.make({ result }),
    Refused: ({ reason }) =>
      BrowseOutcome.cases.Unavailable.make({
        reason: `Your browser refused this action: ${reason}.`,
      }),
    Failed: () =>
      BrowseOutcome.cases.Unavailable.make({
        reason: 'Your browser could not complete this action.',
      }),
  })

/** Subscription lifetime is the only presence signal; no device identifier is supplied by callers. */
const makePresence = (subscriptions: Map<PersonId, Set<Subscription>>) => {
  /** A queue belongs to one subscription, never a Person-wide broadcast that could drive two devices. */
  const subscribe = Effect.fn('Device.subscribe')(function* (
    personId: PersonId,
    sessionId: SessionId,
  ) {
    const subscription: Subscription = {
      id: SubscriptionId.make(NodeCrypto.randomUUID()),
      sessionId,
      requests: yield* Queue.unbounded<DeviceRequest>(),
      closed: yield* Deferred.make<void>(),
    }
    const current = subscriptions.get(personId)
    if (current === undefined) subscriptions.set(personId, new Set([subscription]))
    else current.add(subscription)
    return subscription
  })

  /** Disconnect immediately ends presence and settles in-flight callers as uncertain; nothing is requeued. */
  const release = Effect.fn('Device.release')(function* (
    personId: PersonId,
    subscription: Subscription,
  ) {
    const current = subscriptions.get(personId)
    if (current !== undefined) {
      current.delete(subscription)
      if (current.size === 0) subscriptions.delete(personId)
    }
    yield* Deferred.succeed(subscription.closed, undefined)
    yield* Queue.shutdown(subscription.requests)
  })

  return { subscribe, release }
}

/** Persistence conditionally claims an answer once and never makes a dispatched row eligible again. */
const makeLedger = (database: Database['Service'], pending: Map<DeviceRequestId, Pending>) => {
  /** Cleanup covers timeout, disconnect and tool cancellation; a failed write leaves Dispatched, never replayable. */
  const retire = Effect.fn('Device.retire')(function* (id: DeviceRequestId) {
    pending.delete(id)
    yield* database
      .run(
        database
          .update(deviceRequests)
          .set({
            state: encodeReceipt(DeviceReceipt.cases.OutcomeUnknown.make({})),
            status: 'unknown',
          })
          .where(and(eq(deviceRequests.id, id), eq(deviceRequests.status, 'dispatched'))),
      )
      .pipe(
        Effect.catch(() =>
          Effect.logError('Device outcome could not be persisted; dispatch remains uncertain.'),
        ),
      )
  })

  /** A copied capability is insufficient: answers require the selected live subscription's signed-in session. */
  const answer = Effect.fn('Device.answer')(function* (
    personId: PersonId,
    sessionId: SessionId,
    input: AnswerDeviceRequest,
  ) {
    const ticket = pending.get(input.id)
    if (
      ticket === undefined ||
      ticket.subscription.sessionId !== sessionId ||
      (yield* Deferred.isDone(ticket.subscription.closed))
    )
      return yield* new Forbidden({
        message: 'This device request is no longer awaiting your answer',
      })
    const now = yield* Clock.currentTimeMillis
    const written = yield* database.run(
      database
        .update(deviceRequests)
        .set({
          status: 'answered',
          state: encodeReceipt(DeviceReceipt.cases.Answered.make({ answer: input.answer })),
        })
        .where(
          and(
            eq(deviceRequests.id, input.id),
            eq(deviceRequests.personId, personId),
            eq(deviceRequests.sessionId, sessionId),
            eq(deviceRequests.subscriptionId, ticket.subscription.id),
            eq(deviceRequests.status, 'dispatched'),
            gt(deviceRequests.expiresAt, now),
          ),
        )
        .returning({ id: deviceRequests.id }),
    )
    if (written.length !== 1)
      return yield* new Forbidden({
        message: 'This device request has expired or was already answered',
      })
    yield* Deferred.succeed(ticket.answer, input.answer)
    return undefined
  })
  return { retire, answer }
}

/** The deadline is not renewed by reconnect. Persist before publishing and persist answers before waking callers. */
export const deviceLayer = Layer.effect(
  Device,
  Effect.gen(function* () {
    const database = yield* Database
    const subscriptions = new Map<PersonId, Set<Subscription>>()
    const pending = new Map<DeviceRequestId, Pending>()
    const permit = yield* Semaphore.make(1)

    const presence = makePresence(subscriptions)
    const ledger = makeLedger(database, pending)
    /** Presence is a live subscription, not a durable device registration or the cloud Computer. */
    const requireConnected = Effect.fn('Device.requireConnected')(function* (personId: PersonId) {
      const connected = subscriptions.get(personId)
      if (connected === undefined || connected.size === 0)
        return yield* new NoDeviceConnected({ personId })
      return undefined
    })
    /** One global permit bounds server dispatch load; native serialization is a separate, blocked port. */
    const browse = Effect.fn('Device.browse')(
      function* (input: Parameters<DeviceService['browse']>[0]) {
        const available = subscriptions.get(input.personId)
        const subscription = available === undefined ? undefined : available.values().next().value
        if (subscription === undefined)
          return yield* new NoDeviceConnected({ personId: input.personId })
        const now = yield* Clock.currentTimeMillis
        const request = DeviceRequest.make({
          id: DeviceRequestId.make(NodeCrypto.randomUUID()),
          action: input.action,
          // Vivid-only hop deadline, not the reference's 10-second native request budget.
          expiresAt: now + 30_000,
        })
        const answer = yield* Deferred.make<DeviceAnswer>()
        yield* database.run(
          database.insert(deviceRequests).values({
            id: request.id,
            personId: input.personId,
            sessionId: subscription.sessionId,
            subscriptionId: subscription.id,
            threadId: Option.getOrNull(input.threadId),
            request: encodeRequest(request),
            expiresAt: request.expiresAt,
            status: 'dispatched',
            state: encodeReceipt(DeviceReceipt.cases.Dispatched.make({})),
          }),
        )
        return yield* Effect.gen(function* () {
          pending.set(request.id, { subscription, answer })
          // A departure during INSERT cannot grant a replacement subscription the old request.
          if (yield* Deferred.isDone(subscription.closed))
            return BrowseOutcome.cases.OutcomeUnknown.make({})
          yield* Queue.offer(subscription.requests, request)
          const received = yield* Deferred.await(answer).pipe(
            Effect.map(Option.some),
            Effect.raceFirst(
              Deferred.await(subscription.closed).pipe(Effect.as(Option.none<DeviceAnswer>())),
            ),
            Effect.timeoutOption(Math.max(0, request.expiresAt - (yield* Clock.currentTimeMillis))),
          )
          return Option.match(Option.flatten(received), {
            onNone: () => BrowseOutcome.cases.OutcomeUnknown.make({}),
            onSome: outcome,
          })
        }).pipe(Effect.ensuring(ledger.retire(request.id)))
      },
      (effect) => permit.withPermit(effect),
    )

    const watch = Effect.fn('Device.watch')(function* (personId: PersonId, sessionId: SessionId) {
      const subscription = yield* Effect.acquireRelease(
        presence.subscribe(personId, sessionId),
        (current) => presence.release(personId, current),
      )
      return Stream.fromQueue(subscription.requests)
    })
    return Device.of({ browse, answer: ledger.answer, watch, requireConnected })
  }),
)
