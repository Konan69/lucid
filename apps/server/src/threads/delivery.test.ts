import { silentChannelRepliesLayer } from '../channels/replies.ts'
import { DeviceRegistry } from '../computers/device.ts'
import { ThreadTitles } from './generation.ts'
import * as NodeCrypto from 'node:crypto'
import * as NodeBuffer from 'node:buffer'
import { createFlueClient } from '@flue/sdk'
import { NodeHttpServer } from '@effect/platform-node'
import { describe, expect, layer } from '@effect/vitest'
import {
  CompanyId,
  InputRequestState,
  InstallationId,
  SessionId,
  DeviceRequest,
  DeviceAnswer,
  WindowAction,
  WindowResult,
  Conflict,
  PersonId,
  Company,
  RoutineTrigger,
  Workspace,
  RunId,
  RunState,
  RuntimeUnavailable,
  RuntimeRunRequest,
  ThreadId,
} from '@vivid/contracts'
import { eq, inArray } from 'drizzle-orm'
import {
  Deferred,
  Effect,
  Fiber,
  Layer,
  Logger,
  Queue,
  Ref,
  Result,
  Option,
  Predicate,
  Schema,
  Stream,
} from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import * as HttpRouter from 'effect/unstable/http/HttpRouter'
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest'
import * as HttpClientResponse from 'effect/unstable/http/HttpClientResponse'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpServer from 'effect/unstable/http/HttpServer'
import { findPerson, type Actor } from '../auth/access.ts'
import { InputStore, inputStoreLayer } from '../inputs/store.ts'
import { RoutineStore, routineStoreServiceLayer } from '../routines/store.ts'
import { IntegrationWatch } from '../routines/watch.ts'
import { RoutineScheduler, routineSchedulerServiceLayer } from '../routines/scheduler.ts'
import { ThreadStore } from './store.ts'
import { personTable, sessionTable } from '../auth/tables.ts'
import { companyTable, membershipTable } from '../companies/tables.ts'
import { Database } from '../database/client.ts'
import { testConfigLayer, testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { Changes, Topic, silentChangesLayer } from '../live/changes.ts'
import { silentLearningLayer } from '../memory/testing.ts'
import { Notifier } from '../notifications/notifier.ts'
import { Message } from '../observability/messages.ts'
import {
  Admission,
  AdmissionRefused,
  AdmissionUncertain,
  Runtime,
  Settlement,
  runtimeLayer,
} from '../runtime/client.ts'
import { submissionId } from '../runtime/identity.ts'
import {
  Conversation,
  DeliveryMessage,
  DeliverySpeaker,
  StoredRunOrigin,
  type Delivery,
  type SignalDelivery,
} from './conversation.ts'
import { conversationLayer } from './delivery.ts'
import { gatewayRoutes } from './gateway.ts'
import { Presence } from './presence.ts'
import { RunStore, runStoreLayer, TurnReservation, automaticallyNotifies } from './runs.ts'
import { openAttentionThread } from './opening.ts'
import { threadStoreLayer } from './store.ts'
import { threads } from './tables.ts'

const databaseLayer = runStoreLayer.pipe(Layer.provideMerge(testDatabaseLayer))
const decodeRuntimeRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(RuntimeRunRequest))

const png = {
  type: 'image',
  mimeType: 'image/png',
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=',
  filename: 'picture.png',
}

const gif = {
  type: 'image',
  mimeType: 'image/gif',
  data: 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
}

/** A real Company Thread gives both People access; cleanup is registered before any write. */
const fixture = Effect.fn('Delivery.test.fixture')(function* () {
  const database = yield* Database
  const ada = PersonId.make(NodeCrypto.randomUUID())
  const ben = PersonId.make(NodeCrypto.randomUUID())
  const companyId = CompanyId.make(NodeCrypto.randomUUID())
  const threadId = ThreadId.make(NodeCrypto.randomUUID())
  const token = NodeCrypto.randomUUID()
  const outsiderToken = NodeCrypto.randomUUID()
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
      titleSource: 'Person',
      updatedAt: 0,
    }),
  )
  yield* database.run(
    database.insert(sessionTable).values([
      { id: NodeCrypto.randomUUID(), token, userId: ben, expiresAt: new Date('2100-01-01') },
      {
        id: NodeCrypto.randomUUID(),
        token: outsiderToken,
        userId: ada,
        expiresAt: new Date('2100-01-01'),
      },
    ]),
  )
  return { ada, ben, threadId, token, outsiderToken, companyId }
})

type RuntimeInput = Parameters<Runtime['Service']['admit']>[0]

