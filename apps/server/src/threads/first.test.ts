import { silentChannelRepliesLayer } from '../channels/replies.ts'
import { ThreadTitles } from './generation.ts'
import * as NodeCrypto from 'node:crypto'
import { describe, expect, layer } from '@effect/vitest'
import {
  Company,
  CompanyId,
  DatabaseUnavailable,
  OpenFirstThreadResult,
  PersonId,
  RunOrigin,
  RunState,
  RuntimeRunRequest,
  SessionId,
  ThreadId,
  Workspace,
} from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { eq } from 'drizzle-orm'
import { Effect, Layer, Option, Predicate, Ref, Result, Schema } from 'effect'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientError from 'effect/http/HttpClientError'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'
import { findPerson, type Actor } from '../auth/access.ts'
import { personTable } from '../auth/tables.ts'
import { companyTable, membershipTable } from '../companies/tables.ts'
import { Database } from '../database/client.ts'
import { testConfigLayer, testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { silentChangesLayer } from '../live/changes.ts'
import { Notifier } from '../notifications/notifier.ts'
import { Runtime, runtimeLayer } from '../runtime/client.ts'
import { Conversation } from './conversation.ts'
import { conversationLayer } from './delivery.ts'
import { threadHandlers } from './handlers.ts'
import { Presence } from './presence.ts'
import { RunStore, runStoreLayer } from './runs.ts'
import { ThreadStore, threadStoreLayer } from './store.ts'
import { firstThreads, threads } from './tables.ts'

const stores = Layer.merge(threadStoreLayer, runStoreLayer).pipe(
  Layer.provideMerge(testDatabaseLayer),
)
const decodeDelivery = Schema.decodeUnknownEffect(Schema.fromJsonString(RuntimeRunRequest))

/** Real persistence owns the fixture; cleanup is registered before either identity is inserted. */
const fixture = Effect.fn('FirstThread.test.fixture')(function* () {
  const database = yield* Database
  const personId = PersonId.make(NodeCrypto.randomUUID())
  const companyId = CompanyId.make(NodeCrypto.randomUUID())
  yield* Effect.addFinalizer(() =>
    database.run(database.delete(personTable).where(eq(personTable.id, personId))).pipe(
      Effect.andThen(
        database.run(database.delete(companyTable).where(eq(companyTable.id, companyId))),
      ),
      Effect.asVoid,
      Effect.catch(() => Effect.sync(() => expect.fail('First Thread fixture cleanup failed'))),
    ),
  )
  yield* database.run(
    database.insert(personTable).values({
      id: personId,
      name: 'Ada',
      email: `${personId}@example.test`,
    }),
  )
  yield* database.run(
    database.insert(companyTable).values({ id: companyId, name: 'Arrival test', slug: companyId }),
  )
  yield* database.run(
    database.insert(membershipTable).values({
      id: NodeCrypto.randomUUID(),
      companyId,
      userId: personId,
      role: 'member',
    }),
  )
  const person = yield* findPerson(personId)
  if (Option.isNone(person)) expect.fail('Fixture Person must exist')
  const actor: Actor = {
    person: person.value,
    workspace: Workspace.cases.Personal.make({}),
    by: 'person',
    threadId: Option.none(),
  }
  const company = Company.make({ id: companyId, name: 'Arrival test', slug: companyId })
  const workspace = Workspace.cases.Company.make({ company, role: 'member' })
  return { actor, workspace, companyId }
})

/**
 * Only remote HTTP is substituted: production Runtime validates and encodes the delivery, and
 * production Conversation reserves and admits its Run. Settlement stays suspended in scope so
 * assertions observe admission without timing, sleeps, real servers, or model credentials.
 * A one-shot reservation refusal models persistence failing before any Run was written.
 */
const harness = Effect.fn('FirstThread.test.harness')(function* () {
  const test = yield* fixture()
  const deliveries = yield* Ref.make<ReadonlyArray<RuntimeRunRequest>>([])
  const reservationFailure = yield* Ref.make(Option.none<DatabaseUnavailable>())
  const refuseAdmission = yield* Ref.make(false)
  const http = HttpClient.make(
    Effect.fn('FirstThread.test.http')(function* (request) {
      if (!Predicate.isTagged(request.body, 'Uint8Array'))
        expect.fail('Expected encoded runtime request')
      // `HttpClient.make` admits only HttpClientError, so a body that is not a RuntimeRunRequest
      // fails as the request-side EncodeError reason with the SchemaError as its cause. Nothing is
      // recorded for it, so every admission assertion below fails instead of passing on bad wire.
      const delivery = yield* decodeDelivery(new TextDecoder().decode(request.body.body)).pipe(
        Effect.mapError(
          (cause) =>
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.EncodeError({
                request,
                cause,
                description: 'Runtime request is not an encoded RuntimeRunRequest',
              }),
            }),
        ),
      )
      yield* Ref.update(deliveries, (all) => [...all, delivery])
      // A missing receipt exercises the production RuntimeUnavailable path after reservation.
      if (yield* Ref.getAndSet(refuseAdmission, false))
        return HttpClientResponse.fromWeb(
          request,
          new Response('{"error":"InvalidRequest"}', { status: 400 }),
        )
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          JSON.stringify({
            submissionId: delivery.turn,
            repeated: false,
          }),
          { headers: { 'content-type': 'application/json' }, status: 202 },
        ),
      )
    }),
  )
  const transportContext = yield* Layer.build(
    runtimeLayer.pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
      Layer.provide(testConfigLayer),
      Layer.provide(Layer.succeed(Database, yield* Database)),
    ),
  )
  const transport = yield* Runtime.pipe(Effect.provideContext(transportContext))
  const runtime = Runtime.of({ ...transport, settled: () => Effect.never })
  const runStore = yield* RunStore
  const controlledRuns = RunStore.of({
    ...runStore,
    start: Effect.fn('FirstThread.test.reserve')(function* (input) {
      const failure = yield* Ref.getAndSet(reservationFailure, Option.none())
      if (Option.isSome(failure)) return yield* failure.value
      return yield* runStore.start(input)
    }),
  })
  const services = Layer.mergeAll(
    Layer.succeed(Database, yield* Database),
    Layer.succeed(ThreadStore, yield* ThreadStore),
    Layer.succeed(RunStore, controlledRuns),
    Layer.succeed(Runtime, runtime),
    silentChangesLayer,
    Layer.mock(ThreadTitles, { afterRun: () => Effect.void }),
    Layer.succeed(Notifier, Notifier.of({ notify: () => Effect.void })),
    Layer.mock(Presence, { watching: () => Effect.succeed(true) }),
  )
  const context = yield* Layer.build(
    conversationLayer.pipe(Layer.provide(silentChannelRepliesLayer), Layer.provide(services)),
  )
  const conversation = yield* Conversation.pipe(Effect.provideContext(context))
  const auth = AuthState.Person({
    person: test.actor.person,
    workspace: test.actor.workspace,
    sessionId: SessionId.make(NodeCrypto.randomUUID()),
  })
  /** The RPC handler runs with the same request-local identity supplied by authentication. */
  const open = (workspace: Workspace) =>
    threadHandlers
      .OpenFirstThread()
      .pipe(
        Effect.provideService(AuthContext, AuthState.Person({ ...auth, workspace })),
        Effect.provideService(Conversation, conversation),
      )
  return { ...test, deliveries, reservationFailure, refuseAdmission, conversation, open }
})

