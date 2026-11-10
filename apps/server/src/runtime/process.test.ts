import { PgClient } from '@effect/sql-pg/PgClient'
import { pushTestLayer } from '../push/testing.ts'
import { takeNotification } from '../notifications/delivery.ts'
import { notifications } from '../notifications/tables.ts'
import * as TestClock from 'effect/testing/TestClock'
import { readThreadHistory } from './history.ts'
import { ChannelReplies } from '../channels/replies.ts'
import { Deferred, Ref } from 'effect'
import { eq, sql } from 'drizzle-orm'
import * as NodeCrypto from 'node:crypto'
import { expect, layer } from '@effect/vitest'
import {
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate,
  Queue,
  Redacted,
  Result,
  Schema,
  Scope,
  Stream,
} from 'effect'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientError from 'effect/http/HttpClientError'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'
import {
  ConversationFrame,
  NotFound,
  Person,
  PersonId,
  RunId,
  SessionId,
  Workspace,
} from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { world, start, held } from '@vivid/agent-runtime/testing'
import { findPerson } from '../auth/access.ts'
import { sessionTable } from '../auth/tables.ts'
import { ServerConfig } from '../config.ts'
import { Database } from '../database/client.ts'
import { testConfigLayer } from '../database/testdb.ts'
import { silentChangesLayer } from '../live/changes.ts'
import { Notifier } from '../notifications/notifier.ts'
import { Conversation } from '../threads/conversation.ts'
import { ComputerStore } from '../computers/store.ts'
import { IntegrationAnswers } from '../connections/answers.ts'
import { InputStore } from '../inputs/store.ts'
import { conversationLayer } from '../threads/delivery.ts'
import { ThreadTitles } from '../threads/generation.ts'
import { Presence } from '../threads/presence.ts'
import { RunStore, RunEnding } from '../threads/runs.ts'
import { runs, threads } from '../threads/tables.ts'
import { sendToThread, watchConversation } from '../threads/relay.ts'
import { threadStoreLayer } from '../threads/store.ts'
import { threadHandlers } from '../threads/handlers.ts'
import { ChildRuns } from '../runs/store.ts'
import { Runtime, runtimeLayer } from './client.ts'
import { productFixture, productLayer } from './testing.ts'

const decodeBody = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

type Receipt =
  | 'NodeDown'
  | 'SlowAdmission'
  | 'Kept'
  | 'LostOnce'
  | 'AbortLostOnce'
  | 'AbortNotTaken'

/** Adapt only the socket. HTTP requests still cross the production router into real Pi on disposable native SQLite. */
const transport = (
  process: Effect.Success<ReturnType<typeof start>>,
  receipt: Receipt,
  admission: {
    readonly entered: Deferred.Deferred<void>
    readonly release: Deferred.Deferred<void>
  },
) => {
  let lost = false
  return HttpClient.make((request) =>
    Effect.gen(function* () {
      const url = new URL(request.url)
      if (url.hostname === 'down.test')
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request }),
        })
      if (receipt === 'SlowAdmission' && request.method === 'POST') {
        yield* Deferred.succeed(admission.entered, undefined)
        yield* Deferred.await(admission.release)
      }
      if (request.headers.accept === 'text/event-stream') {
        const link = yield* process.link(url.pathname)
        const events = Stream.fromEffectRepeat(link.event).pipe(
          Stream.takeWhile(Option.isSome),
          Stream.map((event) => new TextEncoder().encode(`${event.value}\n\n`)),
          Stream.ensuring(link.leave),
        )
        return HttpClientResponse.fromWeb(
          request,
          new Response(yield* Stream.toReadableStreamEffect(events), {
            headers: { 'content-type': 'text/event-stream' },
          }),
        )
      }
      if (request.method !== 'GET' && request.method !== 'POST')
        expect.fail('Unexpected runtime method')
      const path = `${url.pathname}${url.search}`
      const body = Predicate.isTagged(request.body, 'Uint8Array')
        ? yield* decodeBody(new TextDecoder().decode(request.body.body))
        : undefined
      if (receipt === 'AbortLostOnce' && !lost && url.pathname.endsWith('/abort')) {
        lost = true
        return HttpClientResponse.fromWeb(
          request,
          new Response('{"error":"Unavailable"}', { status: 503 }),
        )
      }
      if (receipt === 'AbortNotTaken' && url.pathname.endsWith('/abort'))
        return HttpClientResponse.fromWeb(request, new Response('{"aborted":false}'))
      const response = yield* process.send(path, { method: request.method, body })
      if (receipt === 'LostOnce' && !lost && request.method === 'POST' && response.status === 202) {
        lost = true
        return HttpClientResponse.fromWeb(
          request,
          new Response('{"error":"Unavailable"}', { status: 503 }),
        )
      }
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(response.body), {
          status: response.status,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }).pipe(
      Effect.mapError(
        () =>
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request }),
          }),
      ),
    ),
  )
}

