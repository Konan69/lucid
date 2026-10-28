import { silentChannelRepliesLayer } from '../channels/replies.ts'
import { DeviceRegistry } from '../computers/device.ts'
import { ThreadTitles } from './generation.ts'
import * as NodeCrypto from 'node:crypto'
import * as NodeBuffer from 'node:buffer'
import { describe, expect, layer } from '@effect/vitest'
import {
  InputAnswer,
  CompanyId,
  InputRequestState,
  InstallationId,
  SessionId,
  DeviceRequest,
  DeviceAnswer,
  WindowAction,
  WindowResult,
  Conflict,
  DatabaseUnavailable,
  PersonId,
  Company,
  Workspace,
  RunId,
  RunState,
  RuntimeUnavailable,
  RuntimeRunRequest,
  RuntimeSubmissionId,
  RuntimeSettlement,
  SendToThreadRequest,
  ThreadId,
} from '@vivid/contracts'
import { eq, inArray } from 'drizzle-orm'
import {
  Clock,
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
  Match,
  Schema,
  Stream,
} from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import * as HttpRouter from 'effect/http/HttpRouter'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'
import * as HttpClient from 'effect/http/HttpClient'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { authenticate } from '../auth/session.ts'
import { requireThread } from './access.ts'
import { messagePictures, IncomingMessage } from './pictures.ts'
import { requestProtocolLayer } from '../rpc/requests.ts'
import * as RpcSerialization from 'effect/rpc/RpcSerialization'
import { sendToThread } from './relay.ts'
import { findPerson, type Actor } from '../auth/access.ts'
import { InputStore, inputStoreLayer } from '../inputs/store.ts'
import { personTable, sessionTable } from '../auth/tables.ts'
import { companyTable, membershipTable } from '../companies/tables.ts'
import { Database } from '../database/client.ts'
import { testConfigLayer, testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { Changes, Topic, silentChangesLayer } from '../live/changes.ts'
import { Notifier, type Notice } from '../notifications/notifier.ts'
import { Message } from '../observability/messages.ts'
import {
  Admission,
  AdmissionRefused,
  AdmissionUncertain,
  Runtime,
  Settlement,
  runtimeLayer,
} from '../runtime/client.ts'
import { deliveryRunId } from '../threads/key.ts'
import {
  Conversation,
  DeliveryMessage,
  DeliverySpeaker,
  StoredRunOrigin,
  type Delivery,
  type SignalDelivery,
} from './conversation.ts'
import { authLayer } from '../auth/provider.ts'
import { conversationLayer } from './delivery.ts'
import { gatewayRoutes } from './gateway.ts'
import { Presence } from './presence.ts'
import { RunStore, runStoreLayer, TurnReservation } from './runs.ts'
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
  const attempted = yield* Queue.unbounded<void>()
  const failure = yield* Ref.make(Option.none<AdmissionRefused | AdmissionUncertain>())
  const reads = yield* Ref.make(0)
  const readHeaders = yield* Ref.make({
    'content-type': 'image/png',
    'content-disposition': 'attachment; filename="unsafe.html"',
    'cache-control': 'public, max-age=3600',
  })
  const settlements = new Map<RunId, Deferred.Deferred<Settlement>>()
  const observers = new Map<RunId, Fiber.Fiber<unknown, unknown>>()
  const runtime = Runtime.of({
    admit: Effect.fn('Delivery.test.admit')(function* (input) {
      yield* Ref.update(requests, (all) => [...all, input])
      yield* Queue.offer(attempted, undefined)
      const rejected = yield* Ref.get(failure)
      if (Option.isSome(rejected)) return yield* rejected.value
      const id = deliveryRunId(input.threadId, input.idempotencyKey)
      const repeated = settlements.has(id)
      if (!repeated) {
        settlements.set(id, yield* Deferred.make<Settlement>())
        yield* Ref.update(admitted, (all) => [...all, input])
      }
      return Admission.make({
        runId: id,
        submissionId: RuntimeSubmissionId.make(input.turn),
        repeated,
      })
    }),
    settled: Effect.fn('Delivery.test.settled')(function* (_threadId, id) {
      const settlement = settlements.get(id)
      // Other integration suites may own working rows; this runtime cannot settle their Runs.
      return yield* Effect.withFiber((fiber) => {
        observers.set(id, fiber)
        return settlement === undefined ? Effect.never : Deferred.await(settlement)
      })
    }),
    stop: Effect.fn('Delivery.test.stop')(() => Effect.succeed(false)),
    watch: () => Stream.never,
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
  return {
    runtime,
    admitted,
    requests,
    attempted,
    finish,
    settle,
    failure,
    reads,
    readHeaders,
    observers,
  }
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
  const notices = yield* Ref.make<ReadonlyArray<Notice>>([])
  const watching = yield* Ref.make(true)
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
    Layer.mock(ThreadTitles, { afterRun: () => Effect.void }),
    Layer.succeed(
      Notifier,
      Notifier.of({
        notify: Effect.fn('Delivery.test.notify')((notice) =>
          Ref.update(notices, (previous) => [...previous, notice]),
        ),
      }),
    ),
    Layer.mock(Presence, {
      watching: Effect.fn('Delivery.test.watching')(() => Ref.get(watching)),
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
    // The actual observing fiber owns post-settlement notification and learning. Joining it
    // prevents a zero-notice assertion from racing work after the SQL end receipt.
    const observer = runtime.observers.get(id)
    if (observer === undefined) expect.fail('Missing Run observer')
    expect((yield* Fiber.await(observer))._tag).toBe('Success')
  })
  return {
    ...rows,
    ...runtime,
    ...recorded,
    conversation,
    devices,
    finish,
    services,
    topics,
    notices,
    watching,
  }
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
      questions: [
        {
          question: 'Which day works?',
          options: [{ label: 'Monday', detail: 'Start the week' }],
          selection: 'One',
          allowsOwnAnswer: true,
        },
      ],
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

const decodeIncoming = Schema.decodeUnknownEffect(IncomingMessage)
const decodeSend = Schema.decodeEffect(SendToThreadRequest)

/** The handler receives contract-decoded input and the authenticated Person, as RPC dispatch does.
 * Invalid wire pictures exercise the shared validator before they can become typed RPC input. */
const post = Effect.fn('Relay.test.send')(function* (test: Harness, body: Schema.JsonObject) {
  const auth = yield* authenticate(new Headers({ authorization: `Bearer ${test.token}` }))
  const context = AuthState.Person(auth)
  const sent = yield* decodeIncoming(body)
  const thread = yield* requireThread(test.threadId, auth.person.id)
  const input = yield* messagePictures(sent, thread).pipe(Effect.result)
  if (Result.isFailure(input)) {
    return HttpServerResponse.jsonUnsafe(
      { error: { _tag: input.failure._tag, message: input.failure.message } },
      { status: Predicate.isTagged(input.failure, 'AttachmentTooLarge') ? 413 : 400 },
    )
  }
  const request = yield* decodeSend({
    threadId: test.threadId,
    text: sent.body,
    pictures: input.success,
    key: sent.idempotencyKey === undefined ? NodeCrypto.randomUUID() : sent.idempotencyKey,
  }).pipe(Effect.result)
  if (Result.isFailure(request))
    return HttpServerResponse.jsonUnsafe(
      { error: { message: 'A message needs text or a picture' } },
      { status: 400 },
    )
  const result = yield* sendToThread(request.success).pipe(
    Effect.provideService(AuthContext, context),
    Effect.provideService(Conversation, test.conversation),
    Effect.result,
  )
  if (Result.isSuccess(result))
    return HttpServerResponse.jsonUnsafe(result.success, { status: 202 })
  const error = result.failure
  return HttpServerResponse.jsonUnsafe(
    { error: { message: error.message } },
    {
      status: Match.value(error).pipe(
        Match.tag('Conflict', () => 409),
        Match.tag('InvalidRequest', () => 400),
        Match.orElse(() => 503),
      ),
    },
  )
})

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
  { type: 'event', origin: StoredRunOrigin.cases.Watch.make({ watchName: 'Review' }) },
  { type: 'approval', origin: StoredRunOrigin.cases.Decision.make({}) },
  { type: 'answer', origin: StoredRunOrigin.cases.Decision.make({}) },
] as const

layer(
  databaseLayer.pipe(
    Layer.provideMerge(silentChangesLayer),
    Layer.provideMerge(authLayer),
    Layer.provideMerge(testConfigLayer),
  ),
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
          expect(delivered.message.body).toBe(body.body)
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
          const answered = yield* test.inputs.answer(actor, {
            id: request.id,
            answers: [InputAnswer.cases.Chosen.make({ labels: ['Monday'] })],
          })
          expect(InputRequestState.guards.Answered(answered.state)).toBe(true)
          expect(yield* test.inputs.inThread(test.threadId)).toEqual(
            expect.arrayContaining([answered, waiting]),
          )
          expect(yield* Ref.get(test.admitted)).toMatchObject([
            {
              message: {
                kind: 'signal',
                type: 'answer',
                body: 'Question: Which day works?\nAnswer: Monday',
                attributes: { from: 'Ben' },
              },
            },
          ])
          const admitted = (yield* Ref.get(test.admitted))[0]
          if (admitted === undefined) expect.fail('Missing answer delivery')
          yield* test.finish(deliveryRunId(test.threadId, admitted.idempotencyKey))
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
              runId: deliveryRunId(test.threadId, delivery.idempotencyKey),
              reason: 'Rejected',
            }),
          ),
        )
        const refused = yield* Effect.result(test.conversation.admit(delivery))
        expect(Result.isFailure(refused) && refused.failure._tag).toBe('RuntimeUnavailable')
        expect(yield* test.inputs.inThread(test.threadId)).toEqual([waiting])
        yield* Ref.set(test.failure, Option.none())
        yield* test.conversation.admit(said(test.threadId, test.ada))
        const busy = yield* Effect.result(test.conversation.admit(said(test.threadId, test.ben)))
        expect(Result.isFailure(busy) && busy.failure._tag).toBe('Conflict')
        expect(yield* test.inputs.inThread(test.threadId)).toEqual([waiting])
      }).pipe(Effect.scoped),
    )

    it.effect('Watch, wake, channel and server-written deliveries withdraw nothing', () =>
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
            origin: StoredRunOrigin.cases.Watch.make({ watchName: 'Review' }),
            speaker: DeliverySpeaker.cases.Vivid.make({}),
            message: DeliveryMessage.cases.Signal.make({
              type: 'event',
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
      'a Background Thread is never quoted by a notification: follow-ups, failures and questions',
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const test = yield* inputHarness()
            yield* Ref.set(test.watching, false)
            const database = yield* Database
            const place = (to: 'Conversation' | 'Background') =>
              database.run(
                database.update(threads).set({ place: to }).where(eq(threads.id, test.threadId)),
              )
            /** Settle a Run and wait for its observer, which owns any notification. */
            const settled = Effect.fn('Delivery.test.settled')(function* (
              id: RunId,
              settlement: Settlement,
            ) {
              yield* test.settle(id, settlement)
              expect(yield* Queue.take(test.ended)).toBe(id)
              const observer = test.observers.get(id)
              if (observer === undefined) expect.fail('Missing Run observer')
              expect((yield* Fiber.await(observer))._tag).toBe('Success')
            })
            yield* place('Background')
            // The Person answers from the Feed: a Message-origin Run that completes.
            const followUp = yield* test.conversation.admit(said(test.threadId, test.ada))
            yield* test.finish(followUp.runId)
            const failing = yield* test.conversation.admit(said(test.threadId, test.ada))
            yield* settled(
              failing.runId,
              Settlement.cases.Failed.make({ reason: 'ModelUnavailable', providerStatus: 520 }),
            )
            const unknown = yield* test.conversation.admit(said(test.threadId, test.ada))
            yield* settled(unknown.runId, Settlement.cases.Unknown.make({}))
            // A question raised there waits for the Person in the Feed, not in a notification.
            const question = yield* askFor(test, test.ada, test.threadId)
            expect(question.state._tag).toBe('Waiting')
            expect(yield* Ref.get(test.notices)).toEqual([])
            // The same Run in a Conversation is announced, so the silence above is the place's.
            yield* place('Conversation')
            const spoken = yield* test.conversation.admit(said(test.threadId, test.ada))
            yield* test.finish(spoken.runId)
            expect((yield* Ref.get(test.notices)).map((notice) => notice.kind)).toEqual([
              'finished',
            ])
          }),
        ),
    )
    layer(
      databaseLayer.pipe(
        Layer.provideMerge(silentChangesLayer),
        Layer.provideMerge(testConfigLayer),
      ),
    )('Settlement clock', (clockIt) => {
      clockIt.effect('database read failures leave a Run working until the runtime settles', () =>
        Effect.gen(function* () {
          const test = yield* harness()
          const database = yield* Database
          const failed = yield* Queue.unbounded<void>()
          const waiting = yield* Deferred.make<void>()
          const settled = yield* Deferred.make<void>()
          let reads = 0
          // The first address read and first receipt read lose their connection, the way a pool
          // reset or failover answers; the server must keep the Run working and read again.
          const interruptedReads = Layer.succeed(
            Database,
            Database.of({
              _: database._,
              query: database.query,
              $with: database.$with,
              $cache: database.$cache,
              $count: database.$count.bind(database),
              with: database.with.bind(database),
              select: database.select.bind(database),
              selectDistinct: database.selectDistinct.bind(database),
              selectDistinctOn: database.selectDistinctOn.bind(database),
              insert: database.insert.bind(database),
              update: database.update.bind(database),
              delete: database.delete.bind(database),
              refreshMaterializedView: database.refreshMaterializedView.bind(database),
              execute: database.execute.bind(database),
              transaction: (operation) => database.transaction(operation),
              run: (operation) =>
                Effect.suspend(() => {
                  reads += 1
                  if (reads !== 1 && reads !== 3) return database.run(operation)
                  return Queue.offer(failed, undefined).pipe(
                    Effect.andThen(
                      Effect.fail(new DatabaseUnavailable({ message: 'Database is unavailable' })),
                    ),
                  )
                }),
            }),
          )
          const http = HttpClient.make((request) =>
            Deferred.succeed(waiting, undefined).pipe(
              Effect.andThen(Deferred.await(settled)),
              Effect.as(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    JSON.stringify(
                      RuntimeSettlement.cases.Done.make({
                        answeredBy: RuntimeSubmissionId.make(1),
                        reply: 'Finished',
                        toolCalls: 0,
                      }),
                    ),
                    { headers: { 'content-type': 'application/json' } },
                  ),
                ),
              ),
            ),
          )
          const context = yield* Layer.build(
            runtimeLayer.pipe(
              Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
              Layer.provide(testConfigLayer),
              Layer.provide(interruptedReads),
            ),
          )
          const runtime = yield* Runtime.pipe(Effect.provideContext(context))
          const observing = yield* Layer.build(
            conversationLayer.pipe(
              Layer.provide(silentChannelRepliesLayer),
              Layer.provide(
                Layer.merge(
                  test.services,
                  Layer.succeed(Runtime, { ...test.runtime, settled: runtime.settled }),
                ),
              ),
            ),
          )
          const conversation = yield* Conversation.pipe(Effect.provideContext(observing))
          const receipt = yield* conversation.admit(said(test.threadId, test.ben))
          const store = yield* RunStore
          for (let failure = 0; failure < 2; failure += 1) {
            yield* Queue.take(failed)
            expect((yield* store.list(test.threadId)).map((run) => run.state._tag)).toEqual([
              'Working',
            ])
            yield* TestClock.adjust('1 second')
          }
          yield* Deferred.await(waiting)
          expect((yield* store.list(test.threadId)).map((run) => run.state._tag)).toEqual([
            'Working',
          ])
          yield* Deferred.succeed(settled, undefined)
          expect(yield* Queue.take(test.ended)).toBe(receipt.runId)
          expect((yield* store.list(test.threadId)).map((run) => run.state._tag)).toEqual([
            'Completed',
          ])
        }).pipe(Effect.scoped),
      )
    })

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
    layer(
      databaseLayer.pipe(
        Layer.provideMerge(silentChangesLayer),
        Layer.provideMerge(testConfigLayer),
      ),
    )('Clock case 1', (clockIt) => {
      clockIt.effect(
        'refused and uncertain admission end the Run with Delivery and release it for Ben',
        () =>
          Effect.gen(function* () {
            for (const failure of admissionFailures) {
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const test = yield* harness()
                  // The error names the Run its request would have started, as the real client's does.
                  const message = said(test.threadId, test.ada)
                  const runId = deliveryRunId(test.threadId, message.idempotencyKey)
                  yield* Ref.set(test.failure, Option.some(failure.make(test.threadId, runId)))
                  const rejecting = yield* test.conversation
                    .admit(message)
                    .pipe(Effect.result, Effect.forkChild)
                  if (failure.name === 'uncertain') {
                    yield* Queue.take(test.attempted)
                    yield* TestClock.adjust('1 second')
                    expect(yield* Ref.get(test.requests)).toHaveLength(2)
                    yield* TestClock.adjust('2 seconds')
                  }
                  const rejected = yield* Fiber.join(rejecting)
                  expect(Result.isFailure(rejected) && rejected.failure).toBeInstanceOf(
                    RuntimeUnavailable,
                  )
                  const recorded = yield* (yield* RunStore).list(test.threadId)
                  expect(recorded.map((run) => run.state)).toEqual([
                    RunState.cases.Failed.make({
                      finishedAt: yield* Clock.currentTimeMillis,
                      reason: 'Delivery',
                    }),
                  ])
                  const attempts = failure.name === 'uncertain' ? 3 : 1
                  expect(yield* Ref.get(test.requests)).toHaveLength(attempts)
                  expect(yield* Ref.get(test.admitted)).toEqual([])
                  yield* Ref.set(test.failure, Option.none())
                  yield* test.conversation.admit(said(test.threadId, test.ben))
                  expect(yield* Ref.get(test.admitted)).toHaveLength(1)
                  expect(yield* Ref.get(test.requests)).toHaveLength(attempts + 1)
                }),
              )
            }
          }),
      )
    })

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
        expect(ben.submissionId).toBe(2)
        expect((yield* Ref.get(test.admitted)).map((delivery) => delivery.scope.acting)).toEqual([
          test.ada,
          test.ben,
        ])
      }).pipe(Effect.scoped),
    )

    it.effect('allows Ada’s own Watch to join and holds Ben until both joined Runs settle', () =>
      Effect.gen(function* () {
        const test = yield* harness()
        const first = yield* test.conversation.admit(said(test.threadId, test.ada))
        const wake = said(test.threadId, test.ada)
        const second = yield* test.conversation.admit({
          ...wake,
          origin: StoredRunOrigin.cases.Watch.make({ watchName: 'Review' }),
          message: DeliveryMessage.cases.Signal.make({
            type: 'event',
            body: 'Review now.',
            attributes: { name: 'Review' },
          }),
        })
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

    it.effect('names the decider as speaker while Vivid acts for the original Person', () =>
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
          {
            scope: { acting: test.ada },
            message: {
              kind: 'signal',
              type: 'answer',
              body: 'Monday',
              attributes: { from: 'Ben' },
            },
          },
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

    it.effect(
      'Watch, approval and answer signals keep their words, speaker and replay key across Busy',
      () =>
        Effect.gen(function* () {
          for (const { type, origin } of signals) {
            yield* Effect.gen(function* () {
              const test = yield* harness()
              const ada = yield* test.conversation.admit(said(test.threadId, test.ada))
              const delivery: SignalDelivery = {
                speaker: DeliverySpeaker.cases.Acting.make({}),
                threadId: test.threadId,
                personId: test.ben,
                idempotencyKey: `${type}-receipt`,
                message: DeliveryMessage.cases.Signal.make({
                  type,
                  body: `${type}: independent server words`,
                  attributes: {},
                }),
                origin,
              }
              const pending = yield* Effect.result(test.conversation.deliver(delivery)).pipe(
                Effect.forkScoped,
              )
              expect(yield* Queue.take(test.blocked)).toBe(
                deliveryRunId(test.threadId, delivery.idempotencyKey),
              )
              expect(yield* Ref.get(test.admitted)).toHaveLength(1)
              const busy = yield* Fiber.join(pending)
              expect(Result.isFailure(busy) && busy.failure).toBeInstanceOf(Conflict)
              yield* test.finish(ada.runId)
              const admitted = yield* test.conversation.deliver(delivery)
              expect(admitted.id).toBe(deliveryRunId(test.threadId, delivery.idempotencyKey))
              expect(RunState.guards.Working(admitted.state)).toBe(true)
              expect((yield* Ref.get(test.admitted)).map((input) => input.scope.acting)).toEqual([
                test.ada,
                test.ben,
              ])
              expect((yield* Ref.get(test.requests)).map((input) => input.message)).toEqual([
                expect.objectContaining({
                  body: 'Please help',
                  attributes: { from: 'Ada', turn: '1' },
                }),
                {
                  kind: 'signal',
                  type,
                  tagName: type,
                  body: `${type}: independent server words`,
                  attributes: { from: 'Ben', turn: '2' },
                },
              ])
              const replayed = yield* test.conversation.deliver(delivery)
              expect(replayed.id).toBe(admitted.id)
              expect(yield* (yield* RunStore).list(test.threadId)).toHaveLength(2)
            }).pipe(Effect.scoped)
          }
        }),
    )

    it.effect(
      'the gateway repeats one client key with one Run, one turn and the same receipt',
      () =>
        Effect.gen(function* () {
          const test = yield* harness()
          const send = () =>
            post(test, { kind: 'user', body: 'Please help', idempotencyKey: 'lost-http-response' })
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
        const response = yield* post(test, { kind: 'user', body: 'Please help' })
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
                    submissionId: delivery.turn,
                    repeated: false,
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
              Layer.provide(Layer.succeed(Database, yield* Database)),
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
            { body: 'Look', attributes: {}, attachments: [png] },
          ])
        }).pipe(Effect.scoped),
    )
    it.effect('the sending key survives a private picture-only RPC send', () =>
      Effect.gen(function* () {
        const test = yield* harness()
        yield* privateThread(test)
        const response = yield* post(test, {
          kind: 'user',
          body: '',
          attachments: [png],
          idempotencyKey: 'picture-key',
        })
        expect(response.status).toBe(202)
        expect((yield* Ref.get(test.admitted))[0]).toMatchObject({
          clientKey: 'picture-key',
          message: { kind: 'user', body: '', attachments: [png] },
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
      'carries a private picture without text through the gateway and preserves its keyed receipt',
      () =>
        Effect.gen(function* () {
          const test = yield* harness()
          yield* privateThread(test)
          const empty = yield* post(test, { kind: 'user', body: '', attachments: [] })
          expect(empty.status).toBe(400)
          expect(yield* Ref.get(test.admitted)).toHaveLength(0)
          expect(yield* (yield* RunStore).list(test.threadId)).toHaveLength(0)
          const body = {
            kind: 'user',
            body: '',
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
            message: { kind: 'user', body: body.body, attachments: [png] },
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
        let reads = 0
        const body = new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              reads += 1
              controller.enqueue(new TextEncoder().encode('{"kind":"user","body":"Look"}'))
              controller.close()
            },
          },
          { highWaterMark: 0 },
        )
        const requestOptions = {
          method: 'POST',
          headers: {
            authorization: `Bearer ${test.token}`,
            host: 'gateway.test',
            'content-type': 'application/json',
            'content-length': String(29 * 1024 * 1024),
          },
          body,
          duplex: 'half' as const,
        }
        const handle = yield* HttpRouter.toHttpEffect(
          requestProtocolLayer.pipe(Layer.provide(RpcSerialization.layerNdjson)),
        )
        const response = yield* handle.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(new Request('http://gateway.test/api/rpc', requestOptions)),
          ),
        )
        expect(response.status).toBe(413)
        expect(reads).toBe(0)
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
    // Each mutation is an independent replay contract. Separate cases retain the real gateway,
    // reconstruction and single-Run checks without charging seven requests to one test budget.
    for (const change of keyedChanges) {
      it.effect(`keyed picture admission rejects ${change.name} after reconstruction`, () =>
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
          // A second rejection on this reconstructed key must not replace its original receipt.
          const rejectedAgain = yield* post(
            { ...test, conversation },
            { ...body, body: 'Another changed message', attachments: [] },
          )
          expect(rejectedAgain.status).toBe(409)
          expect((yield* post({ ...test, conversation }, body)).status).toBe(202)
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
          ability: { pages: true, apps: true, egress: false, signins: false },
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