/** Observe all product rows for this Person, including archived Threads and other workspaces. */
const recorded = Effect.fn('FirstThread.test.recorded')(function* (personId: PersonId) {
  const database = yield* Database
  return yield* database.run(database.select().from(threads).where(eq(threads.personId, personId)))
})

layer(stores)((it) => {
  describe.skipIf(!testDatabaseConfigured)('OpenFirstThread RPC', () => {
    it.effect('compensation never removes a different Thread without its matching receipt', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const store = yield* ThreadStore
        const first = yield* store.openFirst(test.actor)
        if (!OpenFirstThreadResult.guards.Opened(first)) expect.fail('Expected first arrival')
        const other = yield* store.create(test.actor, {
          id: ThreadId.make(NodeCrypto.randomUUID()),
          title: 'Earlier work',
          projectId: null,
        })
        yield* store.releaseFirst(test.actor.person.id, other.id)
        expect(yield* recorded(test.actor.person.id)).toHaveLength(2)
        yield* store.releaseFirst(test.actor.person.id, first.thread)
        expect(yield* recorded(test.actor.person.id)).toMatchObject([{ id: other.id }])
        expect(yield* store.openFirst(test.actor)).toEqual(
          OpenFirstThreadResult.cases.NotFirst.make({}),
        )
      }).pipe(Effect.scoped),
    )

    it.effect('the no-Run guard keeps a failed unadmitted reservation after runtime refusal', () =>
      Effect.gen(function* () {
        const test = yield* harness()
        yield* Ref.set(test.refuseAdmission, true)
        const outcome = yield* test.open(test.actor.workspace).pipe(Effect.result)
        expect(Result.isFailure(outcome) ? outcome.failure._tag : 'opened').toBe(
          'RuntimeUnavailable',
        )
        const [thread] = yield* recorded(test.actor.person.id)
        if (thread === undefined) expect.fail('A recorded Run must protect its Thread')
        const [run] = yield* (yield* RunStore).list(thread.id)
        if (run === undefined) expect.fail('Expected the failed reservation')
        expect(RunState.guards.Failed(run.state)).toBe(true)
        expect(yield* test.open(test.actor.workspace)).toEqual(
          OpenFirstThreadResult.cases.Existing.make({ thread: thread.id }),
        )
        expect(yield* Ref.get(test.deliveries)).toHaveLength(1)
      }).pipe(Effect.scoped),
    )

    it.effect(
      'removes a failed empty opening and the next call opens and starts exactly one Run',
      () =>
        Effect.gen(function* () {
          const test = yield* harness()
          const database = yield* Database
          const failure = DatabaseUnavailable.make({ message: 'Reservation unavailable' })
          yield* Ref.set(test.reservationFailure, Option.some(failure))
          const first = yield* test.open(test.actor.workspace).pipe(Effect.result)
          expect(Result.isFailure(first) ? first.failure : 'opened').toEqual(failure)
          expect(yield* recorded(test.actor.person.id)).toHaveLength(0)
          expect(
            yield* database.run(
              database
                .select()
                .from(firstThreads)
                .where(eq(firstThreads.personId, test.actor.person.id)),
            ),
          ).toHaveLength(0)
          expect(yield* Ref.get(test.deliveries)).toHaveLength(0)
          const retried = yield* test.open(test.actor.workspace)
          if (!OpenFirstThreadResult.guards.Opened(retried)) expect.fail('Expected a fresh opening')
          expect(yield* recorded(test.actor.person.id)).toHaveLength(1)
          expect(yield* (yield* RunStore).list(retried.thread)).toHaveLength(1)
          expect(yield* Ref.get(test.deliveries)).toHaveLength(1)
          expect(yield* test.open(test.actor.workspace)).toEqual(
            OpenFirstThreadResult.cases.Existing.make({ thread: retried.thread }),
          )
        }).pipe(Effect.scoped),
    )

    it.effect('compensation preserves a Thread and receipt after a Run has been admitted', () =>
      Effect.gen(function* () {
        const test = yield* harness()
        const first = yield* test.open(test.actor.workspace)
        if (!OpenFirstThreadResult.guards.Opened(first)) expect.fail('Expected first arrival')
        yield* (yield* ThreadStore).releaseFirst(test.actor.person.id, first.thread)
        expect(yield* recorded(test.actor.person.id)).toHaveLength(1)
        expect(yield* (yield* RunStore).list(first.thread)).toHaveLength(1)
        expect(yield* test.open(test.actor.workspace)).toEqual(
          OpenFirstThreadResult.cases.Existing.make({ thread: first.thread }),
        )
        expect(yield* Ref.get(test.deliveries)).toHaveLength(1)
      }).pipe(Effect.scoped),
    )

    it.effect('opens one private Thread and admits one Vivid signal without a Person message', () =>
      Effect.gen(function* () {
        const test = yield* harness()
        const result = yield* test.open(test.actor.workspace)
        if (!OpenFirstThreadResult.guards.Opened(result)) expect.fail('Expected first arrival')
        expect(yield* recorded(test.actor.person.id)).toMatchObject([
          {
            id: result.thread,
            title: 'New thread',
            companyId: null,
            audience: 'private',
            preview: '',
          },
        ])
        const runs = yield* (yield* RunStore).list(result.thread)
        expect(runs).toHaveLength(1)
        const [run] = runs
        if (run === undefined) expect.fail('Expected a first Run')
        expect(run).toMatchObject({ turn: 1, state: RunState.cases.Working.make({}) })
        expect(run.origin).toEqual(
          RunOrigin.cases.FirstConversation.make({
            person: { id: test.actor.person.id, name: 'Ada', image: null },
          }),
        )
        const sent = yield* Ref.get(test.deliveries)
        expect(sent).toHaveLength(1)
        expect(sent[0]).toMatchObject({
          type: 'first-conversation',
          attributes: { from: 'Vivid', turn: '1' },
          attachments: [],
          scope: { acting: test.actor.person.id },
        })
        const [delivery] = sent
        if (delivery === undefined) expect.fail('Expected runtime admission')
        expect(yield* test.open(test.actor.workspace)).toEqual(
          OpenFirstThreadResult.cases.Existing.make({ thread: result.thread }),
        )
        expect(yield* (yield* RunStore).list(result.thread)).toHaveLength(1)
        expect(yield* Ref.get(test.deliveries)).toHaveLength(1)
        expect(
          JSON.stringify({ body: delivery.body, attributes: delivery.attributes }),
        ).not.toContain(test.actor.person.id)
        expect(
          JSON.stringify({ body: delivery.body, attributes: delivery.attributes }),
        ).not.toContain(result.thread)
      }).pipe(Effect.scoped),
    )

    it.effect('two concurrent calls create exactly one Thread and one Run', () =>
      Effect.gen(function* () {
        const test = yield* harness()
        const outcomes = yield* Effect.all(
          [test.open(test.actor.workspace), test.open(test.workspace)],
          { concurrency: 'unbounded' },
        )
        expect(outcomes.filter(OpenFirstThreadResult.guards.Opened)).toHaveLength(1)
        expect(outcomes.filter(OpenFirstThreadResult.guards.Existing)).toHaveLength(1)
        const [stored] = yield* recorded(test.actor.person.id)
        if (stored === undefined) expect.fail('Expected a first Thread')
        expect(
          outcomes.map((outcome) =>
            OpenFirstThreadResult.match(outcome, {
              Opened: ({ thread }) => thread,
              Existing: ({ thread }) => thread,
              NotFirst: () => expect.fail('Concurrent arrival cannot become NotFirst'),
            }),
          ),
        ).toEqual([stored.id, stored.id])
        expect(yield* recorded(test.actor.person.id)).toHaveLength(1)
        expect(yield* (yield* RunStore).list(stored.id)).toHaveLength(1)
        expect(yield* Ref.get(test.deliveries)).toHaveLength(1)
      }).pipe(Effect.scoped),
    )

    it.effect(
      'a prior archived Thread in another workspace returns NotFirst without recording arrival',
      () =>
        Effect.gen(function* () {
          const test = yield* harness()
          const database = yield* Database
          const earlier = ThreadId.make(NodeCrypto.randomUUID())
          yield* (yield* ThreadStore).create(test.actor, {
            id: earlier,
            title: 'Earlier work',
            projectId: null,
          })
          yield* database.run(
            database.update(threads).set({ archived: true }).where(eq(threads.id, earlier)),
          )
          expect(yield* test.open(test.workspace)).toEqual(
            OpenFirstThreadResult.cases.NotFirst.make({}),
          )
          expect(yield* recorded(test.actor.person.id)).toHaveLength(1)
          expect(yield* (yield* RunStore).list(earlier)).toHaveLength(0)
          expect(yield* Ref.get(test.deliveries)).toHaveLength(0)
          expect(
            yield* database.run(
              database
                .select()
                .from(firstThreads)
                .where(eq(firstThreads.personId, test.actor.person.id)),
            ),
          ).toHaveLength(0)
        }).pipe(Effect.scoped),
    )

    it.effect(
      'keeps first arrival Person-level after a workspace switch and store reconstruction',
      () =>
        Effect.gen(function* () {
          const test = yield* harness()
          const first = yield* test.open(test.workspace)
          if (!OpenFirstThreadResult.guards.Opened(first)) expect.fail('Expected first arrival')
          expect(yield* recorded(test.actor.person.id)).toMatchObject([
            { id: first.thread, companyId: test.companyId, audience: 'private' },
          ])
          const context = yield* Layer.build(
            threadStoreLayer.pipe(Layer.provide(Layer.succeed(Database, yield* Database))),
          )
          const rebuilt = yield* ThreadStore.pipe(Effect.provideContext(context))
          expect(
            yield* test
              .open(test.actor.workspace)
              .pipe(Effect.provideService(ThreadStore, rebuilt)),
          ).toEqual(OpenFirstThreadResult.cases.Existing.make({ thread: first.thread }))
          expect(yield* Ref.get(test.deliveries)).toHaveLength(1)
        }).pipe(Effect.scoped),
    )

    it.effect('runtime and acting Vivid callers cannot create a first Thread', () =>
      Effect.gen(function* () {
        const test = yield* harness()
        const identities = [
          AuthState.Runtime(),
          AuthState.Vivid({
            person: test.actor.person,
            workspace: test.actor.workspace,
            threadId: ThreadId.make(NodeCrypto.randomUUID()),
          }),
        ]
        for (const auth of identities) {
          const outcome = yield* threadHandlers
            .OpenFirstThread()
            .pipe(
              Effect.provideService(AuthContext, auth),
              Effect.provideService(Conversation, test.conversation),
              Effect.result,
            )
          expect(Result.isFailure(outcome) ? outcome.failure._tag : 'allowed').toBe('Forbidden')
        }
        expect(yield* recorded(test.actor.person.id)).toHaveLength(0)
        expect(yield* Ref.get(test.deliveries)).toHaveLength(0)
      }).pipe(Effect.scoped),
    )
  })
})