/**
 * Whether a settled Run's notice is owed. `Watched`: the Person is watching, so none is.
 * `Unowed`: nobody is watching and owing it fails in SQL inside the settlement's transaction.
 */
type Notices = 'Watched' | 'Unowed'

/** The real server reservation and settlement observer use an independent Person, Thread and session. */
const fixture = Effect.fn('PiServer.test.fixture')(function* (
  receipt: Receipt,
  notices: Notices = 'Watched',
) {
  const rows = yield* productFixture()
  const database = yield* Database
  const given = yield* world()
  const process = yield* start(given)
  const person = yield* findPerson(rows.personId)
  if (Option.isNone(person)) expect.fail('Fixture Person missing')
  const sessionId = SessionId.make(NodeCrypto.randomUUID())
  yield* database.run(
    database.insert(sessionTable).values({
      id: sessionId,
      userId: rows.personId,
      token: NodeCrypto.randomUUID(),
      expiresAt: new Date('2100-01-01'),
    }),
  )
  const auth = AuthState.Person({
    person: person.value,
    workspace: Workspace.cases.Personal.make({}),
    sessionId,
  })
  const store = yield* RunStore
  const stopped = yield* Queue.unbounded<void>()
  // Channel replies go out after the settlement commits, so a settlement read from here is in the
  // database. `RunStore.end` itself runs inside the observer's transaction and cannot say that.
  const reported = yield* Queue.unbounded<string>()
  const titles = yield* Ref.make(0)
  const observed = RunStore.of({
    ...store,
    end: (id, ending) =>
      store
        .end(id, ending)
        .pipe(
          Effect.tap((changed) =>
            changed && RunEnding.guards.Stopped(ending)
              ? Queue.offer(stopped, undefined)
              : Effect.void,
          ),
        ),
  })
  const admission = { entered: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() }
  const config = yield* ServerConfig
  const runtimeContext = yield* Layer.build(
    runtimeLayer.pipe(
      Layer.provide([
        Layer.succeed(ServerConfig, {
          ...config,
          RUNTIME_URLS:
            receipt === 'NodeDown'
              ? [new URL('http://down.test'), new URL('http://runtime.test')]
              : [new URL('http://runtime.test')],
          RUNTIME_TOKEN: Redacted.make('fixture-runtime-token'),
        }),
        Layer.succeed(HttpClient.HttpClient, transport(process, receipt, admission)),
        Layer.succeed(Database, database),
      ]),
    ),
  )
  const runtime = yield* Runtime.pipe(Effect.provideContext(runtimeContext))
  const foundation = Layer.mergeAll(
    Layer.succeed(Database, database),
    Layer.succeed(RunStore, observed),
    Layer.succeed(Runtime, runtime),
    threadStoreLayer.pipe(Layer.provide(Layer.succeed(Database, database))),
    silentChangesLayer,
    Layer.mock(ThreadTitles, { afterRun: () => Ref.update(titles, (count) => count + 1) }),
    Layer.mock(Presence, { watching: () => Effect.succeed(notices === 'Watched') }),
    Layer.succeed(Notifier, {
      // A statement that fails aborts the surrounding PostgreSQL transaction, as a real failed owe does.
      notify: () => database.run(database.execute(sql`select 1 / 0`)).pipe(Effect.asVoid),
    }),
    // These Threads start no helpers; Thread Stop finds none to stop.
    Layer.mock(ChildRuns, { stopThread: () => Effect.void }),
  )
  let serverScope = yield* Scope.make()
  yield* Effect.addFinalizer(() => Scope.close(serverScope, Exit.void))
  const serverLayer = conversationLayer.pipe(
    Layer.provide([
      foundation,
      Layer.succeed(ChannelReplies, {
        ended: ({ settlement }) => Queue.offer(reported, settlement._tag).pipe(Effect.asVoid),
      }),
    ]),
  )
  const server = yield* Layer.buildWithScope(serverLayer, serverScope)
  let conversation = yield* Conversation.pipe(Effect.provideContext(server))
  const scope = yield* Layer.build(foundation)
  // No step is handed over and no Integration asks in this Thread, so a send reaches neither the
  // Computer nor an Integration's paused call.
  const computers = yield* Layer.build(
    Layer.mergeAll(
      Layer.mock(ComputerStore, {}),
      Layer.mock(InputStore, { cancelWithdrawn: () => Effect.void }),
      Layer.mock(IntegrationAnswers, {}),
    ),
  )
  return {
    ...rows,
    admission,
    given,
    runtime,
    stopped,
    reported,
    titles,
    store: {
      ...store,
      get: (id: RunId) =>
        store.list(rows.threadId).pipe(
          Effect.flatMap((recorded) => {
            const run = recorded.find((entry) => entry.id === id)
            return run === undefined
              ? Effect.fail(new NotFound({ message: 'Run not found' }))
              : Effect.succeed(run)
          }),
        ),
    },
    restart: Effect.gen(function* () {
      yield* Scope.close(serverScope, Exit.void)
      serverScope = yield* Scope.make()
      const restarted = yield* Layer.buildWithScope(Layer.fresh(serverLayer), serverScope)
      conversation = yield* Conversation.pipe(Effect.provideContext(restarted))
    }),
    send: (key: string) =>
      sendToThread({ threadId: rows.threadId, text: 'Help me', pictures: [], key }).pipe(
        Effect.provideService(AuthContext, auth),
        Effect.provideService(Conversation, conversation),
        // No step is handed over in this Thread, so a send never reaches the Computer.
        Effect.provide(computers),
        Effect.provideContext(scope),
      ),
    watch: watchConversation({ threadId: rows.threadId }).pipe(
      Stream.provideService(AuthContext, auth),
      Stream.provideContext(scope),
    ),
    stop: Effect.suspend(() =>
      threadHandlers
        .StopThread({ id: rows.threadId })
        .pipe(
          Effect.provideService(AuthContext, auth),
          Effect.provideService(Conversation, conversation),
          Effect.provideContext(scope),
        ),
    ),
    asPerson: (personId: PersonId) =>
      watchConversation({ threadId: rows.threadId }).pipe(
        Stream.provideService(
          AuthContext,
          AuthState.Person({
            ...auth,
            person: new Person({
              id: personId,
              name: person.value.name,
              email: person.value.email,
              image: person.value.image,
            }),
          }),
        ),
        Stream.provideContext(scope),
      ),
  }
})