/** Control only the external runtime: the server's actual admission, SQL locks and observers run. */
const runtimeFixture = Effect.fn('Delivery.test.runtime')(function* () {
  const admitted = yield* Ref.make<ReadonlyArray<RuntimeInput>>([])
  const requests = yield* Ref.make<ReadonlyArray<RuntimeInput>>([])
  const failure = yield* Ref.make(Option.none<AdmissionRefused | AdmissionUncertain>())
  const reads = yield* Ref.make(0)
  const readHeaders = yield* Ref.make({
    'content-type': 'image/png',
    'content-disposition': 'attachment; filename="unsafe.html"',
    'cache-control': 'public, max-age=3600',
  })
  const settlements = new Map<RunId, Deferred.Deferred<Settlement>>()
  const runtime = Runtime.of({
    admit: Effect.fn('Delivery.test.admit')(function* (input) {
      const rejected = yield* Ref.getAndSet(failure, Option.none())
      if (Option.isSome(rejected)) return yield* rejected.value
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
    read: Effect.fn('Delivery.test.read')(function* () {
      yield* Ref.update(reads, (count) => count + 1)
      return HttpClientResponse.fromWeb(
        HttpClientRequest.get('http://runtime.test'),
        new Response(NodeBuffer.Buffer.from(png.data, 'base64'), {
          headers: yield* Ref.get(readHeaders),
        }),
      )
    }),
  })
  const settle = Effect.fn('Delivery.test.settleRuntime')(function* (
    id: RunId,
    result: Settlement,
  ) {
    const settlement = settlements.get(id)
    if (settlement === undefined)
      return yield* Effect.sync(() => expect.fail('Run was not admitted'))
    return yield* Deferred.succeed(settlement, result)
  })
  const finish = (id: RunId) =>
    settle(id, Settlement.cases.Completed.make({ reply: 'Finished', responseId: id }))
  return { runtime, admitted, requests, finish, settle, failure, reads, readHeaders }
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
  const topics = yield* Ref.make<ReadonlyArray<Topic>>([])
  const services = Layer.mergeAll(
    Layer.succeed(Database, database),
    Layer.succeed(RunStore, recorded.observed),
    Layer.succeed(Runtime, runtime.runtime),
    threadStoreLayer.pipe(Layer.provide(Layer.succeed(Database, database))),
    Layer.succeed(
      Changes,
      Changes.of({
        publish: (moved) => Ref.update(topics, (previous) => previous.concat(moved)),
        subscribe: () => Effect.succeed(Stream.never),
      }),
    ),
    silentLearningLayer,
    Layer.mock(ThreadTitles, { afterRun: () => Effect.void }),
    Layer.succeed(
      Notifier,
      Notifier.of({ notify: Effect.fn('Delivery.test.notify')(() => Effect.void) }),
    ),
    Layer.mock(Presence, {
      watching: Effect.fn('Delivery.test.watching')(() => Effect.succeed(true)),
    }),
  )
  const context = yield* Layer.build(
    conversationLayer.pipe(Layer.provide(silentChannelRepliesLayer), Layer.provide(services)),
  )
  const conversation = yield* Conversation.pipe(Effect.provideContext(context))
  const devices = yield* DeviceRegistry.pipe(Effect.provideContext(context))
  /** Completion is observed through the real conditional SQL settlement before another Person sends. */
  const finish = Effect.fn('Delivery.test.settle')(function* (id: RunId) {
    yield* runtime.finish(id)
    expect(yield* Queue.take(recorded.ended)).toBe(id)
  })
  return { ...rows, ...runtime, ...recorded, conversation, devices, finish, services, topics }
})

type Harness = Effect.Success<ReturnType<typeof harness>>

/** Input requests and admission share real stores; only external runtime and notification ports vary. */
const inputHarness = Effect.fn('Delivery.test.inputs')(function* () {
  const test = yield* harness()
  const context = yield* Layer.build(
    inputStoreLayer.pipe(
      Layer.provide(Layer.succeed(Conversation, test.conversation)),
      Layer.provide(test.services),
    ),
  )
  const inputs = yield* InputStore.pipe(Effect.provide(context))
  return { ...test, inputs }
})

/** Current persisted identity and Company scope are the same authority used by chat and answer handlers. */
const actorOf = Effect.fn('Delivery.test.actor')(function* (test: Harness, personId: PersonId) {
  const person = yield* findPerson(personId)
  if (Option.isNone(person)) expect.fail('Missing test Person')
  return {
    person: person.value,
    workspace: Workspace.cases.Company.make({
      company: Company.make({ id: test.companyId, name: 'Delivery test', slug: test.companyId }),
      role: 'member',
    }),
    by: 'person',
    threadId: Option.none(),
  } satisfies Actor
})

/** Ask through the production store, addressed by authenticated Vivid context rather than a fixture row. */
const askFor = Effect.fn('Delivery.test.ask')(function* (
  test: Effect.Success<ReturnType<typeof inputHarness>>,
  personId: PersonId,
  threadId: ThreadId,
) {
  const actor = yield* actorOf(test, personId)
  return yield* test.inputs.ask(
    { ...actor, by: 'vivid', threadId: Option.some(threadId) },
    {
      question: 'Which day works?',
      options: [{ label: 'Monday', detail: 'Start the week' }],
      allowsOwnAnswer: true,
    },
  )
})

/** The real gateway, authentication and Conversation remain in the request path. */
const gateway = Effect.fn('Gateway.test.request')(function* (test: Harness, request: Request) {
  const handle = yield* HttpRouter.toHttpEffect(gatewayRoutes)
  return yield* handle.pipe(
    Effect.provideService(Conversation, test.conversation),
    Effect.provideService(Runtime, test.runtime),
    Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(request)),
  )
})

/** Only Ben can see this private Thread; Ada stays a Company Member to test the narrower audience. */
const privateThread = Effect.fn('Gateway.test.private')(function* (test: Harness) {
  const database = yield* Database
  yield* database.run(
    database
      .update(threads)
      .set({ audience: 'private', personId: test.ben })
      .where(eq(threads.id, test.threadId)),
  )
})

/** Tests send precisely the JSON and session a web or mobile client would use. */
const post = (test: Harness, body: Schema.JsonObject) =>
  gateway(
    test,
    new Request(`http://gateway.test/api/vivid/${test.threadId}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${test.token}`,
        host: 'gateway.test',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  )

/** Stable tags and Person-facing sentences are observable without decoding internal Effect errors. */
const expectPictureRefusal = (
  response: HttpServerResponse.HttpServerResponse,
  tag: string,
  message: string,
) => {
  expect(response.body).toHaveProperty('text', JSON.stringify({ error: { _tag: tag, message } }))
}

/** Use a new submission key for ordinary messages, just as the gateway does. */
const said = (threadId: ThreadId, personId: PersonId): Delivery => ({
  threadId,
  personId,
  speaker: DeliverySpeaker.cases.Acting.make({}),
  idempotencyKey: NodeCrypto.randomUUID(),
  message: DeliveryMessage.cases.Said.make({ body: 'Please help' }),
  origin: StoredRunOrigin.cases.Message.make({}),
})

/** Each producer keeps its actual origin while the common delivery seam handles contention. */
const signals = [
  { type: 'schedule', origin: StoredRunOrigin.cases.Routine.make({ routineName: 'Review' }) },
  { type: 'approval', origin: StoredRunOrigin.cases.Decision.make({}) },
  { type: 'answer', origin: StoredRunOrigin.cases.Decision.make({}) },
] as const

layer(
  databaseLayer.pipe(Layer.provideMerge(silentChangesLayer), Layer.provideMerge(testConfigLayer)),
)((it) => {
  describe.skipIf(!testDatabaseConfigured)('Input requests moved on by chat', () => {
    it.effect(
      'an admitted message withdraws all its Person’s questions, publishes, and replay changes nothing',
      () =>
        Effect.gen(function* () {
          const test = yield* inputHarness()
          const actor = yield* actorOf(test, test.ben)
          const first = yield* askFor(test, test.ben, test.threadId)
          const second = yield* askFor(test, test.ben, test.threadId)
          const otherPerson = yield* askFor(test, test.ada, test.threadId)
          // The Company cleanup registered by fixture already owns this second Thread.
          const database = yield* Database
          const elsewhere = ThreadId.make(NodeCrypto.randomUUID())
          yield* database.run(
            database.insert(threads).values({
              id: elsewhere,
              personId: test.ben,
              companyId: test.companyId,
              audience: 'company',
              title: 'Other work',
              titleSource: 'Person',
              updatedAt: 0,
            }),
          )
          const otherThread = yield* askFor(test, test.ben, elsewhere)
          yield* Ref.set(test.topics, [])
          const body = {
            kind: 'user',
            body: 'Skip that question and carry on.',
            idempotencyKey: 'skip',
          }
          const response = yield* post(test, body)
          expect(response.status).toBe(202)
          const records = yield* test.inputs.inThread(test.threadId)
          expect(
            records
              .filter((request) => InputRequestState.guards.Withdrawn(request.state))
              .map((request) => request.id)
              .toSorted(),
          ).toEqual([first.id, second.id].toSorted())
          expect(records.find((request) => request.id === otherPerson.id)).toEqual(otherPerson)
          expect(yield* test.inputs.inThread(elsewhere)).toEqual([otherThread])
          expect(yield* test.inputs.inbox(actor)).toEqual([otherThread])
          const topics = yield* Ref.get(test.topics)
          expect(topics).toContain(Topic.person(test.ben))
          expect(topics).toContain(Topic.thread(test.threadId))
          const deliveries = yield* Ref.get(test.admitted)
          expect(deliveries).toHaveLength(1)
          const delivered = deliveries[0]
          if (delivered === undefined) expect.fail('Missing admitted message')
          // The Person's words reach the runtime as written: nothing is put in their mouth.
          expect(delivered.message.body).not.toContain('unanswered')
          expect(delivered.message.body).toContain(body.body)
          expect(delivered.message.body).not.toContain(first.id)
          expect(delivered.message.body).not.toContain(test.ben)
          // A later question must survive a replay, even after rebuilding the admission service.
          const later = yield* askFor(test, test.ben, test.threadId)
          const before = yield* test.inputs.inThread(test.threadId)
          const beforeTopics = yield* Ref.get(test.topics)
          const context = yield* Layer.build(
            conversationLayer.pipe(
              Layer.provide(silentChannelRepliesLayer),
              Layer.provide(test.services),
            ),
          )
          const conversation = yield* Conversation.pipe(Effect.provide(context))
          const repeated = yield* post({ ...test, conversation }, body)
          expect(repeated.status).toBe(202)
          expect(repeated.body).toEqual(response.body)
          expect(yield* test.inputs.inThread(test.threadId)).toEqual(before)
          expect(yield* test.inputs.inbox(actor)).toEqual(
            expect.arrayContaining([later, otherThread]),
          )
          expect(yield* Ref.get(test.topics)).toEqual(beforeTopics)
          expect(yield* Ref.get(test.admitted)).toHaveLength(1)
        }).pipe(Effect.scoped),
    )

    it.effect(
      'an answer stays Answered and leaves other questions waiting through real admission',
      () =>
        Effect.gen(function* () {
          const test = yield* inputHarness()
          const actor = yield* actorOf(test, test.ben)
          const request = yield* askFor(test, test.ben, test.threadId)
          const waiting = yield* askFor(test, test.ben, test.threadId)
          const answered = yield* test.inputs.answer(actor, { id: request.id, answer: 'Monday' })
          expect(InputRequestState.guards.Answered(answered.state)).toBe(true)
          expect(yield* test.inputs.inThread(test.threadId)).toEqual(
            expect.arrayContaining([answered, waiting]),
          )
          expect(yield* Ref.get(test.admitted)).toMatchObject([
            {
              message: {
                kind: 'signal',
                type: 'answer',
                body: 'Monday',
                attributes: { from: 'Ben' },
              },
            },
          ])
          const admitted = (yield* Ref.get(test.admitted))[0]
          if (admitted === undefined) expect.fail('Missing answer delivery')
          yield* test.finish(submissionId(test.threadId, admitted.idempotencyKey))
          yield* post(test, { kind: 'user', body: 'Continue.', idempotencyKey: 'after-answer' })
          expect(
            (yield* test.inputs.inThread(test.threadId)).find((input) => input.id === request.id),
          ).toEqual(answered)
        }).pipe(Effect.scoped),
    )

    it.effect(
      'private chat keeps pictures and original preview while withdrawing the question',
      () =>
        Effect.gen(function* () {
          const test = yield* inputHarness()
          yield* privateThread(test)
          const request = yield* askFor(test, test.ben, test.threadId)
          const response = yield* post(test, {
            kind: 'user',
            body: 'Use this instead.',
            attachments: [png],
          })
          expect(response.status).toBe(202)
          expect(yield* test.inputs.inThread(test.threadId)).toMatchObject([
            { id: request.id, state: InputRequestState.cases.Withdrawn.make({ withdrawnAt: 0 }) },
          ])
          expect(yield* Ref.get(test.admitted)).toMatchObject([
            {
              message: {
                kind: 'user',
                attachments: [png],
              },
            },
          ])
          const database = yield* Database
          expect(
            yield* database.run(
              database
                .select({ preview: threads.preview })
                .from(threads)
                .where(eq(threads.id, test.threadId)),
            ),
          ).toEqual([{ preview: 'Use this instead.' }])
        }).pipe(Effect.scoped),
    )

    it.effect('a refused admission and a Busy reservation both leave questions waiting', () =>
      Effect.gen(function* () {
        const test = yield* inputHarness()
        const waiting = yield* askFor(test, test.ben, test.threadId)
        const delivery = said(test.threadId, test.ben)
        yield* Ref.set(
          test.failure,
          Option.some(
            AdmissionRefused.make({
              threadId: test.threadId,
              runId: submissionId(test.threadId, delivery.idempotencyKey),
              reason: 'Rejected',
            }),
          ),
        )
        const refused = yield* Effect.result(test.conversation.admit(delivery))
        expect(Result.isFailure(refused) && refused.failure._tag).toBe('RuntimeUnavailable')
        expect(yield* test.inputs.inThread(test.threadId)).toEqual([waiting])
        yield* test.conversation.admit(said(test.threadId, test.ada))
        const busy = yield* Effect.result(test.conversation.admit(said(test.threadId, test.ben)))
        expect(Result.isFailure(busy) && busy.failure._tag).toBe('Conflict')
        expect(yield* test.inputs.inThread(test.threadId)).toEqual([waiting])
      }).pipe(Effect.scoped),
    )

    it.effect('Routine, wake, channel and server-written deliveries withdraw nothing', () =>
      Effect.gen(function* () {
        const test = yield* inputHarness()
        const waiting = yield* askFor(test, test.ben, test.threadId)
        const messages: ReadonlyArray<Delivery> = [
          { ...said(test.threadId, test.ben), speaker: DeliverySpeaker.cases.Vivid.make({}) },
          {
            ...said(test.threadId, test.ben),
            message: DeliveryMessage.cases.ChannelText.make({ body: 'Channel message' }),
          },
          {
            ...said(test.threadId, test.ben),
            origin: StoredRunOrigin.cases.Routine.make({ routineName: 'Review' }),
            speaker: DeliverySpeaker.cases.Vivid.make({}),
            message: DeliveryMessage.cases.Signal.make({
              type: 'schedule',
              body: 'Review now.',
              attributes: { name: 'Review' },
            }),
          },
          {
            ...said(test.threadId, test.ben),
            origin: StoredRunOrigin.cases.Decision.make({}),
            speaker: DeliverySpeaker.cases.Vivid.make({}),
            message: DeliveryMessage.cases.Signal.make({
              // Continuations have no dedicated wake type in the current signal vocabulary.
              type: 'message',
              body: 'Continue working.',
              attributes: {},
            }),
          },
        ]
        yield* privateThread(test)
        const database = yield* Database
        // A linked personal channel cannot enter a Company Thread, even a private one.
        yield* database.run(
          database.update(threads).set({ companyId: null }).where(eq(threads.id, test.threadId)),
        )
        for (const delivery of messages) {
          const admission = yield* test.conversation.admit(delivery)
          expect(yield* test.inputs.inThread(test.threadId)).toEqual([waiting])
          yield* test.finish(admission.runId)
        }
      }).pipe(Effect.scoped),
    )
  })

  describe.skipIf(!testDatabaseConfigured)('One Person per response', () => {
    it.effect(
      'records a failed model settlement at its boundary and persists the provider reason',
      () =>
        Effect.gen(function* () {
          const reported = yield* Queue.unbounded<void>()
          const lines: string[] = []
          const capture = Logger.make((entry) => {
            const line = Logger.formatSimple.log(entry)
            if (line.includes(Message.failure)) {
              lines.push(line)
              Queue.offerUnsafe(reported, undefined)
            }
          })
          const logging = yield* Layer.build(Logger.layer([capture]))
          return yield* Effect.gen(function* () {
            const test = yield* harness()
            const admission = yield* test.conversation.admit(said(test.threadId, test.ada))
            yield* test.settle(
              admission.runId,
              Settlement.cases.Failed.make({
                reason: 'ModelUnavailable',
                providerStatus: 520,
              }),
            )
            yield* Queue.take(reported)
            expect(yield* Queue.take(test.ended)).toBe(admission.runId)
            const stored = yield* (yield* RunStore).list(test.threadId)
            expect(stored.map((run) => run.state)).toEqual([
              RunState.cases.Failed.make({ finishedAt: 0, reason: 'ModelUnavailable' }),
            ])
            expect(lines).toHaveLength(1)
            expect(lines[0]).toContain('error.type=ModelProviderFailed')
            expect(lines[0]).toContain('vivid.boundary=runtime')
            expect(lines[0]).toContain('vivid.model.failure.status=520')
          }).pipe(Effect.provide(logging))
        }).pipe(Effect.scoped),
    )

    it.effect(
      'a standing finding opens one private Thread and Run through normal admission; a child cannot fan out',
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const test = yield* harness()
            const source = yield* test.conversation.admit({
              threadId: test.threadId,
              personId: test.ada,
              speaker: DeliverySpeaker.cases.Vivid.make({}),
              idempotencyKey: NodeCrypto.randomUUID(),
              libraryFolder: null,
              origin: StoredRunOrigin.cases.Standing.make({ routineName: 'Watch what needs me' }),
              message: DeliveryMessage.cases.Signal.make({
                type: 'schedule',
                body: 'Check mail and calendar.',
                attributes: { name: 'Watch what needs me' },
              }),
            })
            const input = {
              personId: test.ada,
              threadId: test.threadId,
              request: {
                title: 'Calendar clash',
                context: 'Two confirmed meetings overlap tomorrow at 10:00. Choose which to move.',
              },
            }
            // Each opening owns its service scope; repeat the same input to verify deduplication.
            const open = Effect.fn('Delivery.test.openAttention')(function* () {
              const context = yield* Layer.build(test.services)
              return yield* openAttentionThread(input).pipe(
                Effect.provideService(Conversation, test.conversation),
                Effect.provide(context),
              )
            })
            expect(yield* open()).toEqual({ title: 'Calendar clash' })
            yield* open()
            const database = yield* Database
            const created = yield* database.run(
              database.select().from(threads).where(eq(threads.personId, test.ada)),
            )
            const child = created.find((thread) => thread.title === input.request.title)
            if (child === undefined) expect.fail('Expected private finding Thread')
            expect(child).toMatchObject({
              companyId: null,
              audience: 'private',
              titleSource: 'Assigned',
            })
            const childRuns = yield* (yield* RunStore).list(child.id)
            expect(childRuns).toHaveLength(1)
            const childRun = childRuns[0]
            if (childRun === undefined) expect.fail('Expected admitted finding Run')
            expect(yield* automaticallyNotifies(source.runId)).toBe(false)
            expect(yield* automaticallyNotifies(childRun.id)).toBe(false)
            const refused = yield* Effect.gen(function* () {
              const context = yield* Layer.build(test.services)
              return yield* openAttentionThread({ ...input, threadId: child.id }).pipe(
                Effect.provideService(Conversation, test.conversation),
                Effect.result,
                Effect.provide(context),
              )
            })
            expect(Result.isFailure(refused) && refused.failure._tag).toBe('Forbidden')
          }),
        ),
    )
    // Both precise Runtime failures retain this slice's existing Conversation error and state assertions.
    const admissionFailures = [
      {
        name: 'refused',
        make: (threadId: ThreadId, runId: RunId) =>
          AdmissionRefused.make({ threadId, runId, reason: 'Rejected' }),
      },
      {
        name: 'uncertain',
        make: (threadId: ThreadId, runId: RunId) =>
          AdmissionUncertain.make({ threadId, runId, reason: 'Transport' }),
      },
    ]
    for (const failure of admissionFailures) {
      layer(
        databaseLayer.pipe(
          Layer.provideMerge(silentChangesLayer),
          Layer.provideMerge(testConfigLayer),
        ),
      )('Clock case 1', (clockIt) => {
        clockIt.effect(
          `${failure.name} Flue admission ends the Run with Delivery and does not block Ben`,
          () =>
            Effect.gen(function* () {
              const test = yield* harness()
              // The error names the Run its request would have started, as the real client's does.
              const message = said(test.threadId, test.ada)
              const runId = submissionId(test.threadId, message.idempotencyKey)
              yield* Ref.set(test.failure, Option.some(failure.make(test.threadId, runId)))
              const rejected = yield* Effect.result(test.conversation.admit(message))
              expect(Result.isFailure(rejected) && rejected.failure).toBeInstanceOf(
                RuntimeUnavailable,
              )
              const recorded = yield* (yield* RunStore).list(test.threadId)
              expect(recorded.map((run) => run.state)).toEqual([
                RunState.cases.Failed.make({ finishedAt: 0, reason: 'Delivery' }),
              ])
              yield* test.conversation.admit(said(test.threadId, test.ben))
              expect(yield* Ref.get(test.admitted)).toHaveLength(1)
            }).pipe(Effect.scoped),
        )
      })
    }

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
      }).pipe(Effect.scoped),
    )

    it.effect('allows Ada’s own Routine to join and holds Ben until both joined Runs settle', () =>
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
      }).pipe(Effect.scoped),
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
      }).pipe(Effect.scoped),
    )

    it.effect('names the decider as speaker while Flue acts for the original Person', () =>
      Effect.gen(function* () {
        const test = yield* harness()
        const delivery: SignalDelivery = {
          threadId: test.threadId,
          personId: test.ada,
          speaker: DeliverySpeaker.cases.Decider.make({ personId: test.ben }),
          idempotencyKey: 'decision-speaker',
          message: DeliveryMessage.cases.Signal.make({
            type: 'answer',
            body: 'Monday',
            attributes: {},
          }),
          origin: StoredRunOrigin.cases.Decision.make({}),
        }
        yield* test.conversation.deliver(delivery)
        const requests = yield* Ref.get(test.requests)
        expect(requests).toMatchObject([
          { scope: { acting: test.ada }, message: { attributes: { from: 'Ben' } } },
        ])
        const database = yield* Database
        yield* database.run(
          database.delete(membershipTable).where(eq(membershipTable.userId, test.ben)),
        )
        const lost = yield* Effect.result(
          test.conversation.deliver({ ...delivery, idempotencyKey: 'access-lost' }),
        )
        expect(Result.isFailure(lost) && lost.failure._tag).toBe('NotFound')
        expect(yield* Ref.get(test.requests)).toHaveLength(1)
      }).pipe(Effect.scoped),
    )

    it.effect('an admitted replay returns its original receipt while another Person works', () =>
      Effect.gen(function* () {
        const test = yield* harness()
        const message = said(test.threadId, test.ada)
        const ada = yield* test.conversation.admit(message)
        yield* test.finish(ada.runId)
        const ben = yield* test.conversation.admit(said(test.threadId, test.ben))
        const replay = yield* test.conversation.admit(message)
        expect(replay).toEqual(ada)
        expect(yield* Ref.get(test.admitted)).toHaveLength(2)
        yield* test.finish(ben.runId)
        expect((yield* test.conversation.admit(message)).runId).toBe(ada.runId)
        expect(yield* (yield* RunStore).list(test.threadId)).toHaveLength(2)
      }).pipe(Effect.scoped),
    )

    layer(
      databaseLayer.pipe(
        Layer.provideMerge(silentChangesLayer),
        Layer.provideMerge(testConfigLayer),
      ),
    )('Clock case 2', (clockIt) => {
      clockIt.effect(
        'a Busy Routine keeps its tick while another due Routine runs in the same pass',
        () =>
          Effect.gen(function* () {
            const test = yield* harness()
            const database = yield* Database
            const person = yield* findPerson(test.ben)
            if (Option.isNone(person)) expect.fail('Missing Ben')
            const actor = {
              person: person.value,
              workspace: Workspace.cases.Company.make({
                company: new Company({
                  id: test.companyId,
                  name: 'Delivery test',
                  slug: test.companyId,
                }),
                role: 'member',
              }),
              by: 'person' as const,
              threadId: Option.none<ThreadId>(),
            }
            const foundation = Layer.mergeAll(
              test.services,
              testConfigLayer,
              Layer.succeed(Conversation, test.conversation),
            )
            const schedulerContext = yield* Layer.build(
              routineSchedulerServiceLayer.pipe(
                // These Routines run on the clock. Nothing here watches an Integration, so the store
                // gets a stand-in with no methods; the production Layer would build a real Executor
                // client from settings this suite does not have.
                Layer.provideMerge(
                  routineStoreServiceLayer.pipe(Layer.provide(Layer.mock(IntegrationWatch, {}))),
                ),
                Layer.provide(foundation),
              ),
            )
            const store = yield* RoutineStore.pipe(Effect.provideContext(schedulerContext))
            const scheduler = yield* RoutineScheduler.pipe(Effect.provideContext(schedulerContext))
            const trigger = RoutineTrigger.cases.Schedule.make({
              cron: '* * * * *',
              timezone: 'UTC',
            })
            const busy = yield* store.create(actor, { name: 'Busy', prompt: 'Review', trigger })
            const healthy = yield* store.create(actor, {
              name: 'Healthy',
              prompt: 'Review',
              trigger,
            })
            const threadStore = yield* Effect.gen(function* () {
              const context = yield* Layer.build(test.services)
              return yield* ThreadStore.pipe(Effect.provide(context))
            })
            const busyThread = yield* threadStore.ensure({
              id: ThreadId.make(`routine-${busy.id}`),
              title: 'Busy',
              titleSource: 'Person',
              personId: test.ben,
              companyId: test.companyId,
            })
            yield* database.run(
              database
                .update(threads)
                .set({ audience: 'company' })
                .where(eq(threads.id, busyThread.id)),
            )
            const ada = yield* test.conversation.admit(said(busyThread.id, test.ada))
            yield* TestClock.setTime(60_000)
            const pass = yield* Effect.result(scheduler.runDue)
            expect(Result.isFailure(pass) && pass.failure).toBeInstanceOf(Conflict)
            const waiting = (yield* store.list(actor)).find((routine) => routine.id === busy.id)
            if (waiting === undefined) expect.fail('Missing Busy Routine')
            expect(waiting.runs).toMatchObject([
              { submissionId: null, error: 'Delivery was not admitted (Conflict)' },
            ])
            const running = (yield* store.list(actor)).find((routine) => routine.id === healthy.id)
            if (running === undefined) expect.fail('Missing Healthy Routine')
            expect(running.runs).toMatchObject([{ status: 'running' }])
            yield* test.finish(ada.runId)
            yield* scheduler.runDue
            const replayed = (yield* store.list(actor)).find((routine) => routine.id === busy.id)
            if (replayed === undefined) expect.fail('Missing replayed Routine')
            expect(replayed.runs.map((run) => run.id)).toEqual(waiting.runs.map((run) => run.id))
            expect(replayed.runs).toMatchObject([{ status: 'running', error: null }])
          }).pipe(Effect.scoped),
      )
    })

    for (const { type, origin } of signals) {
      it.effect(
        `returns Busy for a ${type} signal immediately and replays its key on the next attempt`,
        () =>
          Effect.gen(function* () {
            const test = yield* harness()
            const ada = yield* test.conversation.admit(said(test.threadId, test.ada))
            const delivery: SignalDelivery = {
              speaker: DeliverySpeaker.cases.Acting.make({}),
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
            const pending = yield* Effect.result(test.conversation.deliver(delivery)).pipe(
              Effect.forkScoped,
            )
            expect(yield* Queue.take(test.blocked)).toBe(
              submissionId(test.threadId, delivery.idempotencyKey),
            )
            expect(yield* Ref.get(test.admitted)).toHaveLength(1)
            const busy = yield* Fiber.join(pending)
            expect(Result.isFailure(busy) && busy.failure).toBeInstanceOf(Conflict)
            yield* test.finish(ada.runId)
            const admitted = yield* test.conversation.deliver(delivery)
            expect(admitted.id).toBe(submissionId(test.threadId, delivery.idempotencyKey))
            expect(RunState.guards.Working(admitted.state)).toBe(true)
            expect((yield* Ref.get(test.admitted)).map((input) => input.scope.acting)).toEqual([
              test.ada,
              test.ben,
            ])
            const replayed = yield* test.conversation.deliver(delivery)
            expect(replayed.id).toBe(admitted.id)
            expect(yield* (yield* RunStore).list(test.threadId)).toHaveLength(2)
          }).pipe(Effect.scoped),
      )
    }

    it.effect(
      'the gateway repeats one client key with one Run, one turn and the same receipt',
      () =>
        Effect.gen(function* () {
          const test = yield* harness()
          const handle = yield* HttpRouter.toHttpEffect(gatewayRoutes)
          const send = Effect.fn('Gateway.test.send')(function* () {
            return yield* handle.pipe(
              Effect.provideService(Conversation, test.conversation),
              Effect.provideService(Runtime, test.runtime),
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
          expect(requests).toHaveLength(1)
        }).pipe(Effect.scoped),
    )

    it.effect('the shared HTTP gateway returns 409 and the exact Conflict message', () =>
      Effect.gen(function* () {
        const test = yield* harness()
        yield* test.conversation.admit(said(test.threadId, test.ada))
        const handle = yield* HttpRouter.toHttpEffect(gatewayRoutes)
        const response = yield* handle.pipe(
          Effect.provideService(Conversation, test.conversation),
          Effect.provideService(Runtime, test.runtime),
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
      }).pipe(Effect.scoped),
    )
  })

  /** Pictures exercise the gateway's public HTTP seam, including real auth, access and Run persistence. */
  describe.skipIf(!testDatabaseConfigured)('Pictures through the gateway', () => {
    it.effect(
      'preserves private pictures through the production server-to-runtime HTTP adapter',
      () =>
        Effect.gen(function* () {
          const test = yield* harness()
          yield* privateThread(test)
          const sent = yield* Ref.make<ReadonlyArray<RuntimeRunRequest>>([])
          // Only the remote network is simulated; the actual Runtime adapter builds and encodes the request.
          const http = HttpClient.make(
            Effect.fn('Gateway.test.runtimeHttp')(function* (request) {
              if (!Predicate.isTagged(request.body, 'Uint8Array'))
                return yield* Effect.sync(() => expect.fail('Expected encoded runtime JSON'))
              const delivery = yield* decodeRuntimeRequest(
                new TextDecoder().decode(request.body.body),
              ).pipe(Effect.catch(() => Effect.sync(() => expect.fail('Invalid runtime JSON'))))
              yield* Ref.update(sent, (all) => [...all, delivery])
              return HttpClientResponse.fromWeb(
                request,
                new Response(
                  JSON.stringify({
                    submissionId: submissionId(delivery.threadId, delivery.idempotencyKey),
                    offset: '1',
                    uid: 'test',
                  }),
                  { status: 202, headers: { 'content-type': 'application/json' } },
                ),
              )
            }),
          )
          const runtimeContext = yield* Layer.build(
            runtimeLayer.pipe(
              Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
              Layer.provide(testConfigLayer),
            ),
          )
          const transport = yield* Runtime.pipe(Effect.provideContext(runtimeContext))
          // The admission under test uses production HTTP; settlement stays controllable in the fixture.
          const runtime = Runtime.of({ ...transport, settled: test.runtime.settled })
          const context = yield* Layer.build(
            conversationLayer.pipe(
              Layer.provide(silentChannelRepliesLayer),
              Layer.provide(Layer.merge(test.services, Layer.succeed(Runtime, runtime))),
            ),
          )
          const conversation = yield* Conversation.pipe(Effect.provideContext(context))
          const response = yield* post(
            { ...test, conversation, runtime },
            {
              kind: 'user',
              body: 'Look',
              attachments: [png],
            },
          )
          expect(response.status).toBe(202)
          expect(yield* Ref.get(sent)).toMatchObject([
            { body: expect.stringContaining('\n\nLook'), attributes: {}, attachments: [png] },
          ])
        }).pipe(Effect.scoped),
    )
    it.effect(
      'accepts the installed Flue client’s image wire shape through the private gateway',
      () =>
        Effect.gen(function* () {
          const test = yield* harness()
          yield* privateThread(test)
          const serverContext = yield* Layer.build(NodeHttpServer.layerTest)
          const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(serverContext))
          const handle = yield* HttpRouter.toHttpEffect(gatewayRoutes)
          yield* server
            .serve(
              handle.pipe(
                Effect.provideService(Conversation, test.conversation),
                Effect.provideService(Runtime, test.runtime),
              ),
            )
            .pipe(Effect.provideContext(serverContext))
          const url = new URL(HttpServer.formatAddress(server.address))
          url.hostname = '127.0.0.1'
          url.pathname = `/api/vivid/${test.threadId}`
          const client = createFlueClient({
            url: url.href,
            token: test.token,
          })
          const receipt = yield* Effect.tryPromise(() =>
            client.send({
              message: {
                kind: 'user',
                body: 'Look',
                attachments: [
                  {
                    type: 'image',
                    mimeType: png.mimeType,
                    data: png.data,
                    filename: png.filename,
                  },
                ],
              },
            }),
          )
          expect(yield* (yield* RunStore).list(test.threadId)).toMatchObject([
            { id: receipt.submissionId },
          ])
          expect((yield* Ref.get(test.admitted))[0]).toMatchObject({
            message: { kind: 'user', attachments: [png] },
          })
        }).pipe(Effect.scoped),
    )
    it.effect('accepts four pictures and a picture exactly at the decoded 5 MB limit', () =>
      Effect.gen(function* () {
        const test = yield* harness()
        yield* privateThread(test)
        const bytes = NodeBuffer.Buffer.alloc(5 * 1024 * 1024)
        NodeBuffer.Buffer.from(png.data, 'base64').copy(bytes)
        const largest = { ...png, data: bytes.toString('base64') }
        const response = yield* post(test, {
          kind: 'user',
          body: 'Look',
          attachments: [largest, png, gif, png],
        })
        expect(response.status).toBe(202)
        const messages = yield* Ref.get(test.admitted)
        expect(messages[0]).toMatchObject({
          message: {
            kind: 'user',
            attachments: [largest, png, gif, png],
          },
        })
      }).pipe(Effect.scoped),
    )

    it.effect('refuses malformed attachment lists with an actionable tag', () =>
      Effect.gen(function* () {
        const test = yield* harness()
        yield* privateThread(test)
        for (const attachments of [null, 'picture', { image: png }]) {
          const response = yield* post(test, { kind: 'user', body: 'Look', attachments })
          expect(response.status).toBe(400)
          expectPictureRefusal(
            response,
            'InvalidAttachment',
            'Pictures must be sent as an attachment list.',
          )
        }
        expect(yield* Ref.get(test.admitted)).toHaveLength(0)
      }).pipe(Effect.scoped),
    )
    it.effect(
      'carries a private picture with the ordinary user message and preserves its keyed receipt',
      () =>
        Effect.gen(function* () {
          const test = yield* harness()
          yield* privateThread(test)
          const body = {
            kind: 'user',
            body: 'What is in this picture?',
            attachments: [png],
            idempotencyKey: 'picture',
          }
          const first = yield* post(test, body)
          const repeated = yield* post(test, body)
          expect(first.status).toBe(202)
          expect(repeated.body).toEqual(first.body)
          const deliveries = yield* Ref.get(test.admitted)
          expect(deliveries).toHaveLength(1)
          expect(deliveries[0]).toMatchObject({
            message: { kind: 'user', body: expect.stringContaining(body.body), attachments: [png] },
            scope: { acting: test.ben },
          })
          expect(yield* (yield* RunStore).list(test.threadId)).toHaveLength(1)
        }).pipe(Effect.scoped),
    )

    it.effect('refuses shared pictures before reserving or delivering anything', () =>
      Effect.gen(function* () {
        const test = yield* harness()
        const response = yield* post(test, { kind: 'user', body: 'Look', attachments: [png] })
        expect(response.status).toBe(400)
        expectPictureRefusal(
          response,
          'PicturesRequirePrivateThread',
          'Pictures can only be sent in a private thread for now.',
        )
        expect(yield* Ref.get(test.admitted)).toHaveLength(0)
        expect(yield* (yield* RunStore).list(test.threadId)).toHaveLength(0)
      }).pipe(Effect.scoped),
    )

    const refusals = [
      {
        name: 'missing attachment fields',
        attachments: [{ type: 'image' }],
        tag: 'InvalidAttachment',
        message: 'Send a picture with valid attachment fields.',
        status: 400,
      },
      {
        name: 'high-bit bytes imitating GIF magic',
        attachments: [
          {
            ...png,
            mimeType: 'image/gif',
            data: NodeBuffer.Buffer.from([199, 201, 198, 184, 185, 225]).toString('base64'),
          },
        ],
        tag: 'UnsupportedAttachment',
        message: 'The picture type does not match its contents.',
        status: 400,
      },
      {
        name: 'unsupported type',
        attachments: [{ ...png, mimeType: 'application/pdf' }],
        tag: 'UnsupportedAttachment',
        message: 'Choose a PNG, JPEG, WebP or GIF picture.',
        status: 400,
      },
      {
        name: 'document attachment',
        attachments: [{ ...png, type: 'document' }],
        tag: 'UnsupportedAttachment',
        message: 'Choose a PNG, JPEG, WebP or GIF picture.',
        status: 400,
      },
      {
        name: 'declared type disagrees with bytes',
        attachments: [{ ...png, mimeType: 'image/jpeg' }],
        tag: 'UnsupportedAttachment',
        message: 'The picture type does not match its contents.',
        status: 400,
      },
      {
        name: 'unrecognized bytes',
        attachments: [{ ...png, data: 'aGVsbG8=' }],
        tag: 'UnsupportedAttachment',
        message: 'The picture type does not match its contents.',
        status: 400,
      },
      {
        name: 'malformed base64',
        attachments: [{ ...png, data: `${png.data}\n` }],
        tag: 'InvalidAttachment',
        message: 'The picture data must be valid base64.',
        status: 400,
      },
      {
        name: 'decoded bytes above 5 MB',
        attachments: [
          { ...png, data: NodeBuffer.Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') },
        ],
        tag: 'AttachmentTooLarge',
        message: 'Each picture must be 5 MB or smaller.',
        status: 413,
      },
      {
        name: 'base64 larger than the allocation limit',
        attachments: [{ ...png, data: 'A'.repeat(4 * Math.ceil((5 * 1024 * 1024) / 3) + 4) }],
        tag: 'AttachmentTooLarge',
        message: 'Each picture must be 5 MB or smaller.',
        status: 413,
      },
      {
        name: 'five pictures',
        attachments: [png, png, png, png, png],
        tag: 'TooManyAttachments',
        message: 'Send at most four pictures in one message.',
        status: 400,
      },
    ]
    for (const refusal of refusals) {
      it.effect(`refuses ${refusal.name} with its actionable tag before delivery`, () =>
        Effect.gen(function* () {
          const test = yield* harness()
          yield* privateThread(test)
          const response = yield* post(test, {
            kind: 'user',
            body: 'Look',
            attachments: refusal.attachments,
          })
          expect(response.status).toBe(refusal.status)
          expectPictureRefusal(response, refusal.tag, refusal.message)
          expect(yield* Ref.get(test.admitted)).toHaveLength(0)
          expect(yield* (yield* RunStore).list(test.threadId)).toHaveLength(0)
        }).pipe(Effect.scoped),
      )
    }

    it.effect('refuses a message that declares more than four pictures can weigh, unread', () =>
      Effect.gen(function* () {
        const test = yield* harness()
        yield* privateThread(test)
        const response = yield* gateway(
          test,
          new Request(`http://gateway.test/api/vivid/${test.threadId}`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${test.token}`,
              host: 'gateway.test',
              'content-type': 'application/json',
              'content-length': String(29 * 1024 * 1024),
            },
            body: JSON.stringify({ kind: 'user', body: 'Look' }),
          }),
        )
        expect(response.status).toBe(413)
        expect(yield* Ref.get(test.admitted)).toHaveLength(0)
      }).pipe(Effect.scoped),
    )

    const secondPicture = { ...png, filename: 'second.png' }
    const keyedChanges = [
      { name: 'removing all pictures', body: 'Look', attachments: [] },
      { name: 'removing one picture', body: 'Look', attachments: [png] },
      { name: 'picture order', body: 'Look', attachments: [secondPicture, png] },
      {
        name: 'filenames',
        body: 'Look',
        attachments: [png, { ...secondPicture, filename: 'changed.png' }],
      },
      {
        name: 'picture bytes',
        body: 'Look',
        attachments: [png, { ...secondPicture, data: `${png.data.slice(0, -4)}AAAA` }],
      },
      { name: 'adding a picture', body: 'Look', attachments: [png, secondPicture, png] },
      { name: 'message text', body: 'Different text', attachments: [png, secondPicture] },
    ]
    for (const change of keyedChanges) {
      it.effect(
        `keyed admission conflicts on ${change.name} after rebuilding the Conversation service`,
        () =>
          Effect.gen(function* () {
            const test = yield* harness()
            yield* privateThread(test)
            const body = {
              kind: 'user',
              body: 'Look',
              attachments: [png, secondPicture],
              idempotencyKey: 'immutable',
            }
            expect((yield* post(test, body)).status).toBe(202)
            const context = yield* Layer.build(
              conversationLayer.pipe(
                Layer.provide(silentChannelRepliesLayer),
                Layer.provide(test.services),
              ),
            )
            const conversation = yield* Conversation.pipe(Effect.provideContext(context))
            const response = yield* post(
              { ...test, conversation },
              {
                ...body,
                body: change.body,
                attachments: change.attachments,
              },
            )
            expect(response.status).toBe(409)
            expect(response.body).toHaveProperty(
              'text',
              JSON.stringify({
                error: {
                  message:
                    'This message key was already used for different text or pictures. Send it with a new key.',
                },
              }),
            )
            expect(yield* Ref.get(test.admitted)).toHaveLength(1)
            expect(yield* (yield* RunStore).list(test.threadId)).toHaveLength(1)
          }).pipe(Effect.scoped),
      )
    }

    it.effect(
      'serves private bytes inline with safe headers and hides them from a non-participant',
      () =>
        Effect.gen(function* () {
          const test = yield* harness()
          yield* privateThread(test)
          const url = `http://gateway.test/api/vivid/${test.threadId}/attachments/picture`
          const hidden = yield* gateway(
            test,
            new Request(url, {
              headers: { authorization: `Bearer ${test.outsiderToken}` },
            }),
          )
          expect(hidden.status).toBe(404)
          expect(yield* Ref.get(test.reads)).toBe(0)
          const response = yield* gateway(
            test,
            new Request(url, {
              headers: { authorization: `Bearer ${test.token}` },
            }),
          )
          expect(response.status).toBe(200)
          expect(response.headers).toMatchObject({
            'content-type': 'image/png',
            'content-disposition': 'inline',
            'x-content-type-options': 'nosniff',
            'cache-control': 'private, no-store',
          })
          const web = HttpServerResponse.toWeb(response)
          const bytes = yield* Effect.promise(() => web.arrayBuffer())
          expect(NodeBuffer.Buffer.from(bytes).toString('base64')).toBe(png.data)
        }).pipe(Effect.scoped),
    )

    it.effect('refuses upstream attachment bytes with an unsafe content type', () =>
      Effect.gen(function* () {
        const test = yield* harness()
        yield* privateThread(test)
        yield* Ref.update(test.readHeaders, (headers) => ({
          ...headers,
          'content-type': 'text/html',
        }))
        const response = yield* gateway(
          test,
          new Request(`http://gateway.test/api/vivid/${test.threadId}/attachments/picture`, {
            headers: { authorization: `Bearer ${test.token}` },
          }),
        )
        expect(response.status).toBe(400)
        expectPictureRefusal(
          response,
          'UnsupportedAttachment',
          'This attachment is not a supported picture.',
        )
        expect(response.headers['content-disposition']).toBeUndefined()
      }).pipe(Effect.scoped),
    )
  })

  /** The production settlement observer offers RunEnded on the actual shared Device registry. */
  describe.skipIf(!testDatabaseConfigured)('Device Run settlement', () => {
    it.effect('ends window work once on settlement and never announces a Run without it', () =>
      Effect.gen(function* () {
        const test = yield* harness()
        const registry = test.devices
        const installation = InstallationId.make(NodeCrypto.randomUUID())
        const device = yield* registry.enrol(test.ada, { installation, name: 'Windows test' })
        yield* registry.allow(test.ada, device.id)
        const acts = yield* Queue.unbounded<typeof DeviceRequest.cases.Act.Type>()
        const ends = yield* Queue.unbounded<RunId>()
        const sessionId = SessionId.make(NodeCrypto.randomUUID())
        const stream = yield* registry.watch({
          personId: test.ada,
          sessionId,
          device: device.id,
          installation,
          ability: { pages: true, apps: true },
        })
        yield* stream.pipe(
          Stream.runForEach((request) =>
            DeviceRequest.match(request, {
              Act: (act) => Queue.offer(acts, act),
              RunEnded: ({ runId }) => Queue.offer(ends, runId),
            }),
          ),
          Effect.forkScoped,
        )
        const admitted = yield* test.conversation.admit(said(test.threadId, test.ada))
        const running = yield* registry
          .window({
            personId: test.ada,
            threadId: test.threadId,
            runId: admitted.runId,
            action: WindowAction.cases.ListWindows.make({}),
          })
          .pipe(Effect.forkScoped)
        const request = yield* Queue.take(acts)
        yield* registry
          .answer(test.ada, sessionId, {
            device: device.id,
            id: request.id,
            answer: DeviceAnswer.cases.Did.make({
              result: WindowResult.cases.Windows.make({ windows: [] }),
            }),
          })
          .pipe(Effect.provideService(Runtime, test.runtime))
        yield* Fiber.join(running)
        yield* test.finish(admitted.runId)
        expect(yield* Queue.take(ends)).toBe(admitted.runId)
        yield* registry.ended(admitted.runId)
        expect(yield* Queue.size(ends)).toBe(0)
        const quiet = yield* test.conversation.admit(said(test.threadId, test.ada))
        yield* test.finish(quiet.runId)
        yield* registry.ended(quiet.runId)
        expect(yield* Queue.size(ends)).toBe(0)
      }).pipe(Effect.scoped),
    )
  })
})
