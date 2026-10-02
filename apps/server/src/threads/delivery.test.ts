import * as NodeCrypto from 'node:crypto'
import { describe, expect, it } from '@effect/vitest'
import { CompanyId, Conflict, PersonId, RunId, RunState, ThreadId } from '@vivid/contracts'
import { eq, inArray } from 'drizzle-orm'
import { Deferred, Effect, Fiber, Layer, Queue, Ref, Result } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import * as HttpRouter from 'effect/unstable/http/HttpRouter'
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest'
import { personTable, sessionTable } from '../auth/tables.ts'
import { companyTable, membershipTable } from '../companies/tables.ts'
import { Database } from '../database/client.ts'
import { testConfigLayer, testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { silentChangesLayer } from '../live/changes.ts'
import { silentLearningLayer } from '../memory/learn.ts'
import { Notifier } from '../notifications/notifier.ts'
import { Admission, Runtime, Settlement } from '../runtime/client.ts'
import { submissionId } from '../runtime/identity.ts'
import {
  Conversation,
  DeliveryMessage,
  StoredRunOrigin,
  type Delivery,
  type SignalDelivery,
} from './conversation.ts'
import { conversationLayer } from './delivery.ts'
import { gatewayRoutes } from './gateway.ts'
import { Presence } from './presence.ts'
import { RunStore, runStoreLayer, TurnReservation } from './runs.ts'
import { threadStoreLayer } from './store.ts'
import { threads } from './tables.ts'

const databaseLayer = runStoreLayer.pipe(Layer.provideMerge(testDatabaseLayer))

/** A real Company Thread gives both People access; cleanup is registered before any write. */
const fixture = Effect.fn('Delivery.test.fixture')(function* () {
  const database = yield* Database
  const ada = PersonId.make(NodeCrypto.randomUUID())
  const ben = PersonId.make(NodeCrypto.randomUUID())
  const companyId = CompanyId.make(NodeCrypto.randomUUID())
  const threadId = ThreadId.make(NodeCrypto.randomUUID())
  const token = NodeCrypto.randomUUID()
  yield* Effect.addFinalizer(() =>
    database.run(database.delete(threads).where(eq(threads.id, threadId))).pipe(
      Effect.andThen(
        database.run(database.delete(companyTable).where(eq(companyTable.id, companyId))),
      ),
      Effect.andThen(
        database.run(database.delete(personTable).where(inArray(personTable.id, [ada, ben]))),
      ),
      Effect.asVoid,
      Effect.catch(() => Effect.sync(() => expect.fail('Delivery fixture cleanup failed'))),
    ),
  )
  yield* database.run(
    database.insert(personTable).values([
      { id: ada, name: 'Ada', email: `${ada}@example.test` },
      { id: ben, name: 'Ben', email: `${ben}@example.test` },
    ]),
  )
  yield* database.run(
    database.insert(companyTable).values({ id: companyId, name: 'Delivery test', slug: companyId }),
  )
  yield* database.run(
    database.insert(membershipTable).values(
      [ada, ben].map((userId) => ({
        id: NodeCrypto.randomUUID(),
        companyId,
        userId,
        role: 'member',
      })),
    ),
  )
  yield* database.run(
    database.insert(threads).values({
      id: threadId,
      personId: ada,
      companyId,
      audience: 'company',
      title: 'Delivery test',
      updatedAt: 0,
    }),
  )
  yield* database.run(
    database.insert(sessionTable).values({
      id: NodeCrypto.randomUUID(),
      token,
      userId: ben,
      expiresAt: new Date('2100-01-01'),
    }),
  )
  return { ada, ben, threadId, token }
})

type RuntimeInput = Parameters<Runtime['Service']['admit']>[0]

/** Control only the external runtime: the server's actual admission, SQL locks and observers run. */
const runtimeFixture = Effect.fn('Delivery.test.runtime')(function* () {
  const admitted = yield* Ref.make<ReadonlyArray<RuntimeInput>>([])
  const requests = yield* Ref.make<ReadonlyArray<RuntimeInput>>([])
  const settlements = new Map<RunId, Deferred.Deferred<Settlement>>()
  const runtime = Runtime.of({
    admit: Effect.fn('Delivery.test.admit')(function* (input) {
      const id = submissionId(input.threadId, input.idempotencyKey)
      yield* Ref.update(requests, (all) => [...all, input])
      const repeated = settlements.has(id)
      if (!repeated) {
        settlements.set(id, yield* Deferred.make<Settlement>())
        yield* Ref.update(admitted, (all) => [...all, input])
      }
      return Admission.make({
        runId: id,
        offset: repeated ? '-1' : String(input.turn),
        incarnation: 'test',
        repeated,
      })
    }),
    settled: Effect.fn('Delivery.test.settled')(function* (_threadId, id) {
      const settlement = settlements.get(id)
      // Other integration suites may own working rows; this runtime cannot settle their Runs.
      return yield* settlement === undefined ? Effect.never : Deferred.await(settlement)
    }),
    stop: Effect.fn('Delivery.test.stop')(() => Effect.succeed(false)),
    read: Effect.fn('Delivery.test.read')(() => Effect.never),
  })
  const finish = Effect.fn('Delivery.test.finish')(function* (id: RunId) {
    const settlement = settlements.get(id)
    if (settlement === undefined)
      return yield* Effect.sync(() => expect.fail('Run was not admitted'))
    return yield* Deferred.succeed(
      settlement,
      Settlement.cases.Completed.make({ reply: 'Finished' }),
    )
  })
  return { runtime, admitted, requests, finish }
})

/** Real RunStore methods also expose typed receipts so tests never sleep or poll for background work. */
const runFixture = Effect.fn('Delivery.test.runs')(function* () {
  const store = yield* RunStore
  const blocked = yield* Queue.unbounded<RunId>()
  const ended = yield* Queue.unbounded<RunId>()
  const observed = RunStore.of({
    ...store,
    start: Effect.fn('Delivery.test.start')((input) =>
      store
        .start(input)
        .pipe(
          Effect.tap((reservation) =>
            TurnReservation.guards.Busy(reservation) ? Queue.offer(blocked, input.id) : Effect.void,
          ),
        ),
    ),
    end: Effect.fn('Delivery.test.end')((id, ending) =>
      store
        .end(id, ending)
        .pipe(Effect.tap((changed) => (changed ? Queue.offer(ended, id) : Effect.void))),
    ),
  })
  return { observed, blocked, ended }
})

/** Each test owns a scoped production Conversation and independent rows, not a mock delivery seam. */
const harness = Effect.fn('Delivery.test.harness')(function* () {
  const rows = yield* fixture()
  const runtime = yield* runtimeFixture()
  const recorded = yield* runFixture()
  const database = yield* Database
  const services = Layer.mergeAll(
    Layer.succeed(Database, database),
    Layer.succeed(RunStore, recorded.observed),
    Layer.succeed(Runtime, runtime.runtime),
    threadStoreLayer.pipe(Layer.provide(Layer.succeed(Database, database))),
    silentChangesLayer,
    silentLearningLayer,
    Layer.succeed(
      Notifier,
      Notifier.of({ notify: Effect.fn('Delivery.test.notify')(() => Effect.void) }),
    ),
    Layer.mock(Presence, {
      watching: Effect.fn('Delivery.test.watching')(() => Effect.succeed(true)),
    }),
  )
  const context = yield* Layer.build(conversationLayer.pipe(Layer.provide(services)))
  const conversation = yield* Conversation.pipe(Effect.provideContext(context))
  /** Completion is observed through the real conditional SQL settlement before another Person sends. */
  const finish = Effect.fn('Delivery.test.settle')(function* (id: RunId) {
    yield* runtime.finish(id)
    expect(yield* Queue.take(recorded.ended)).toBe(id)
  })
  return { ...rows, ...runtime, ...recorded, conversation, finish }
})

/** Use a new submission key for ordinary messages, just as the gateway does. */
const said = (threadId: ThreadId, personId: PersonId): Delivery => ({
  threadId,
  personId,
  idempotencyKey: NodeCrypto.randomUUID(),
  message: DeliveryMessage.cases.Said.make({ body: 'Please help' }),
  origin: StoredRunOrigin.cases.Message.make({}),
})

/** Each producer keeps its actual origin while the common delivery seam handles contention. */
const signals = [
  { type: 'schedule', origin: StoredRunOrigin.cases.Routine.make({ routineName: 'Review' }) },
  { type: 'follow-up', origin: StoredRunOrigin.cases.FollowUp.make({ taskTitle: 'Review' }) },
  { type: 'approval', origin: StoredRunOrigin.cases.Decision.make({}) },
  { type: 'answer', origin: StoredRunOrigin.cases.Decision.make({}) },
] as const

describe.skipIf(!testDatabaseConfigured)('One Person per response', () => {
  it.effect('refuses Ben with Ada’s name, then admits him after Ada settles', () =>
    Effect.gen(function* () {
      const test = yield* harness()
      const ada = yield* test.conversation.admit(said(test.threadId, test.ada))
      const message = said(test.threadId, test.ben)
      const refused = yield* Effect.result(test.conversation.admit(message))
      expect(Result.isFailure(refused) && refused.failure).toEqual(
        Conflict.make({
          message: 'Vivid is still answering Ada. Send this again when it has finished.',
        }),
      )
      expect(yield* Ref.get(test.admitted)).toHaveLength(1)
      expect(yield* (yield* RunStore).list(test.threadId)).toHaveLength(1)
      yield* test.finish(ada.runId)
      const ben = yield* test.conversation.admit(message)
      expect(ben.offset).toBe('2')
      expect((yield* Ref.get(test.admitted)).map((delivery) => delivery.scope.acting)).toEqual([
        test.ada,
        test.ben,
      ])
    }).pipe(Effect.scoped, Effect.provide(databaseLayer)),
  )

  it.effect('allows Ada’s own follow-up to join and holds Ben until both joined Runs settle', () =>
    Effect.gen(function* () {
      const test = yield* harness()
      const first = yield* test.conversation.admit(said(test.threadId, test.ada))
      const second = yield* test.conversation.admit(said(test.threadId, test.ada))
      expect((yield* Ref.get(test.admitted)).map((delivery) => delivery.scope.acting)).toEqual([
        test.ada,
        test.ada,
      ])
      yield* test.finish(first.runId)
      const refused = yield* Effect.result(test.conversation.admit(said(test.threadId, test.ben)))
      expect(Result.isFailure(refused) && refused.failure).toBeInstanceOf(Conflict)
      yield* test.finish(second.runId)
      yield* test.conversation.admit(said(test.threadId, test.ben))
    }).pipe(Effect.scoped, Effect.provide(databaseLayer)),
  )

  it.effect('admits exactly one of simultaneous Ada and Ben messages into an idle Thread', () =>
    Effect.gen(function* () {
      const test = yield* harness()
      const outcomes = yield* Effect.forEach(
        [test.ada, test.ben],
        (personId) => Effect.result(test.conversation.admit(said(test.threadId, personId))),
        { concurrency: 2 },
      )
      expect(outcomes.filter(Result.isSuccess)).toHaveLength(1)
      const refused = outcomes.filter(Result.isFailure)
      expect(refused).toHaveLength(1)
      expect(refused.map((outcome) => outcome.failure)).toEqual([expect.any(Conflict)])
      expect(yield* Ref.get(test.admitted)).toHaveLength(1)
      expect(yield* (yield* RunStore).list(test.threadId)).toHaveLength(1)
    }).pipe(Effect.scoped, Effect.provide(databaseLayer)),
  )

  it.effect('a replay cannot bypass another Person’s working authority', () =>
    Effect.gen(function* () {
      const test = yield* harness()
      const message = said(test.threadId, test.ada)
      const ada = yield* test.conversation.admit(message)
      yield* test.finish(ada.runId)
      const ben = yield* test.conversation.admit(said(test.threadId, test.ben))
      const replay = yield* Effect.result(test.conversation.admit(message))
      expect(Result.isFailure(replay) && replay.failure).toEqual(
        Conflict.make({
          message: 'Vivid is still answering Ben. Send this again when it has finished.',
        }),
      )
      expect(yield* Ref.get(test.admitted)).toHaveLength(2)
      yield* test.finish(ben.runId)
      expect((yield* test.conversation.admit(message)).runId).toBe(ada.runId)
      expect(yield* (yield* RunStore).list(test.threadId)).toHaveLength(2)
    }).pipe(Effect.scoped, Effect.provide(databaseLayer)),
  )

  for (const { type, origin } of signals) {
    it.effect(`retains a ${type} signal for Ben until Ada settles, then replays the same key`, () =>
      Effect.gen(function* () {
        const test = yield* harness()
        const ada = yield* test.conversation.admit(said(test.threadId, test.ada))
        const delivery: SignalDelivery = {
          threadId: test.threadId,
          personId: test.ben,
          idempotencyKey: `${type}-receipt`,
          message: DeliveryMessage.cases.Signal.make({
            type,
            body: 'Server delivery',
            attributes: {},
          }),
          origin,
        }
        const pending = yield* test.conversation.deliver(delivery).pipe(Effect.forkScoped)
        expect(yield* Queue.take(test.blocked)).toBe(
          submissionId(test.threadId, delivery.idempotencyKey),
        )
        expect(yield* Ref.get(test.admitted)).toHaveLength(1)
        yield* test.finish(ada.runId)
        yield* TestClock.adjust('1 second')
        const admitted = yield* Fiber.join(pending)
        expect(admitted.id).toBe(submissionId(test.threadId, delivery.idempotencyKey))
        expect(RunState.guards.Working(admitted.state)).toBe(true)
        expect((yield* Ref.get(test.admitted)).map((input) => input.scope.acting)).toEqual([
          test.ada,
          test.ben,
        ])
        const replayed = yield* test.conversation.deliver(delivery)
        expect(replayed.id).toBe(admitted.id)
        expect(yield* (yield* RunStore).list(test.threadId)).toHaveLength(2)
      }).pipe(Effect.scoped, Effect.provide(databaseLayer)),
    )
  }

  it.effect('the gateway repeats one client key with one Run, one turn and the same receipt', () =>
    Effect.gen(function* () {
      const test = yield* harness()
      const handle = yield* HttpRouter.toHttpEffect(gatewayRoutes)
      const send = Effect.fn('Gateway.test.send')(function* () {
        return yield* handle.pipe(
          Effect.provideService(Conversation, test.conversation),
          Effect.provideService(Runtime, test.runtime),
          Effect.provide(silentChangesLayer),
          Effect.provide(testConfigLayer),
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request(`http://gateway.test/api/vivid/${test.threadId}`, {
                method: 'POST',
                headers: {
                  authorization: `Bearer ${test.token}`,
                  host: 'gateway.test',
                  'content-type': 'application/json',
                },
                body: JSON.stringify({
                  kind: 'user',
                  body: 'Please help',
                  idempotencyKey: 'lost-http-response',
                }),
              }),
            ),
          ),
        )
      })
      const first = yield* send()
      // Discarding the first response represents admission succeeding before HTTP delivery fails.
      const repeated = yield* send()
      expect(first.status).toBe(202)
      expect(repeated.status).toBe(202)
      expect(repeated.body).toEqual(first.body)
      const recorded = yield* (yield* RunStore).list(test.threadId)
      expect(recorded).toHaveLength(1)
      expect(recorded.map((run) => run.turn)).toEqual([1])
      expect(yield* Ref.get(test.admitted)).toHaveLength(1)
      const requests = yield* Ref.get(test.requests)
      expect(requests).toHaveLength(2)
      expect(requests[1]).toEqual(requests[0])
    }).pipe(Effect.scoped, Effect.provide(databaseLayer)),
  )

  it.effect('the shared HTTP gateway returns 409 and the exact Conflict message', () =>
    Effect.gen(function* () {
      const test = yield* harness()
      yield* test.conversation.admit(said(test.threadId, test.ada))
      const handle = yield* HttpRouter.toHttpEffect(gatewayRoutes)
      const response = yield* handle.pipe(
        Effect.provideService(Conversation, test.conversation),
        Effect.provideService(Runtime, test.runtime),
        Effect.provide(silentChangesLayer),
        Effect.provide(testConfigLayer),
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request(`http://gateway.test/api/vivid/${test.threadId}`, {
              method: 'POST',
              headers: {
                authorization: `Bearer ${test.token}`,
                host: 'gateway.test',
                'content-type': 'application/json',
              },
              body: JSON.stringify({ kind: 'user', body: 'Please help' }),
            }),
          ),
        ),
      )
      expect(response.status).toBe(409)
      expect(response.body).toHaveProperty(
        'text',
        JSON.stringify({
          error: {
            message: 'Vivid is still answering Ada. Send this again when it has finished.',
          },
        }),
      )
      expect(yield* Ref.get(test.admitted)).toHaveLength(1)
    }).pipe(Effect.scoped, Effect.provide(databaseLayer)),
  )
})