/** Inspect the actual product column, since Run's public shape intentionally hides its receipt. */
const receiptOf = Effect.fn('PiServer.test.receipt')(function* (id: RunId) {
  const database = yield* Database
  const [row] = yield* database.run(
    database.select({ receipt: runs.receipt }).from(runs).where(eq(runs.id, id)),
  )
  if (row === undefined) expect.fail('Missing reserved Run row')
  return row.receipt
})

layer(productLayer.pipe(Layer.provideMerge(testConfigLayer)), { excludeTestServices: true })(
  (it) => {
    it.effect('a down ingress node still admits and settles through the next node', () =>
      Effect.gen(function* () {
        const test = yield* fixture('NodeDown')
        const answer = yield* held('Reached through the peer')
        test.given.faux.setResponses([answer.factory])
        const { run } = yield* test.send('peer-node')
        yield* answer.entered
        yield* answer.release
        expect(yield* Queue.take(test.reported)).toBe('Completed')
        expect((yield* test.store.get(run.id)).state._tag).toBe('Completed')
      }).pipe(Effect.scoped),
    )

    it.effect('a corrupt Thread surfaces a storage failure instead of retrying forever', () =>
      Effect.gen(function* () {
        const test = yield* fixture('Kept')
        const database = yield* Database
        yield* database.run(
          database
            .update(threads)
            .set({ audience: 'corrupt' })
            .where(eq(threads.id, test.threadId)),
        )
        expect(
          (yield* Effect.flip(test.runtime.settled(test.threadId, RunId.make('unadmitted'))))._tag,
        ).toBe('DatabaseFailure')
      }).pipe(Effect.scoped),
    )

    it.effect('real Pi admission settles the reserved Run and repeating a key starts one Run', () =>
      Effect.gen(function* () {
        const test = yield* fixture('Kept')
        const answer = yield* held('The real reply')
        test.given.faux.setResponses([answer.factory])
        const first = yield* test.send('same-key')
        yield* answer.entered
        const second = yield* test.send('same-key')
        expect(second.run.id).toBe(first.run.id)
        expect(second.run.submissionId).toBe(first.run.submissionId)
        expect(first.run.submissionId).toMatch(/^[1-9][0-9]*$/u)
        expect(first.run.id).not.toBe(first.run.submissionId)
        expect(yield* receiptOf(first.run.id)).toEqual({
          runId: first.run.id,
          submissionId: first.run.submissionId,
        })
        expect(yield* test.store.list(test.threadId)).toHaveLength(1)
        yield* answer.release
        expect(yield* Queue.take(test.reported)).toBe('Completed')
        expect((yield* test.store.get(first.run.id)).state._tag).toBe('Completed')
      }).pipe(Effect.scoped),
    )

    it.effect(
      'a lost 503 receipt is retried in the sending request with one durable delivery',
      () =>
        Effect.gen(function* () {
          const test = yield* fixture('LostOnce')
          const answer = yield* held('One durable response')
          test.given.faux.setResponses([answer.factory])
          const { run } = yield* test.send('uncertain')
          yield* answer.entered
          expect(run.state._tag).toBe('Working')
          expect(run.submissionId).toBeDefined()
          expect((yield* test.store.list(test.threadId)).map((entry) => entry.turn)).toEqual([1])
          yield* answer.release
          expect(yield* Queue.take(test.reported)).toBe('Completed')
          expect((yield* test.store.get(run.id)).state._tag).toBe('Completed')
          expect(test.given.faux.state.callCount).toBe(1)
        }).pipe(Effect.scoped),
    )

    it.effect('a failed notice owe leaves a settled Run and a durable retry that repays it', () =>
      Effect.gen(function* () {
        const test = yield* fixture('Kept', 'Unowed')
        const answer = yield* held('Finished without a notice')
        test.given.faux.setResponses([answer.factory])
        const { run } = yield* test.send('unowed')
        yield* answer.entered
        yield* answer.release
        expect(yield* Queue.take(test.reported)).toBe('Completed')
        expect((yield* test.store.get(run.id)).state._tag).toBe('Completed')
        const sql = yield* PgClient
        expect(yield* sql`SELECT state FROM vivid_work WHERE id = ${`${run.id}:notice`}`).toEqual([
          { state: 'pending' },
        ])
        const deliveryContext = yield* Layer.build(pushTestLayer)
        yield* takeNotification().pipe(Effect.provideContext(deliveryContext))
        const database = yield* Database
        const recorded = yield* database.run(
          database
            .select()
            .from(notifications)
            .where(eq(notifications.conversationId, test.threadId)),
        )
        expect(recorded).toMatchObject([{ body: 'Finished without a notice', kind: 'finished' }])
        expect((yield* test.store.get(run.id)).state._tag).toBe('Completed')
        expect(yield* sql`SELECT state FROM vivid_work WHERE id = ${`${run.id}:notice`}`).toEqual([
          { state: 'completed' },
        ])
      }).pipe(Effect.scoped),
    )

    it.effect('a server restart reattaches observation of a working admitted Pi submission', () =>
      Effect.gen(function* () {
        const test = yield* fixture('Kept')
        const answer = yield* held('Still answering after restart')
        test.given.faux.setResponses([answer.factory])
        const { run } = yield* test.send('restart')
        yield* answer.entered
        yield* test.restart
        yield* answer.release
        expect(yield* Queue.take(test.reported)).toBe('Completed')
        expect((yield* test.store.get(run.id)).state._tag).toBe('Completed')
        expect(test.given.faux.state.callCount).toBe(1)
      }).pipe(Effect.scoped),
    )

    it.effect('a failed abort leaves the Run working and the next Stop succeeds', () =>
      Effect.gen(function* () {
        const test = yield* fixture('AbortLostOnce')
        const answer = yield* held('Held for stop')
        test.given.faux.setResponses([answer.factory])
        const { run } = yield* test.send('retry-stop')
        yield* answer.entered
        const result = yield* test.stop.pipe(Effect.result)
        expect(Result.isFailure(result) && result.failure._tag).toBe('RuntimeUnavailable')
        expect((yield* test.store.get(run.id)).state._tag).toBe('Working')
        yield* test.stop
        yield* Queue.take(test.stopped)
        expect(yield* Queue.take(test.reported)).toBe('Stopped')
        expect((yield* test.store.get(run.id)).state._tag).toBe('Stopped')
      }).pipe(Effect.scoped),
    )

    it.effect('an abort that took no work leaves the admitted Run to settle normally', () =>
      Effect.gen(function* () {
        const test = yield* fixture('AbortNotTaken')
        const answer = yield* held('Finished before abort took any work')
        test.given.faux.setResponses([answer.factory])
        const { run } = yield* test.send('abort-not-taken')
        yield* answer.entered
        yield* test.stop
        expect((yield* test.store.get(run.id)).state._tag).toBe('Working')
        expect(yield* Queue.size(test.stopped)).toBe(0)
        yield* answer.release
        expect(yield* Queue.take(test.reported)).toBe('Completed')
        expect((yield* test.store.get(run.id)).state._tag).toBe('Completed')
      }).pipe(Effect.scoped),
    )

    it.effect('real Pi reply sends Whole then Changes over the server RPC handler', () =>
      Effect.gen(function* () {
        const test = yield* fixture('Kept')
        const frames = yield* Queue.unbounded<ConversationFrame>()
        const watching = yield* test.watch.pipe(
          Stream.runForEach((frame) => Queue.offer(frames, frame)),
          Effect.forkScoped,
        )
        const first = yield* Queue.take(frames)
        expect(ConversationFrame.guards.Whole(first)).toBe(true)
        if (ConversationFrame.guards.Whole(first))
          expect(first.state).toMatchObject({ messages: [], working: false })
        const answer = yield* held('Reply on the socket')
        test.given.faux.setResponses([answer.factory])
        const { run } = yield* test.send('reply')
        yield* answer.entered
        expect((yield* Queue.take(frames))._tag).toBe('Changes')
        expect(run.submissionId).toMatch(/^[1-9][0-9]*$/u)
        const admitted = yield* test.watch.pipe(Stream.take(1), Stream.runCollect)
        const whole = admitted[0]
        if (whole === undefined || !ConversationFrame.guards.Whole(whole))
          expect.fail('Expected Whole after admission')
        expect(whole.state.messages).toContainEqual(
          expect.objectContaining({ key: 'reply', submissionId: run.submissionId }),
        )
        yield* answer.release
        expect(yield* Queue.take(test.reported)).toBe('Completed')
        expect((yield* test.store.get(run.id)).state._tag).toBe('Completed')
        yield* Fiber.interrupt(watching)
        // A reconnect starts again with a Whole, never an operation from the old link.
        const rejoined = yield* test.watch.pipe(Stream.take(1), Stream.runCollect)
        expect(rejoined.map((frame) => frame._tag)).toEqual(['Whole'])
      }).pipe(Effect.scoped),
    )

    it.effect('StopThread transitions this Person Run once and aborts real Pi work', () =>
      Effect.gen(function* () {
        const test = yield* fixture('Kept')
        const answer = yield* held('Must not finish')
        test.given.faux.setResponses([answer.factory])
        const { run } = yield* test.send('stop')
        yield* answer.entered
        yield* test.stop
        yield* Queue.take(test.stopped)
        expect(yield* Queue.take(test.reported)).toBe('Stopped')
        yield* test.stop
        expect(yield* Queue.size(test.reported)).toBe(0)
        expect(yield* Ref.get(test.titles)).toBe(1)
        expect((yield* test.store.get(run.id)).state._tag).toBe('Stopped')
        expect((yield* readThreadHistory(test.runtime, test.threadId)).working).toBe(false)
      }).pipe(Effect.scoped),
    )

    it.effect('a Person without Thread access is refused before the runtime stream opens', () =>
      Effect.gen(function* () {
        const test = yield* fixture('Kept')
        const result = yield* test
          .asPerson(PersonId.make('outsider'))
          .pipe(Stream.runCollect, Effect.result)
        expect(result._tag).toBe('Failure')
        if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(NotFound)
      }).pipe(Effect.scoped),
    )
  },
)

/** Product SQL uses its live adapter clock; admission alone follows the controlled test clock. */
layer(productLayer.pipe(Layer.provideMerge(testConfigLayer)))((it) => {
  it.effect('slow cell admission remains working after thirty seconds and settles normally', () =>
    Effect.gen(function* () {
      const test = yield* fixture('SlowAdmission')
      const answer = yield* held('Admitted after activation')
      test.given.faux.setResponses([answer.factory])
      const sending = yield* test.send('slow-activation').pipe(Effect.forkScoped)
      yield* Deferred.await(test.admission.entered)
      yield* TestClock.adjust('31 seconds')
      expect(sending.pollUnsafe()).toBeUndefined()
      expect((yield* test.store.list(test.threadId)).map((run) => run.state._tag)).toEqual([
        'Working',
      ])
      yield* Deferred.succeed(test.admission.release, undefined)
      const { run } = yield* Fiber.join(sending)
      yield* answer.entered
      yield* answer.release
      expect(yield* Queue.take(test.reported)).toBe('Completed')
      expect((yield* test.store.get(run.id)).state._tag).toBe('Completed')
    }).pipe(Effect.scoped),
  )
})
