import { DatabaseUnavailable } from '@vivid/contracts'
import { ChannelReplies } from '../channels/replies.ts'
import { Ref } from 'effect'
import { eq } from 'drizzle-orm'
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
  RunState,
  RuntimeSubmissionId,
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
import { silentLearningLayer } from '../memory/testing.ts'
import { Notifier } from '../notifications/notifier.ts'
import { Conversation, StoredRunOrigin } from '../threads/conversation.ts'
import { conversationLayer } from '../threads/delivery.ts'
import { ThreadTitles } from '../threads/generation.ts'
import { Presence } from '../threads/presence.ts'
import { RunStore, RunEnding, TurnReservation } from '../threads/runs.ts'
import { runs } from '../threads/tables.ts'
import { sendToThread, watchConversation } from '../threads/socket.ts'
import { threadStoreLayer } from '../threads/store.ts'
import { threadHandlers } from '../threads/handlers.ts'
import { AdmissionInput, Runtime, RuntimeMessage, runtimeLayer } from './client.ts'
import { productFixture, productLayer } from './testing.ts'

const decodeBody = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

type Receipt =
  | 'Kept'
  | 'LostOnce'
  | 'UnsavedOnce'
  | 'AbortLostOnce'
  | 'InterruptedOnce'
  | 'LostThrice'
  | 'AbortNotTaken'

/** Adapt only the socket. HTTP requests still cross the production router into real Pi on SQLite. */
const transport = (process: Effect.Success<ReturnType<typeof start>>, receipt: Receipt) => {
  let lost = false
  let lostReceipts = 0
  return HttpClient.make((request) =>
    Effect.gen(function* () {
      const url = new URL(request.url)
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
      if (
        receipt === 'InterruptedOnce' &&
        !lost &&
        request.method === 'POST' &&
        response.status === 202
      ) {
        lost = true
        return yield* Effect.never
      }
      if (
        ((receipt === 'LostThrice' && lostReceipts < 3) || (receipt === 'LostOnce' && !lost)) &&
        request.method === 'POST' &&
        response.status === 202
      ) {
        lost = true
        lostReceipts += 1
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

/** The real server reservation and settlement observer use an independent Person, Thread and session. */
const fixture = Effect.fn('PiServer.test.fixture')(function* (receipt: Receipt) {
  const rows = yield* productFixture()
  const database = yield* Database
  const given = yield* world()
  const process = yield* start(given, { idleMillis: 60_000 })
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
  const ended = yield* Queue.unbounded<void>()
  const store = yield* RunStore
  const stopped = yield* Queue.unbounded<void>()
  const reported = yield* Queue.unbounded<string>()
  const titles = yield* Ref.make(0)
  let unsaved = false
  const observed = RunStore.of({
    ...store,
    admitted: (admission) => {
      if (receipt === 'UnsavedOnce' && !unsaved) {
        unsaved = true
        return Effect.fail(new DatabaseUnavailable({ message: 'Receipt write interrupted' }))
      }
      return store.admitted(admission)
    },
    end: (id, ending) =>
      store
        .end(id, ending)
        .pipe(
          Effect.tap((changed) =>
            changed && RunEnding.guards.Completed(ending)
              ? Queue.offer(ended, undefined)
              : changed && RunEnding.guards.Stopped(ending)
                ? Queue.offer(stopped, undefined)
                : Effect.void,
          ),
        ),
  })
  const config = yield* ServerConfig
  const runtimeContext = yield* Layer.build(
    runtimeLayer.pipe(
      Layer.provide([
        Layer.succeed(ServerConfig, {
          ...config,
          RUNTIME_URL: new URL('http://runtime.test'),
          RUNTIME_TOKEN: Redacted.make('fixture-runtime-token'),
        }),
        Layer.succeed(HttpClient.HttpClient, transport(process, receipt)),
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
    silentLearningLayer,
    Layer.mock(ThreadTitles, { afterRun: () => Ref.update(titles, (count) => count + 1) }),
    Layer.mock(Presence, { watching: () => Effect.succeed(true) }),
    Layer.succeed(Notifier, { notify: () => Effect.void }),
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
  return {
    ...rows,
    given,
    runtime,
    ended,
    stopped,
    reported,
    titles,
    store,
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
        yield* Queue.take(test.ended)
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
          yield* Queue.take(test.ended)
          expect((yield* test.store.get(run.id)).state._tag).toBe('Completed')
          expect(test.given.faux.state.callCount).toBe(1)
        }).pipe(Effect.scoped),
    )

    it.effect('an interrupted sending request retries the same key before it leaves', () =>
      Effect.gen(function* () {
        const test = yield* fixture('InterruptedOnce')
        const answer = yield* held('Held after the caller left')
        test.given.faux.setResponses([answer.factory])
        const sending = yield* test.send('interrupted').pipe(Effect.forkScoped)
        yield* answer.entered
        yield* Fiber.interrupt(sending)
        const [run] = yield* test.store.list(test.threadId)
        if (run === undefined) expect.fail('Missing reserved Run')
        expect(run.state._tag).toBe('Working')
        expect(run.submissionId).toBeDefined()
        yield* answer.release
        yield* Queue.take(test.ended)
        expect((yield* test.store.get(run.id)).state._tag).toBe('Completed')
        expect(test.given.faux.state.callCount).toBe(1)
      }).pipe(Effect.scoped),
    )

    it.effect(
      'exhausted uncertain admission fails Delivery and a client retry finds one delivery',
      () =>
        Effect.gen(function* () {
          const test = yield* fixture('LostThrice')
          const answer = yield* held('A delivery whose receipt was lost')
          test.given.faux.setResponses([answer.factory])
          const result = yield* test.send('exhausted').pipe(Effect.result)
          expect(Result.isFailure(result) && result.failure._tag).toBe('RuntimeUnavailable')
          yield* answer.entered
          const [run] = yield* test.store.list(test.threadId)
          if (run === undefined) expect.fail('Missing failed reservation')
          if (!RunState.guards.Failed(run.state)) expect.fail('Expected a failed delivery')
          expect(run.state.reason).toBe('Delivery')
          expect(run.submissionId).toBeUndefined()
          const retry = yield* test.send('exhausted')
          expect(retry.run.id).toBe(run.id)
          expect(retry.run.turn).toBe(run.turn)
          expect(retry.run.submissionId).toBeDefined()
          expect(retry.run.state._tag).toBe('Working')
          yield* answer.release
          yield* Queue.take(test.ended)
          expect((yield* test.store.get(run.id)).state._tag).toBe('Completed')
          expect(yield* test.store.list(test.threadId)).toHaveLength(1)
          expect(test.given.faux.state.callCount).toBe(1)
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
        yield* Queue.take(test.ended)
        expect((yield* test.store.get(run.id)).state._tag).toBe('Completed')
        expect(test.given.faux.state.callCount).toBe(1)
      }).pipe(Effect.scoped),
    )

    it.effect(
      'receipt-save failure stays failed across restart without running settlement effects',
      () =>
        Effect.gen(function* () {
          const test = yield* fixture('UnsavedOnce')
          const answer = yield* held('Held before the server saved its receipt')
          test.given.faux.setResponses([answer.factory])
          const lost = yield* test.send('unsaved').pipe(Effect.result)
          expect(Result.isFailure(lost) && lost.failure._tag).toBe('DatabaseUnavailable')
          yield* answer.entered
          const [run] = yield* test.store.list(test.threadId)
          if (run === undefined) expect.fail('Missing reserved Run')
          expect(run.submissionId).toBeUndefined()
          if (!RunState.guards.Failed(run.state)) expect.fail('Expected failed receipt persistence')
          expect(run.state.reason).toBe('Delivery')
          yield* test.restart
          expect((yield* test.store.get(run.id)).state).toEqual(run.state)
          expect(yield* Ref.get(test.titles)).toBe(0)
          expect(yield* Queue.size(test.reported)).toBe(0)
          yield* test.restart
          expect((yield* test.store.get(run.id)).state).toEqual(run.state)
          const state = yield* test.runtime.conversation(test.personId, test.threadId)
          const message = state.messages.find((entry) => entry.submissionId !== undefined)
          if (message === undefined || message.submissionId === undefined)
            expect.fail('Pi did not expose the admitted delivery')
          const submissionId = RuntimeSubmissionId.make(Number(message.submissionId))
          yield* answer.release
          // Pi still answers the held delivery through the state link, with no Run attached.
          expect(
            (yield* test.runtime.settled(test.personId, test.threadId, submissionId))._tag,
          ).toBe('Completed')
          expect((yield* test.store.get(run.id)).state).toEqual(run.state)
          expect((yield* test.store.get(run.id)).submissionId).toBeUndefined()
          expect(yield* Ref.get(test.titles)).toBe(0)
          expect(yield* Queue.size(test.reported)).toBe(0)
          expect(test.given.faux.state.callCount).toBe(1)
        }).pipe(Effect.scoped),
    )

    it.effect('restart reconciles the crash boundary before an admitted receipt was saved', () =>
      Effect.gen(function* () {
        const test = yield* fixture('Kept')
        const answer = yield* held('Answering a delivery orphaned by a crash')
        test.given.faux.setResponses([answer.factory])
        const person = yield* findPerson(test.personId)
        if (Option.isNone(person)) expect.fail('Fixture Person missing')
        const id = RunId.make(NodeCrypto.randomUUID())
        const input = {
          id,
          threadId: test.threadId,
          personId: test.personId,
          libraryFolder: null,
          origin: StoredRunOrigin.cases.Message.make({}),
        }
        const reservation = yield* test.store.start(input)
        if (!TurnReservation.guards.Reserved(reservation)) expect.fail('Expected a fresh turn')
        // Seed the real durable cut between runtime acceptance and receipt persistence. Unlike
        // a returned error, a process crash cannot run submitReserved's cleanup finalizer.
        const admission = yield* test.runtime.admit(
          AdmissionInput.make({
            threadId: test.threadId,
            message: RuntimeMessage.pipe(Schema.toTaggedUnion('kind')).cases.user.make({
              body: 'Help me',
              attachments: [],
            }),
            origin: { creator: test.personId, creatorName: person.value.name },
            idempotencyKey: id,
            turn: reservation.turn,
            scope: yield* test.store.scope({ threadId: test.threadId, turn: reservation.turn }),
          }),
        )
        yield* answer.entered
        expect((yield* test.store.get(id)).state._tag).toBe('Working')
        yield* test.restart
        const ended = yield* test.store.get(id)
        expect(ended.state._tag).toBe('Unknown')
        expect(ended.submissionId).toBeUndefined()
        yield* test.restart
        expect((yield* test.store.get(id)).state).toEqual(ended.state)
        expect((yield* test.store.start(input))._tag).toBe('Unfollowed')
        yield* answer.release
        expect(
          (yield* test.runtime.settled(test.personId, test.threadId, admission.submissionId))._tag,
        ).toBe('Completed')
        expect((yield* test.store.get(id)).state).toEqual(ended.state)
        expect(yield* Ref.get(test.titles)).toBe(0)
        expect(yield* Queue.size(test.reported)).toBe(0)
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
        yield* Queue.take(test.ended)
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
        yield* answer.release
        yield* Queue.take(test.ended)
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
        expect((yield* test.runtime.conversation(test.personId, test.threadId)).working).toBe(false)
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
