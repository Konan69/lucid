import * as NodeCrypto from 'node:crypto'
import { describe, expect, layer } from '@effect/vitest'
import { and, eq, inArray } from 'drizzle-orm'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Ref from 'effect/Ref'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'
import * as HttpRouter from 'effect/unstable/http/HttpRouter'
import {
  AuditEvent,
  Conflict,
  InvalidRequest,
  Company,
  CompanyId,
  ConnectionId,
  FindEventsResponse,
  DatabaseFailure,
  OccurrenceId,
  Person,
  PersonId,
  RoutineId,
  RoutineTrigger,
  RuntimeUnavailable,
  NotFound,
  RunId,
  SessionId,
  ThreadId,
  Workspace,
} from '@vivid/contracts'
import { companyColumnOf, type Actor } from '../auth/access.ts'
import { personTable } from '../auth/tables.ts'
import { companyTable, membershipTable } from '../companies/tables.ts'
import { Database, returned } from '../database/client.ts'
import { testConfigLayer, testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { Changes, Topic } from '../live/changes.ts'
import { auditEntries } from '../audit/tables.ts'
import {
  Conversation,
  DeliveryMessage,
  StoredRunOrigin,
  type Delivery,
} from '../threads/conversation.ts'
import { submissionId } from '../runtime/identity.ts'
import { RunStore, runStoreLayer, TurnReservation } from '../threads/runs.ts'
import { ThreadStore, threadStoreLayer } from '../threads/store.ts'
import { runs, threads } from '../threads/tables.ts'
import { notifications } from '../notifications/tables.ts'
import { notifierLayer } from '../notifications/notifier.ts'
import { unavailablePushLayer } from '../push/delivery.ts'
import { SettingsStore, settingsStoreLayer } from '../settings/store.ts'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { RoutineInvocation, RoutineThreadUnavailable } from './attempts.ts'
import { routineHandlers } from './handlers.ts'
import { standingRoutine } from '@vivid/skills'
import { occurrences, routines } from './tables.ts'
import {
  RoutineStore,
  RoutineMissing,
  RoutineWebhookRequired,
  routineStoreServiceLayer,
  scheduledReplayMillis,
} from './store.ts'
import { IntegrationNotice, IntegrationStopReason } from './integration.ts'
import { RoutineScheduler, routineSchedulerServiceLayer } from './scheduler.ts'
import { routineWebhookRoutes } from './webhook.ts'
import { InvalidRoutineSchedule, RoutineTimePassed } from './timing.ts'
import { hashKey } from './keys.ts'
import {
  IntegrationWatch,
  IntegrationRevoked,
  IntegrationReadFailed,
  IntegrationCursorLost,
  ProviderEvent,
  ProviderEventId,
  Watch,
  WatchBatch,
  WatchCursor,
} from './watch.ts'

/** The delivery authority records calls while storing real Runs, so history joins remain real. */
class Deliveries extends Context.Service<Deliveries, Ref.Ref<ReadonlyArray<Delivery>>>()(
  'test/RoutineDeliveries',
) {}

/**
 * Routines deliver only Signals. A FirstConversation or Said delivery carries no Routine text, so
 * reaching one here is a wrong delivery and fails the test rather than reading an absent body.
 */
const signalBody = (delivery: Delivery) => {
  if (!DeliveryMessage.guards.Signal(delivery.message))
    expect.fail(`Expected a Signal delivery, received ${delivery.message._tag}`)
  return delivery.message.body
}

/** Tests may fail the next admission before a Run exists, then retry through the same HTTP route. */
class DeliveryFailure extends Context.Service<
  DeliveryFailure,
  Ref.Ref<Option.Option<RuntimeUnavailable | NotFound>>
>()('test/RoutineDeliveryFailure') {}

/** The recording authority creates durable Runs and exposes delivery counts to behavior tests. */
const recordedConversationLayer = Layer.effectContext(
  Effect.gen(function* () {
    const store = yield* RunStore
    const recorded = new Set<RunId>()
    const delivered = yield* Ref.make<ReadonlyArray<Delivery>>([])
    const failure = yield* Ref.make<Option.Option<RuntimeUnavailable | NotFound>>(Option.none())
    const conversation = Conversation.of({
      /** Routine tests never use the gateway's receipt path; a call there must fail visibly. */
      admit: Effect.fn('Test.RoutineConversation.admit')(function* () {
        return yield* Effect.fail(
          new RuntimeUnavailable({ message: 'Gateway admission is outside Routine tests' }),
        )
      }),
      /** A Run exists durably before delivery returns, just as the production authority promises. */
      deliver: Effect.fn('Test.RoutineConversation.deliver')(function* (delivery) {
        const failed = yield* Ref.getAndSet(failure, Option.none())
        if (Option.isSome(failed)) return yield* Effect.fail(failed.value)
        // Persist through the production allocator: parallel deliveries and replays keep real turns.
        const id = submissionId(delivery.threadId, delivery.idempotencyKey)
        const reservation = yield* store.start({
          id,
          threadId: delivery.threadId,
          personId: delivery.personId,
          origin: delivery.origin,
          libraryFolder: delivery.libraryFolder === undefined ? null : delivery.libraryFolder,
        })
        if (TurnReservation.guards.Busy(reservation))
          return yield* Effect.fail(new Conflict({ message: 'Test Thread is busy' }))
        if (TurnReservation.guards.Reserved(reservation))
          yield* store.admitted({
            runId: id,
            offset: String(reservation.turn),
            incarnation: 'test',
          })
        const stored = yield* returned(
          (yield* store.list(delivery.threadId)).filter((run) => run.id === id),
          'Test Run',
        )
        // The recording port observes each accepted key once, independently of concurrent retries.
        if (!recorded.has(id)) {
          recorded.add(id)
          yield* Ref.update(delivered, (previous) => [...previous, delivery])
        }
        return stored
      }),
    })
    return Context.make(Conversation, conversation).pipe(
      Context.add(Deliveries, delivered),
      Context.add(DeliveryFailure, failure),
    )
  }),
)

/** The change bus is an observable port; persisted Routine/audit data still uses PostgreSQL. */
class Published extends Context.Service<Published, Ref.Ref<ReadonlyArray<Topic>>>()(
  'test/RoutineChanges',
) {}
const recordedChangesLayer = Layer.effectContext(
  Effect.gen(function* () {
    const published = yield* Ref.make<ReadonlyArray<Topic>>([])
    return Context.make(Published, published).pipe(
      Context.add(
        Changes,
        Changes.of({
          publish: (topics) => Ref.update(published, (previous) => previous.concat(topics)),
          subscribe: () => Effect.succeed(Stream.never),
        }),
      ),
    )
  }),
)

/** Controlled provider deliveries exercise the same seam as polling and future native delivery. */
class WatchEvents extends Context.Service<WatchEvents, Ref.Ref<readonly ProviderEvent[]>>()(
  'test/WatchEvents',
) {}
class WatchRevoked extends Context.Service<WatchRevoked, Ref.Ref<boolean>>()('test/WatchRevoked') {}
class WatchReads extends Context.Service<WatchReads, Ref.Ref<number>>()('test/WatchReads') {}
/** The provider may lose its observation window without losing authorization. */
class WatchGap extends Context.Service<WatchGap, Ref.Ref<boolean>>()('test/WatchGap') {}
class WatchTransient extends Context.Service<WatchTransient, Ref.Ref<boolean>>()(
  'test/WatchTransient',
) {}
const fakeWatchLayer = Layer.effectContext(
  Effect.gen(function* () {
    const events = yield* Ref.make<readonly ProviderEvent[]>([])
    const revoked = yield* Ref.make(false)
    const reads = yield* Ref.make(0)
    const gap = yield* Ref.make(false)
    const transient = yield* Ref.make(false)
    const connectionId = ConnectionId.make('PRIVATE-CONNECTION-MARKER')
    const watcher = IntegrationWatch.of({
      discover: Effect.fn('Test.IntegrationWatch.discover')(() =>
        Effect.succeed(
          FindEventsResponse.make({
            events: [{ event: 'mail.received', description: 'A new email arrives', filter: {} }],
          }),
        ),
      ),
      prepare: Effect.fn('Test.IntegrationWatch.prepare')((_actor, trigger) =>
        Effect.succeed(
          Watch.make({
            connectionId,
            trigger,
            cursor: WatchCursor.cases.Empty.make({}),
            intervalMillis: 300_000,
          }),
        ),
      ),
      newItems: Effect.fn('Test.IntegrationWatch.newItems')(function* () {
        yield* Ref.update(reads, (count) => count + 1)
        if (yield* Ref.get(revoked))
          return yield* Effect.fail(new IntegrationRevoked({ connectionId }))
        if (yield* Ref.get(transient))
          return yield* Effect.fail(new IntegrationReadFailed({ connectionId }))
        if (yield* Ref.getAndSet(gap, false))
          return yield* Effect.fail(
            new IntegrationCursorLost({
              connectionId,
              cursor: WatchCursor.cases.Item.make({ id: ProviderEventId.make('baseline-now') }),
              reason: 'Window',
            }),
          )
        const items = yield* Ref.get(events)
        const last = items[items.length - 1]
        return WatchBatch.make({
          items,
          cursor:
            last === undefined
              ? WatchCursor.cases.Empty.make({})
              : WatchCursor.cases.Item.make({ id: last.id }),
        })
      }),
    })
    return Context.make(IntegrationWatch, watcher).pipe(
      Context.add(WatchEvents, events),
      Context.add(WatchRevoked, revoked),
      Context.add(WatchReads, reads),
      Context.add(WatchGap, gap),
      Context.add(WatchTransient, transient),
    )
  }),
)

const storesLayer = Layer.mergeAll(
  routineStoreServiceLayer,
  threadStoreLayer,
  runStoreLayer,
  settingsStoreLayer,
).pipe(
  Layer.provideMerge(fakeWatchLayer),
  Layer.provideMerge(testDatabaseLayer),
  Layer.provideMerge(recordedChangesLayer),
  Layer.provide(testConfigLayer),
)
const authoritiesLayer = Layer.mergeAll(recordedConversationLayer, notifierLayer).pipe(
  Layer.provide(unavailablePushLayer),
  Layer.provideMerge(storesLayer),
)
const testLayer = routineSchedulerServiceLayer.pipe(Layer.provideMerge(authoritiesLayer))

/** Each test owns fresh People and a Company; cascade cleanup is registered before any write. */
const fixture = Effect.fn('Test.Routines.fixture')(function* () {
  const database = yield* Database
  const company = new Company({
    id: CompanyId.make(NodeCrypto.randomUUID()),
    name: 'Routine tests',
    slug: NodeCrypto.randomUUID(),
  })
  const people = [0, 1, 2].map(
    (index) =>
      new Person({
        id: PersonId.make(NodeCrypto.randomUUID()),
        name: `Person ${index}`,
        email: `${NodeCrypto.randomUUID()}@routines.test`,
        image: null,
      }),
  )
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* database.run(database.delete(companyTable).where(eq(companyTable.id, company.id)))
      yield* database.run(
        database.delete(personTable).where(
          inArray(
            personTable.id,
            people.map((person) => person.id),
          ),
        ),
      )
    }).pipe(
      Effect.tapError((error) => Effect.logError('Routine fixture cleanup failed', error)),
      Effect.ignore,
    ),
  )
  yield* database.run(
    database.insert(personTable).values(
      people.map((person) => ({
        id: person.id,
        name: person.name,
        email: person.email,
        image: null,
      })),
    ),
  )
  yield* database.run(
    database
      .insert(companyTable)
      .values({ id: company.id, name: company.name, slug: company.slug }),
  )
  yield* database.run(
    database.insert(membershipTable).values(
      people.map((person) => ({
        id: NodeCrypto.randomUUID(),
        companyId: company.id,
        userId: person.id,
        role: 'admin',
      })),
    ),
  )
  const actors: ReadonlyArray<Actor> = people.map((person) => ({
    person,
    workspace: Workspace.cases.Company.make({ company, role: 'admin' }),
    by: 'person',
    threadId: Option.none(),
  }))
  const owner = actors[0]
  const colleague = actors[1]
  const other = actors[2]
  if (owner === undefined || colleague === undefined || other === undefined)
    return yield* Effect.fail(new DatabaseFailure({ message: 'Test People are missing' }))
  yield* Ref.set(yield* Published, [])
  yield* Ref.set(yield* Deliveries, [])
  yield* Ref.set(yield* DeliveryFailure, Option.none())
  return {
    owner,
    colleague,
    outside: {
      person: other.person,
      workspace: Workspace.cases.Personal.make({}),
      by: 'person',
      threadId: Option.none(),
    } satisfies Actor,
  }
})

/** Routes and services share the test's authority; requests exercise the real HTTP body reader. */
const client = Effect.fn('Test.Routines.client')(function* () {
  const context = yield* Effect.context<RoutineScheduler | RoutineStore>()
  return yield* Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        routineWebhookRoutes.pipe(Layer.provideMerge(Layer.succeedContext(context))),
        { disableLogger: true },
      ),
    ),
    (web) => Effect.promise(() => web.dispose()),
  )
})

/** The only Promise seam is the framework's in-process Web handler, with a real Request body. */
interface WebhookInput {
  readonly web: Effect.Success<ReturnType<typeof client>>
  readonly id: RoutineId
  readonly key: Redacted.Redacted
  readonly body: string
}

/** In-process requests exercise the exported route without introducing a network server. */
const sendWebhook = Effect.fn('Test.Routines.sendWebhook')(function* (
  input: WebhookInput,
  headers: Readonly<Record<string, string>>,
) {
  return yield* Effect.tryPromise({
    try: () =>
      input.web.handler(
        new Request(`http://routines.test/api/hooks/routines/${input.id}`, {
          method: 'POST',
          headers,
          body: input.body,
        }),
      ),
    catch: (cause) => new Error('Webhook HTTP adapter failed', { cause }),
  })
})

/** Unkeyed callers deliberately retain the existing fresh-occurrence behavior. */
const post = (input: WebhookInput) =>
  sendWebhook(input, { authorization: `Bearer ${Redacted.value(input.key)}` })

/** A retry supplies the same HTTP key even if its payload changes. */
const postKeyed = (input: WebhookInput, key: string) =>
  sendWebhook(input, {
    authorization: `Bearer ${Redacted.value(input.key)}`,
    'idempotency-key': key,
  })

const decodeReceipt = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ occurrenceId: OccurrenceId })),
)

/** Response bytes are decoded at the consumer boundary, rather than asserting response.json types. */
const receipt = Effect.fn('Test.Routines.receipt')(function* (response: Response) {
  const text = yield* Effect.tryPromise({
    try: () => response.text(),
    catch: (cause) => new Error('Webhook response could not be read', { cause }),
  })
  return yield* decodeReceipt(text)
})

/** Installs a real conflicting private Thread to exercise ThreadStore.ensure's ownership guard. */
const obstruct = Effect.fn('Test.Routines.obstruct')(function* (id: RoutineId, actor: Actor) {
  yield* (yield* ThreadStore).ensure({
    id: ThreadId.make(`routine-${id}`),
    title: 'Another Person’s Thread',
    titleSource: 'Person',
    personId: actor.person.id,
    companyId: companyColumnOf(actor.workspace),
  })
})

const schedule = RoutineTrigger.cases.Schedule.make({ cron: '* * * * *', timezone: 'UTC' })
const webhook = RoutineTrigger.cases.Webhook.make({})

/** Event content keeps provider ids/content intact, distinct from Vivid's private binding. */
const decodeProviderPayload = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

const email = (index: number) =>
  ProviderEvent.make({
    id: ProviderEventId.make(`mail-${index}`),
    content: {
      id: `mail-${index}`,
      from: 'dami@example.test',
      subject: `Update ${index}`,
      body: `Email content ${index}`,
    },
  })

/** A fresh owner and provider controls prevent a prior test's pause/cursor from influencing this test. */
const integrationFixture = Effect.fn('Test.Routines.integrationFixture')(function* () {
  const { owner } = yield* fixture()
  yield* Ref.set(yield* WatchEvents, [])
  yield* Ref.set(yield* WatchRevoked, false)
  yield* Ref.set(yield* WatchReads, 0)
  yield* Ref.set(yield* WatchGap, false)
  yield* Ref.set(yield* WatchTransient, false)
  const store = yield* RoutineStore
  const routine = yield* store.create(owner, {
    name: 'New mail',
    prompt: 'Summarize this email.',
    trigger: RoutineTrigger.cases.Integration.make({
      account: 'Gmail (Work)',
      event: 'mail.received',
      filter: {},
    }),
  })
  return { owner, routine, store, scheduler: yield* RoutineScheduler }
})

/** Integration tests are gated only by the isolated test database setting. */
describe.skipIf(!testDatabaseConfigured)('personal Routines', () => {
  layer(testLayer)((it) => {
    it.effect(
      'offers a dormant personal standing template, requires a Person to enable it, and uses the existing scheduler',
      () =>
        Effect.gen(function* () {
          const { owner, colleague } = yield* fixture()
          const personal: Actor = { ...owner, workspace: Workspace.cases.Personal.make({}) }
          const auth = AuthState.Person({
            person: owner.person,
            workspace: owner.workspace,
            sessionId: SessionId.make(NodeCrypto.randomUUID()),
          })
          yield* (yield* SettingsStore).patch(owner.person.id, { timezone: 'Africa/Lagos' })
          const offered = yield* routineHandlers
            .ListRoutines()
            .pipe(Effect.provideService(AuthContext, auth))
          expect(offered.routines).toEqual([])
          const template = yield* returned(offered.templates, 'standing template')
          expect(template).toMatchObject({
            name: standingRoutine.name,
            trigger: RoutineTrigger.cases.Schedule.make({
              cron: standingRoutine.cron,
              timezone: 'Africa/Lagos',
            }),
          })
          const vivid = AuthState.Vivid({
            person: owner.person,
            workspace: owner.workspace,
            threadId: ThreadId.make(NodeCrypto.randomUUID()),
          })
          const denied = yield* routineHandlers
            .CreateRoutine(template)
            .pipe(Effect.provideService(AuthContext, vivid), Effect.flip)
          expect(denied._tag).toBe('Forbidden')
          const store = yield* RoutineStore
          expect(yield* store.list(personal)).toEqual([])
          const { routine } = yield* routineHandlers
            .CreateRoutine(template)
            .pipe(Effect.provideService(AuthContext, auth))
          expect(routine.enabled).toBe(true)
          expect((yield* store.get(personal, routine.id)).companyId).toBe(null)
          yield* (yield* RoutineScheduler).run(personal, routine.id)
          const [delivery] = yield* Ref.get(yield* Deliveries)
          if (delivery === undefined) expect.fail('Expected the standing Run delivery')
          expect(delivery.origin).toEqual(
            StoredRunOrigin.cases.Standing.make({ routineName: standingRoutine.name }),
          )
          expect((yield* store.list(owner)).map((item) => item.id)).toContain(routine.id)
          expect(yield* store.list(colleague)).toEqual([])
          const refused = yield* routineHandlers
            .PatchRoutine({ id: routine.id, patch: { enabled: true } })
            .pipe(Effect.provideService(AuthContext, vivid), Effect.flip)
          expect(refused._tag).toBe('Forbidden')
          yield* routineHandlers
            .PatchRoutine({ id: routine.id, patch: { enabled: false } })
            .pipe(Effect.provideService(AuthContext, auth))
          expect((yield* store.get(personal, routine.id)).routine.enabled).toBe(false)
        }),
    )
    it.effect('fires a one-off once and keeps its Thread and receipt across a restart', () =>
      Effect.gen(function* () {
        const { owner } = yield* fixture()
        const store = yield* RoutineStore
        const scheduler = yield* RoutineScheduler
        const now = yield* Clock.currentTimeMillis
        const routine = yield* store.create(owner, {
          name: 'Reminder',
          prompt: 'Remind me to check the report.',
          trigger: RoutineTrigger.cases.Once.make({ at: now + 60_000, timezone: 'Africa/Lagos' }),
        })
        expect(routine.nextExpectedAt).toBe(now + 60_000)
        yield* scheduler.runDue()
        expect((yield* store.get(owner, routine.id)).routine.runs).toHaveLength(0)
        yield* TestClock.adjust('1 minute')
        yield* scheduler.runDue()
        const fired = yield* store.list(owner)
        const result = yield* returned(
          fired.filter((item) => item.id === routine.id),
          'One-off',
        )
        expect(result).toMatchObject({ enabled: false, nextExpectedAt: null, nextRunAt: null })
        expect(result.runs).toHaveLength(1)
        const occurrence = yield* returned(result.runs, 'Occurrence')
        expect((yield* (yield* ThreadStore).list(owner)).map((thread) => thread.id)).toContain(
          occurrence.threadId,
        )
        yield* scheduler.runDue().pipe(Effect.provide(Layer.fresh(routineSchedulerServiceLayer)))
        yield* TestClock.adjust('1 day')
        yield* scheduler.runDue()
        expect(
          (yield* returned(
            (yield* store.list(owner)).filter((item) => item.id === routine.id),
            'One-off',
          )).runs,
        ).toHaveLength(1)
        expect(
          (yield* Ref.get(yield* Deliveries)).filter(
            (delivery) => delivery.threadId === `routine-${routine.id}`,
          ),
        ).toHaveLength(1)
        expect(
          yield* Effect.flip(store.patch(owner, routine.id, { enabled: true })),
        ).toBeInstanceOf(RoutineTimePassed)
      }),
    )

    it.effect('resolves a one-off RPC in server-owned Person Settings and maps expired times', () =>
      Effect.gen(function* () {
        const { owner } = yield* fixture()
        yield* TestClock.setTime(Date.UTC(2026, 9, 3, 12))
        yield* (yield* SettingsStore).patch(owner.person.id, { timezone: 'Africa/Lagos' })
        const auth = AuthState.Person({
          person: owner.person,
          workspace: owner.workspace,
          sessionId: SessionId.make(NodeCrypto.randomUUID()),
        })
        const create = (localAt: string) =>
          routineHandlers
            .CreateOnceRoutine({ name: 'Check report', prompt: 'Remind me.', localAt })
            .pipe(Effect.provideService(AuthContext, auth))
        const { routine } = yield* create('2026-10-04T09:00')
        expect(routine.trigger).toEqual(
          RoutineTrigger.cases.Once.make({ at: Date.UTC(2026, 9, 4, 8), timezone: 'Africa/Lagos' }),
        )
        expect(routine.nextExpectedAt).toBe(Date.UTC(2026, 9, 4, 8))
        const error = yield* Effect.flip(create('2026-10-03T09:00'))
        expect(error).toBeInstanceOf(InvalidRequest)
        expect(error).toMatchObject({ message: 'A one-off Routine must be in the future.' })
      }),
    )

    it.effect(
      'an explicit pause withdraws a consumed one-off before its pending delivery replays',
      () =>
        Effect.gen(function* () {
          const { owner } = yield* fixture()
          const store = yield* RoutineStore
          const now = yield* Clock.currentTimeMillis
          const routine = yield* store.create(owner, {
            name: 'Withdraw reminder',
            prompt: 'Check once.',
            trigger: RoutineTrigger.cases.Once.make({ at: now + 1000, timezone: 'UTC' }),
          })
          yield* TestClock.adjust('1 second')
          yield* store.claimDue()
          yield* store.patch(owner, routine.id, { enabled: false })
          yield* (yield* RoutineScheduler).runDue()
          const result = yield* returned(
            (yield* store.list(owner)).filter((item) => item.id === routine.id),
            'One-off',
          )
          expect(result.runs).toMatchObject([
            { status: 'failed', error: 'Its Routine was disabled before delivery' },
          ])
          expect(
            (yield* Ref.get(yield* Deliveries)).filter(
              (delivery) => delivery.threadId === `routine-${routine.id}`,
            ),
          ).toEqual([])
        }),
    )

    it.effect('refuses expired one-offs before inserting any Routine', () =>
      Effect.gen(function* () {
        const { owner } = yield* fixture()
        const store = yield* RoutineStore
        const now = yield* Clock.currentTimeMillis
        for (const at of [now - 1, now]) {
          expect(
            yield* Effect.flip(
              store.create(owner, {
                name: 'Expired reminder',
                prompt: 'Do it once.',
                trigger: RoutineTrigger.cases.Once.make({ at, timezone: 'UTC' }),
              }),
            ),
          ).toBeInstanceOf(RoutineTimePassed)
        }
        expect(yield* store.list(owner)).toEqual([])
      }),
    )

    it.effect('recovers a claimed one-off after restart without scheduling a second receipt', () =>
      Effect.gen(function* () {
        const { owner } = yield* fixture()
        const store = yield* RoutineStore
        const now = yield* Clock.currentTimeMillis
        const routine = yield* store.create(owner, {
          name: 'Recover reminder',
          prompt: 'Check once.',
          trigger: RoutineTrigger.cases.Once.make({ at: now + 1000, timezone: 'UTC' }),
        })
        yield* TestClock.adjust('1 second')
        const claimed = yield* store.claimDue()
        expect(claimed.filter(({ record }) => record.routine.id === routine.id)).toHaveLength(1)
        yield* (yield* RoutineScheduler)
          .runDue()
          .pipe(Effect.provide(Layer.fresh(routineSchedulerServiceLayer)))
        yield* (yield* RoutineScheduler).runDue()
        const result = yield* returned(
          (yield* store.list(owner)).filter((item) => item.id === routine.id),
          'One-off',
        )
        expect(result).toMatchObject({ enabled: false, nextExpectedAt: null })
        expect(result.runs).toHaveLength(1)
        expect(result.runs[0]).toMatchObject({ status: 'running' })
        expect(
          (yield* Ref.get(yield* Deliveries)).filter(
            (delivery) => delivery.threadId === `routine-${routine.id}`,
          ),
        ).toHaveLength(1)
      }),
    )

    it.effect('conceals and refuses another Person’s Routine, including Company admins', () =>
      Effect.gen(function* () {
        const { owner, colleague, outside } = yield* fixture()
        const store = yield* RoutineStore
        const scheduler = yield* RoutineScheduler
        const routine = yield* store.create(owner, {
          name: 'Private work',
          prompt: 'Summarize updates',
          trigger: schedule,
        })
        for (const other of [colleague, outside]) {
          expect(yield* store.list(other)).toEqual([])
          expect(yield* store.get(other, routine.id).pipe(Effect.flip)).toBeInstanceOf(
            RoutineMissing,
          )
          expect(yield* scheduler.run(other, routine.id).pipe(Effect.flip)).toBeInstanceOf(
            RoutineMissing,
          )
          expect(
            yield* store.patch(other, routine.id, { name: 'Changed' }).pipe(Effect.flip),
          ).toBeInstanceOf(RoutineMissing)
          expect(yield* store.remove(other, routine.id).pipe(Effect.flip)).toBeInstanceOf(
            RoutineMissing,
          )
          expect(yield* store.issueWebhook(other, routine.id).pipe(Effect.flip)).toBeInstanceOf(
            RoutineMissing,
          )
        }
        expect(yield* Ref.get(yield* Deliveries)).toEqual([])
        expect((yield* store.list(owner)).map((item) => item.id)).toEqual([routine.id])
        const vivid = { ...owner, by: 'vivid' } satisfies Actor
        const run = yield* scheduler.run(vivid, routine.id)
        expect(run.submissionId).not.toBeNull()
        expect((yield* Ref.get(yield* Deliveries)).map((delivery) => delivery.personId)).toEqual([
          owner.person.id,
        ])
      }),
    )

    it.effect(
      'accepts exactly one webhook delivery; wrong, missing and disabled are identical',
      () =>
        Effect.gen(function* () {
          const { owner } = yield* fixture()
          const store = yield* RoutineStore
          const routine = yield* store.create(owner, {
            name: 'Webhook work',
            prompt: 'Handle incoming update',
            trigger: webhook,
          })
          const issued = yield* store.issueWebhook(owner, routine.id)
          const web = yield* client()
          const accepted = yield* post({ web, id: routine.id, key: issued.key, body: 'New update' })
          expect(accepted.status).toBe(202)
          const acceptedReceipt = yield* receipt(accepted)
          const delivered = yield* Ref.get(yield* Deliveries)
          expect(delivered).toHaveLength(1)
          expect(delivered[0]).toMatchObject({
            personId: owner.person.id,
            idempotencyKey: acceptedReceipt.occurrenceId,
            message: {
              body: 'Handle incoming update\n\nPayload:\nNew update',
              attributes: { name: routine.name },
            },
          })
          const wrong = yield* post({
            web,
            id: routine.id,
            key: Redacted.make('x'.repeat(43)),
            body: 'Update',
          })
          const missing = yield* post({
            web,
            id: RoutineId.make(NodeCrypto.randomUUID()),
            key: issued.key,
            body: 'Update',
          })
          yield* store.patch(owner, routine.id, { enabled: false })
          const disabled = yield* post({ web, id: routine.id, key: issued.key, body: 'Update' })
          expect([wrong.status, missing.status, disabled.status]).toEqual([404, 404, 404])
          const bodies = yield* Effect.forEach([wrong, missing, disabled], (response) =>
            Effect.promise(() => response.text()),
          )
          expect(new Set(bodies).size).toBe(1)
          expect(yield* Ref.get(yield* Deliveries)).toHaveLength(1)
          expect((yield* store.list(owner))[0]).toMatchObject({
            runs: [{ id: acceptedReceipt.occurrenceId, status: 'running' }],
          })
        }),
    )

    it.effect('rotates webhook authority and clears it when switching triggers', () =>
      Effect.gen(function* () {
        const { owner } = yield* fixture()
        const store = yield* RoutineStore
        const routine = yield* store.create(owner, {
          name: 'Rotating work',
          prompt: 'Check update',
          trigger: webhook,
        })
        const first = yield* store.issueWebhook(owner, routine.id)
        const second = yield* store.issueWebhook(owner, routine.id)
        expect(first.address).toBe(second.address)
        expect(hashKey(first.key)).not.toBe(hashKey(second.key))
        const database = yield* Database
        const stored = yield* database.run(
          database.select().from(routines).where(eq(routines.id, routine.id)),
        )
        expect(stored[0]).toMatchObject({
          webhookKeyHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        })
        expect(JSON.stringify(stored).includes(Redacted.value(second.key))).toBe(false)
        const web = yield* client()
        expect((yield* post({ web, id: routine.id, key: first.key, body: 'Update' })).status).toBe(
          404,
        )
        expect((yield* post({ web, id: routine.id, key: second.key, body: 'Update' })).status).toBe(
          202,
        )
        yield* store.patch(owner, routine.id, { trigger: schedule })
        expect(yield* store.issueWebhook(owner, routine.id).pipe(Effect.flip)).toBeInstanceOf(
          RoutineWebhookRequired,
        )
        yield* store.patch(owner, routine.id, { trigger: webhook })
        const cleared = yield* store.get(owner, routine.id)
        expect(cleared.webhookKeyHash).toBeNull()
        expect(cleared.routine.nextExpectedAt).toBeNull()
        expect((yield* post({ web, id: routine.id, key: second.key, body: 'Update' })).status).toBe(
          404,
        )
        expect(yield* Ref.get(yield* Deliveries)).toHaveLength(1)
      }),
    )

    it.effect('bounds streaming bytes at 64 KiB and authorizes before reading the body', () =>
      Effect.gen(function* () {
        const { owner } = yield* fixture()
        const store = yield* RoutineStore
        const routine = yield* store.create(owner, {
          name: 'Bounded work',
          prompt: 'Read payload',
          trigger: webhook,
        })
        const issued = yield* store.issueWebhook(owner, routine.id)
        const web = yield* client()
        expect(
          (yield* post({ web, id: routine.id, key: issued.key, body: 'x'.repeat(64 * 1024) }))
            .status,
        ).toBe(202)
        expect(
          (yield* post({ web, id: routine.id, key: issued.key, body: 'x'.repeat(64 * 1024 + 1) }))
            .status,
        ).toBe(413)
        expect(
          (yield* post({
            web,
            id: routine.id,
            key: Redacted.make('x'.repeat(43)),
            body: 'x'.repeat(64 * 1024 + 1),
          })).status,
        ).toBe(404)
        expect(
          (yield* post({ web, id: routine.id, key: issued.key, body: 'é'.repeat(32 * 1024 + 1) }))
            .status,
        ).toBe(413)
        expect(yield* Ref.get(yield* Deliveries)).toHaveLength(1)
      }),
    )

    it.effect('claims due schedules once using TestClock and derives outcomes from Runs', () =>
      Effect.gen(function* () {
        const { owner } = yield* fixture()
        const store = yield* RoutineStore
        const scheduler = yield* RoutineScheduler
        const database = yield* Database
        yield* TestClock.setTime(0)
        const routine = yield* store.create(owner, {
          name: 'Scheduled work',
          prompt: 'Summarize updates',
          trigger: schedule,
        })
        expect(routine.nextRunAt).toBe(60_000)
        yield* scheduler.runDue()
        expect(yield* Ref.get(yield* Deliveries)).toEqual([])
        yield* TestClock.setTime(60_000)
        yield* Effect.all([scheduler.runDue(), scheduler.runDue()], { concurrency: 2 })
        expect(yield* Ref.get(yield* Deliveries)).toHaveLength(1)
        // The scheduler assigns the durable Routine name, protecting it from automatic naming.
        expect(
          yield* database.run(
            database
              .select()
              .from(threads)
              .where(eq(threads.id, ThreadId.make(`routine-${routine.id}`))),
          ),
        ).toMatchObject([{ title: 'Scheduled work', titleSource: 'Assigned' }])
        const stored = yield* store.list(owner)
        expect(stored[0]).toMatchObject({
          nextRunAt: 120_000,
          runs: [{ status: 'running', finishedAt: null }],
        })
        const latest = stored[0]
        if (latest === undefined)
          return yield* Effect.fail(new DatabaseFailure({ message: 'Scheduled Routine missing' }))
        const occurrence = latest.runs[0]
        if (occurrence === undefined || occurrence.submissionId === null)
          return yield* Effect.fail(new DatabaseFailure({ message: 'Scheduled Run missing' }))
        yield* TestClock.setTime(61_000)
        yield* database.run(
          database
            .update(runs)
            .set({ state: 'completed', finishedAt: 61_000 })
            .where(eq(runs.id, RunId.make(occurrence.submissionId))),
        )
        expect((yield* store.list(owner))[0]).toMatchObject({
          runs: [{ status: 'succeeded', finishedAt: 61_000 }],
        })
        yield* store.patch(owner, routine.id, { enabled: false })
        yield* TestClock.setTime(180_000)
        yield* scheduler.runDue()
        expect(yield* Ref.get(yield* Deliveries)).toHaveLength(1)
        return yield* Effect.void
      }),
    )

    it.effect('retains a tick receipt when the claiming worker dies before delivery', () =>
      Effect.gen(function* () {
        const { owner } = yield* fixture()
        const store = yield* RoutineStore
        yield* TestClock.setTime(0)
        const routine = yield* store.create(owner, {
          name: 'Recover tick',
          prompt: 'Do work',
          trigger: schedule,
        })
        yield* TestClock.setTime(60_000)
        const claimed = yield* store.claimDue()
        const tick = yield* returned(
          claimed.filter(({ record }) => record.routine.id === routine.id),
          'claimed tick',
        )
        expect((yield* store.list(owner))[0]).toMatchObject({
          nextRunAt: 120_000,
          runs: [{ id: tick.attempt.id, submissionId: null }],
        })
        // A new pass sees the committed receipt despite the schedule already having advanced.
        yield* (yield* RoutineScheduler).runDue()
        yield* (yield* RoutineScheduler).runDue()
        expect((yield* store.list(owner))[0]).toMatchObject({
          runs: [{ id: tick.attempt.id, status: 'running' }],
        })
        expect(yield* Ref.get(yield* Deliveries)).toMatchObject([
          { idempotencyKey: tick.attempt.deliveryKey },
        ])
      }),
    )

    it.effect('records failed scheduled admission and replays the same tick on the next pass', () =>
      Effect.gen(function* () {
        const { owner } = yield* fixture()
        const store = yield* RoutineStore
        yield* TestClock.setTime(0)
        const routine = yield* store.create(owner, {
          name: 'Retry tick',
          prompt: 'Do work',
          trigger: schedule,
        })
        yield* TestClock.setTime(60_000)
        yield* Ref.set(
          yield* DeliveryFailure,
          Option.some(new RuntimeUnavailable({ message: 'Unavailable' })),
        )
        expect(yield* (yield* RoutineScheduler).runDue().pipe(Effect.flip)).toBeInstanceOf(
          RuntimeUnavailable,
        )
        const view = yield* returned(yield* store.list(owner), 'Routine')
        const failed = yield* returned(view.runs, 'failed tick')
        expect(failed).toMatchObject({
          submissionId: null,
          error: 'Delivery was not admitted (RuntimeUnavailable)',
          finishedAt: 60_000,
        })
        yield* (yield* RoutineScheduler).runDue()
        expect((yield* store.list(owner))[0]).toMatchObject({
          runs: [{ id: failed.id, status: 'running', error: null, finishedAt: null }],
        })
        expect(yield* Ref.get(yield* Deliveries)).toHaveLength(1)
        expect((yield* store.get(owner, routine.id)).routine.nextRunAt).toBe(120_000)
      }),
    )

    it.effect('retires a disabled scheduled receipt and never resurrects it on enable', () =>
      Effect.gen(function* () {
        const { owner } = yield* fixture()
        const store = yield* RoutineStore
        const scheduler = yield* RoutineScheduler
        yield* TestClock.setTime(0)
        const routine = yield* store.create(owner, {
          name: 'Stopped',
          prompt: 'Do work',
          trigger: schedule,
        })
        yield* TestClock.setTime(60_000)
        const due = yield* returned(yield* store.claimDue(), 'Scheduled tick')
        yield* store.patch(owner, routine.id, { enabled: false })
        yield* scheduler.runDue()
        expect((yield* store.list(owner))[0]).toMatchObject({
          runs: [
            {
              id: due.attempt.id,
              status: 'failed',
              error: 'Its Routine was disabled before delivery',
              finishedAt: 60_000,
            },
          ],
        })
        yield* store.patch(owner, routine.id, { enabled: true })
        yield* scheduler.runDue()
        expect(yield* Ref.get(yield* Deliveries)).toEqual([])
        expect(yield* store.claimDue()).toEqual([])
      }),
    )

    for (const pending of [false, true]) {
      it.effect(`records departed Membership once with an existing receipt ${pending}`, () =>
        Effect.gen(function* () {
          const { owner } = yield* fixture()
          const store = yield* RoutineStore
          const database = yield* Database
          yield* TestClock.setTime(0)
          const routine = yield* store.create(owner, {
            name: 'Departed',
            prompt: 'Do work',
            trigger: schedule,
          })
          yield* TestClock.setTime(60_000)
          if (pending) yield* store.claimDue()
          yield* database.run(
            database.delete(membershipTable).where(eq(membershipTable.userId, owner.person.id)),
          )
          yield* (yield* RoutineScheduler).runDue()
          const failed = yield* returned(
            (yield* returned(yield* store.list(owner), 'Routine')).runs,
            'Occurrence',
          )
          expect(failed).toMatchObject({
            status: 'failed',
            finishedAt: 60_000,
            error: 'Its owner is no longer a Member of its Company',
          })
          yield* TestClock.setTime(120_000)
          yield* (yield* RoutineScheduler).runDue()
          expect((yield* store.list(owner))[0]).toMatchObject({ enabled: false, runs: [failed] })
          const audit = yield* database.run(
            database.select().from(auditEntries).where(eq(auditEntries.personId, owner.person.id)),
          )
          expect(audit).toMatchObject([
            {
              personId: owner.person.id,
              companyId: companyColumnOf(owner.workspace),
              by: 'vivid',
              threadId: null,
              event: AuditEvent.cases.RoutineStopped.make({
                routineId: routine.id,
                reason: 'Membership',
              }),
            },
          ])
          expect(audit).toHaveLength(1)
          expect(yield* Ref.get(yield* Published)).toEqual([
            Topic.person(owner.person.id),
            Topic.company(
              yield* returned(
                Option.toArray(Option.fromNullishOr(companyColumnOf(owner.workspace))),
                'Company',
              ),
            ),
          ])
          expect(yield* Ref.get(yield* Deliveries)).toEqual([])
          expect(
            yield* database.run(
              database.select().from(occurrences).where(eq(occurrences.routineId, routine.id)),
            ),
          ).toHaveLength(1)
        }),
      )
    }

    for (const expired of [false, true]) {
      it.effect(`enforces the 15-minute replay boundary with receipt expired ${expired}`, () =>
        Effect.gen(function* () {
          const { owner } = yield* fixture()
          const store = yield* RoutineStore
          yield* TestClock.setTime(0)
          const routine = yield* store.create(owner, {
            name: 'Bounded',
            prompt: 'Do work',
            trigger: schedule,
          })
          yield* TestClock.setTime(60_000)
          const due = yield* returned(yield* store.claimDue(), 'Scheduled tick')
          // Keep this receipt while moving the next tick beyond the replay window.
          yield* store.patch(owner, routine.id, {
            trigger: RoutineTrigger.cases.Schedule.make({ cron: '0 * * * *', timezone: 'UTC' }),
          })
          const finish = 60_000 + scheduledReplayMillis - (expired ? 0 : 1)
          yield* TestClock.setTime(finish)
          yield* (yield* RoutineScheduler).runDue()
          const view = yield* returned(yield* store.list(owner), 'Routine')
          if (expired) {
            expect(view).toMatchObject({
              lastMissedAt: 60_000,
              runs: [
                {
                  id: due.attempt.id,
                  status: 'failed',
                  error: 'Missed: delivery was not admitted within 15 minutes',
                  finishedAt: finish,
                },
              ],
            })
            yield* TestClock.setTime(finish + 20_000)
            yield* (yield* RoutineScheduler).runDue()
            expect((yield* store.list(owner))[0]).toEqual(view)
            expect(yield* Ref.get(yield* Deliveries)).toEqual([])
          } else {
            expect(view.runs).toMatchObject([{ id: due.attempt.id, status: 'running' }])
            expect(yield* Ref.get(yield* Deliveries)).toHaveLength(1)
          }
        }),
      )
    }

    it.effect('does not replay permanent Thread-authority delivery failure', () =>
      Effect.gen(function* () {
        const { owner } = yield* fixture()
        const store = yield* RoutineStore
        yield* TestClock.setTime(0)
        yield* store.create(owner, { name: 'Lost Thread', prompt: 'Do work', trigger: schedule })
        yield* TestClock.setTime(60_000)
        yield* Ref.set(
          yield* DeliveryFailure,
          Option.some(new NotFound({ message: 'Thread cannot be opened' })),
        )
        expect(yield* (yield* RoutineScheduler).runDue().pipe(Effect.flip)).toBeInstanceOf(NotFound)
        const before = yield* store.list(owner)
        expect(before[0]).toMatchObject({
          runs: [{ status: 'failed', error: 'Its thread could not be opened' }],
        })
        yield* (yield* RoutineScheduler).runDue()
        expect(yield* store.list(owner)).toEqual(before)
        expect(yield* Ref.get(yield* Deliveries)).toEqual([])
      }),
    )

    it.effect(
      'records a Fresh admission failure instead of leaving an unexplained failed receipt',
      () =>
        Effect.gen(function* () {
          const { owner } = yield* fixture()
          const store = yield* RoutineStore
          const routine = yield* store.create(owner, {
            name: 'Fresh failure',
            prompt: 'Do work',
            trigger: webhook,
          })
          yield* Ref.set(
            yield* DeliveryFailure,
            Option.some(new RuntimeUnavailable({ message: 'Unavailable' })),
          )
          expect(
            yield* (yield* RoutineScheduler).run(owner, routine.id).pipe(Effect.flip),
          ).toBeInstanceOf(RuntimeUnavailable)
          expect((yield* store.list(owner))[0]).toMatchObject({
            runs: [{ submissionId: null, error: 'Delivery was not admitted (RuntimeUnavailable)' }],
          })
        }),
    )

    it.effect(
      'continues scheduled and webhook delivery after the owner shares the Routine Thread',
      () =>
        Effect.gen(function* () {
          const { owner } = yield* fixture()
          const store = yield* RoutineStore
          const scheduler = yield* RoutineScheduler
          yield* TestClock.setTime(0)
          const routine = yield* store.create(owner, {
            name: 'Shared Routine',
            prompt: 'Do work',
            trigger: schedule,
          })
          const first = yield* scheduler.run(owner, routine.id)
          // The share API refuses reserved Threads; legacy shared rows must still be deliverable.
          const database = yield* Database
          yield* database.run(
            database
              .update(threads)
              .set({ audience: 'company' })
              .where(eq(threads.id, first.threadId)),
          )
          yield* TestClock.setTime(60_000)
          yield* scheduler.runDue()
          yield* store.patch(owner, routine.id, { trigger: webhook })
          const issued = yield* store.issueWebhook(owner, routine.id)
          expect(
            (yield* post({ web: yield* client(), id: routine.id, key: issued.key, body: 'Update' }))
              .status,
          ).toBe(202)
          expect(yield* Ref.get(yield* Deliveries)).toHaveLength(3)
          const view = yield* returned(yield* store.list(owner), 'Routine')
          expect(view.runs.every((occurrence) => occurrence.threadId === first.threadId)).toBe(true)
        }),
    )

    it.effect('refuses empty and oversized webhook delivery keys before creating a receipt', () =>
      Effect.gen(function* () {
        const { owner } = yield* fixture()
        const store = yield* RoutineStore
        const routine = yield* store.create(owner, {
          name: 'Bound keys',
          prompt: 'Do work',
          trigger: webhook,
        })
        const issued = yield* store.issueWebhook(owner, routine.id)
        const input = { web: yield* client(), id: routine.id, key: issued.key, body: 'Update' }
        expect((yield* postKeyed(input, '')).status).toBe(400)
        expect((yield* postKeyed(input, 'x'.repeat(201))).status).toBe(400)
        const view = yield* returned(yield* store.list(owner), 'Routine')
        expect(view.runs).toEqual([])
        expect((yield* postKeyed(input, 'x'.repeat(200))).status).toBe(202)
        expect(yield* Ref.get(yield* Deliveries)).toHaveLength(1)
      }),
    )

    it.effect('uses every durable Run outcome instead of legacy Occurrence status', () =>
      Effect.gen(function* () {
        const { owner } = yield* fixture()
        const store = yield* RoutineStore
        const scheduler = yield* RoutineScheduler
        const database = yield* Database
        const routine = yield* store.create(owner, {
          name: 'Outcome work',
          prompt: 'Do work',
          trigger: webhook,
        })
        const occurrence = yield* scheduler.run(owner, routine.id)
        if (occurrence.submissionId === null)
          return yield* Effect.fail(new DatabaseFailure({ message: 'Test Run missing' }))
        const id = RunId.make(occurrence.submissionId)
        for (const state of ['failed', 'stopped', 'unknown']) {
          yield* database.run(
            database.update(runs).set({ state, finishedAt: 42 }).where(eq(runs.id, id)),
          )
          expect((yield* store.list(owner))[0]).toMatchObject({
            runs: [{ status: 'failed', finishedAt: 42 }],
          })
        }
        const snapshots = yield* database.run(
          database.select().from(occurrences).where(eq(occurrences.id, occurrence.id)),
        )
        expect(snapshots).toMatchObject([
          { status: 'not-admitted', finishedAt: null, output: null, error: null },
        ])
        return yield* Effect.void
      }),
    )

    it.effect('lists failed history after a Person deletes the Routine Thread and its Runs', () =>
      Effect.gen(function* () {
        const { owner } = yield* fixture()
        const store = yield* RoutineStore
        const routine = yield* store.create(owner, {
          name: 'Deleted history',
          prompt: 'Do work',
          trigger: webhook,
        })
        const occurrence = yield* (yield* RoutineScheduler).run(owner, routine.id)
        const database = yield* Database
        yield* database.run(database.delete(threads).where(eq(threads.id, occurrence.threadId)))
        expect((yield* store.list(owner))[0]).toMatchObject({
          runs: [
            {
              id: occurrence.id,
              status: 'failed',
              finishedAt: occurrence.startedAt,
              error: 'Its thread was deleted',
            },
          ],
        })
      }),
    )

    it.effect('records and notifies failed schedule opening instead of silently advancing it', () =>
      Effect.gen(function* () {
        const { owner, colleague } = yield* fixture()
        const store = yield* RoutineStore
        yield* TestClock.setTime(0)
        const routine = yield* store.create(owner, {
          name: 'Blocked schedule',
          prompt: 'Do work',
          trigger: schedule,
        })
        yield* obstruct(routine.id, colleague)
        yield* TestClock.setTime(60_000)
        expect(yield* (yield* RoutineScheduler).runDue().pipe(Effect.flip)).toBeInstanceOf(
          RoutineThreadUnavailable,
        )
        expect((yield* store.list(owner))[0]).toMatchObject({
          nextRunAt: 120_000,
          runs: [{ status: 'failed', finishedAt: 60_000, error: 'Its thread could not be opened' }],
        })
        const database = yield* Database
        const notices = yield* database.run(
          database.select().from(notifications).where(eq(notifications.personId, owner.person.id)),
        )
        expect(notices).toMatchObject([
          {
            kind: 'needs-you',
            title: routine.name,
            body: 'Its thread could not be opened',
            conversationId: null,
          },
        ])
        expect(yield* Ref.get(yield* Deliveries)).toEqual([])
      }),
    )

    it.effect('returns domain failures for blocked manual and webhook opening', () =>
      Effect.gen(function* () {
        const { owner, colleague } = yield* fixture()
        const store = yield* RoutineStore
        const routine = yield* store.create(owner, {
          name: 'Blocked opening',
          prompt: 'Do work',
          trigger: webhook,
        })
        yield* obstruct(routine.id, colleague)
        const signedIn = AuthState.Person({
          person: owner.person,
          workspace: owner.workspace,
          sessionId: SessionId.make(NodeCrypto.randomUUID()),
        })
        expect(
          yield* routineHandlers
            .RunRoutine({ id: routine.id })
            .pipe(Effect.provideService(AuthContext, signedIn), Effect.flip),
        ).toBeInstanceOf(Conflict)
        const issued = yield* store.issueWebhook(owner, routine.id)
        const web = yield* client()
        expect((yield* post({ web, id: routine.id, key: issued.key, body: 'Update' })).status).toBe(
          409,
        )
        expect((yield* store.list(owner))[0]).toMatchObject({
          runs: [
            { status: 'failed', error: 'Its thread could not be opened' },
            { status: 'failed', error: 'Its thread could not be opened' },
          ],
        })
        expect(yield* Ref.get(yield* Deliveries)).toEqual([])
      }),
    )

    it.effect('does not repeat a failed keyed receipt or its needs-you notice', () =>
      Effect.gen(function* () {
        const { owner, colleague } = yield* fixture()
        const store = yield* RoutineStore
        const routine = yield* store.create(owner, {
          name: 'Blocked keyed webhook',
          prompt: 'Do work',
          trigger: webhook,
        })
        yield* obstruct(routine.id, colleague)
        const issued = yield* store.issueWebhook(owner, routine.id)
        const web = yield* client()
        const input = { web, id: routine.id, key: issued.key, body: 'Update' }
        const responses = yield* Effect.all(
          [postKeyed(input, 'blocked-event'), postKeyed(input, 'blocked-event')],
          { concurrency: 2 },
        )
        expect(responses.map((response) => response.status)).toEqual([409, 409])
        const database = yield* Database
        expect(
          yield* database.run(
            database.select().from(occurrences).where(eq(occurrences.routineId, routine.id)),
          ),
        ).toHaveLength(1)
        expect(
          yield* database.run(
            database
              .select()
              .from(notifications)
              .where(eq(notifications.personId, owner.person.id)),
          ),
        ).toHaveLength(1)
        expect(yield* Ref.get(yield* Deliveries)).toEqual([])
      }),
    )

    it.effect('recovers a failed keyed admission using the original receipt and delivery key', () =>
      Effect.gen(function* () {
        const { owner } = yield* fixture()
        const store = yield* RoutineStore
        const routine = yield* store.create(owner, {
          name: 'Recovering webhook',
          prompt: 'Do work',
          trigger: webhook,
        })
        const issued = yield* store.issueWebhook(owner, routine.id)
        const web = yield* client()
        const input = { web, id: routine.id, key: issued.key, body: 'Update' }
        yield* Ref.set(
          yield* DeliveryFailure,
          Option.some(new RuntimeUnavailable({ message: 'Test admission unavailable' })),
        )
        expect((yield* postKeyed(input, 'recovering-event')).status).toBe(503)
        const database = yield* Database
        const before = yield* database.run(
          database.select().from(occurrences).where(eq(occurrences.routineId, routine.id)),
        )
        const accepted = yield* postKeyed(input, 'recovering-event')
        expect(accepted.status).toBe(202)
        const recovered = yield* receipt(accepted)
        expect(before).toMatchObject([{ id: recovered.occurrenceId, submissionId: null }])
        expect((yield* store.list(owner))[0]).toMatchObject({
          runs: [{ id: recovered.occurrenceId, status: 'running' }],
        })
        expect(yield* Ref.get(yield* Deliveries)).toMatchObject([
          { idempotencyKey: 'recovering-event' },
        ])
      }),
    )

    it.effect('reuses one keyed webhook receipt and delivery across concurrent retries', () =>
      Effect.gen(function* () {
        const { owner } = yield* fixture()
        const store = yield* RoutineStore
        const routine = yield* store.create(owner, {
          name: 'Retried webhook',
          prompt: 'Do work',
          trigger: webhook,
        })
        const issued = yield* store.issueWebhook(owner, routine.id)
        const web = yield* client()
        const input = { web, id: routine.id, key: issued.key, body: 'Update' }
        const responses = yield* Effect.all(
          [postKeyed(input, 'event-123'), postKeyed(input, 'event-123')],
          { concurrency: 2 },
        )
        expect(responses.map((response) => response.status)).toEqual([202, 202])
        const receipts = yield* Effect.forEach(responses, receipt)
        expect(new Set(receipts.map((item) => item.occurrenceId)).size).toBe(1)
        expect(yield* Ref.get(yield* Deliveries)).toMatchObject([{ idempotencyKey: 'event-123' }])
        expect((yield* store.list(owner))[0]).toMatchObject({
          runs: receipts.map((item) => ({ id: item.occurrenceId })).slice(0, 1),
        })
        const again = yield* receipt(
          yield* postKeyed({ ...input, body: 'Different retry payload' }, 'event-123'),
        )
        expect(again).toEqual(receipts[0])
        expect(yield* Ref.get(yield* Deliveries)).toHaveLength(1)
        expect((yield* post(input)).status).toBe(202)
        expect((yield* post(input)).status).toBe(202)
        expect(yield* Ref.get(yield* Deliveries)).toHaveLength(3)
        const database = yield* Database
        yield* database.run(
          database.delete(threads).where(eq(threads.id, ThreadId.make(`routine-${routine.id}`))),
        )
        expect(yield* receipt(yield* postKeyed(input, 'event-123'))).toEqual(again)
        expect(yield* Ref.get(yield* Deliveries)).toHaveLength(3)
      }),
    )

    it.effect(
      'conceals a webhook after its owner leaves the Company without inserting an Occurrence',
      () =>
        Effect.gen(function* () {
          const { owner } = yield* fixture()
          const store = yield* RoutineStore
          const routine = yield* store.create(owner, {
            name: 'Former Member',
            prompt: 'Do work',
            trigger: webhook,
          })
          const issued = yield* store.issueWebhook(owner, routine.id)
          const database = yield* Database
          yield* database.run(
            database.delete(membershipTable).where(eq(membershipTable.userId, owner.person.id)),
          )
          const web = yield* client()
          const refused = yield* post({ web, id: routine.id, key: issued.key, body: 'Update' })
          const missing = yield* post({
            web,
            id: RoutineId.make(NodeCrypto.randomUUID()),
            key: issued.key,
            body: 'Update',
          })
          expect([refused.status, missing.status]).toEqual([404, 404])
          const bodies = yield* Effect.forEach([refused, missing], (response) =>
            Effect.promise(() => response.text()),
          )
          expect(new Set(bodies).size).toBe(1)
          expect(
            yield* database.run(
              database.select().from(occurrences).where(eq(occurrences.routineId, routine.id)),
            ),
          ).toEqual([])
          expect(yield* Ref.get(yield* Deliveries)).toEqual([])
        }),
    )

    it.effect('rechecks Membership when an already authorized webhook is ready for insertion', () =>
      Effect.gen(function* () {
        const { owner } = yield* fixture()
        const store = yield* RoutineStore
        const routine = yield* store.create(owner, {
          name: 'Queued former Member',
          prompt: 'Do work',
          trigger: webhook,
        })
        const issued = yield* store.issueWebhook(owner, routine.id)
        const authorized = yield* store.authorizeWebhook(routine.id, issued.key)
        const database = yield* Database
        yield* database.run(
          database.delete(membershipTable).where(eq(membershipTable.userId, owner.person.id)),
        )
        expect(
          yield* (yield* RoutineScheduler)
            .webhook(authorized, 'Update', RoutineInvocation.cases.Fresh.make({}))
            .pipe(Effect.flip),
        ).toBeInstanceOf(RoutineMissing)
        expect(
          yield* database.run(
            database.select().from(occurrences).where(eq(occurrences.routineId, routine.id)),
          ),
        ).toEqual([])
        expect(yield* Ref.get(yield* Deliveries)).toEqual([])
      }),
    )

    it.effect(
      'batches recent history while preserving the twelve-occurrence limit per Routine',
      () =>
        Effect.gen(function* () {
          const { owner } = yield* fixture()
          const store = yield* RoutineStore
          const database = yield* Database
          const commitments = yield* Effect.forEach(['First', 'Second'], (name) =>
            store.create(owner, { name, prompt: 'Do work', trigger: webhook }),
          )
          for (const routine of commitments) {
            const history = Array.from({ length: 13 }, (_, startedAt) => ({
              id: NodeCrypto.randomUUID(),
              routineId: routine.id,
              conversationId: `routine-${routine.id}`,
              submissionId: null,
              status: 'not-admitted',
              startedAt,
              finishedAt: null,
              output: null,
              error: null,
            }))
            yield* database.run(database.insert(occurrences).values(history))
          }
          const listed = yield* store.list(owner)
          expect(listed).toHaveLength(2)
          for (const routine of listed) {
            expect(routine.runs).toHaveLength(12)
            expect(routine.runs.map((run) => run.startedAt)).toEqual([
              12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1,
            ])
            expect(routine.runs.every((run) => run.routineId === routine.id)).toBe(true)
          }
        }),
    )

    it.effect('rejects contradictory persisted trigger columns and invalid schedules', () =>
      Effect.gen(function* () {
        const { owner } = yield* fixture()
        const store = yield* RoutineStore
        const database = yield* Database
        expect(
          yield* store
            .create(owner, {
              name: 'Bad schedule',
              prompt: 'Do work',
              trigger: RoutineTrigger.cases.Schedule.make({ cron: 'invalid', timezone: 'UTC' }),
            })
            .pipe(Effect.flip),
        ).toBeInstanceOf(InvalidRoutineSchedule)
        expect(yield* store.list(owner)).toEqual([])
        const routine = yield* store.create(owner, {
          name: 'Corrupt work',
          prompt: 'Do work',
          trigger: webhook,
        })
        yield* database.run(
          database
            .update(routines)
            .set({ cron: '* * * * *' })
            .where(and(eq(routines.id, routine.id), eq(routines.personId, owner.person.id))),
        )
        expect(yield* store.list(owner).pipe(Effect.flip)).toBeInstanceOf(DatabaseFailure)
      }),
    )
    it.effect(
      'one Integration event creates one owner-attributed Occurrence with provider content',
      () =>
        Effect.gen(function* () {
          const { owner, routine, store, scheduler } = yield* integrationFixture()
          yield* Ref.set(yield* WatchEvents, [email(1)])
          yield* TestClock.adjust('5 minutes')
          yield* scheduler.runDue()
          const visible = yield* returned(yield* store.list(owner), 'Routine')
          expect(visible.runs).toHaveLength(1)
          expect((yield* returned(visible.runs, 'Occurrence')).submissionId).not.toBeNull()
          const delivered = yield* Ref.get(yield* Deliveries)
          expect(delivered).toHaveLength(1)
          expect((yield* returned(delivered, 'Delivery')).personId).toBe(owner.person.id)
          expect((yield* returned(delivered, 'Delivery')).threadId).toBe(`routine-${routine.id}`)
          expect(
            yield* decodeProviderPayload(
              signalBody(yield* returned(delivered, 'Delivery')).split('Payload:\n')[1],
            ),
          ).toEqual(email(1).content)
          expect(signalBody(yield* returned(delivered, 'Delivery'))).not.toContain(
            'PRIVATE-CONNECTION-MARKER',
          )
        }),
    )

    it.effect('the same Integration event delivered twice retains one Occurrence and one Run', () =>
      Effect.gen(function* () {
        const { owner, store, scheduler } = yield* integrationFixture()
        yield* Ref.set(yield* WatchEvents, [email(1)])
        yield* TestClock.adjust('5 minutes')
        yield* scheduler.runDue()
        yield* TestClock.adjust('5 minutes')
        yield* scheduler.runDue()
        expect((yield* returned(yield* store.list(owner), 'Routine')).runs).toHaveLength(1)
        expect(yield* Ref.get(yield* Deliveries)).toHaveLength(1)
      }),
    )

    it.effect(
      'a burst of three Integration events admits three Occurrences in provider order',
      () =>
        Effect.gen(function* () {
          const { owner, store, scheduler } = yield* integrationFixture()
          yield* Ref.set(yield* WatchEvents, [email(1), email(2), email(3)])
          yield* TestClock.adjust('5 minutes')
          yield* scheduler.runDue()
          const delivered = yield* Ref.get(yield* Deliveries)
          const content = yield* Effect.forEach(delivered, (delivery) =>
            decodeProviderPayload(signalBody(delivery).split('Payload:\n')[1]),
          )
          expect(content).toEqual([email(1).content, email(2).content, email(3).content])
          expect((yield* returned(yield* store.list(owner), 'Routine')).runs).toHaveLength(3)
          expect(new Set(delivered.map((delivery) => delivery.idempotencyKey)).size).toBe(3)
        }),
    )

    it.effect(
      'corrupt Integration rows are recorded and skipped while healthy Routines still deliver',
      () =>
        Effect.gen(function* () {
          const { owner, routine, store, scheduler } = yield* integrationFixture()
          const database = yield* Database
          yield* database.run(
            database.update(routines).set({ integration: null }).where(eq(routines.id, routine.id)),
          )
          const healthy = yield* store.create(owner, {
            name: 'Healthy mail',
            prompt: 'Summarize',
            trigger: RoutineTrigger.cases.Integration.make({
              account: 'Gmail (Work)',
              event: 'mail.received',
              filter: {},
            }),
          })
          yield* Ref.set(yield* WatchEvents, [email(5)])
          yield* TestClock.adjust('5 minutes')
          yield* scheduler.runDue()
          expect((yield* store.get(owner, healthy.id)).routine.enabled).toBe(true)
          expect(yield* Ref.get(yield* Deliveries)).toHaveLength(1)
          const corrupted = yield* database.run(
            database
              .select({ enabled: routines.enabled, pause: routines.pause })
              .from(routines)
              .where(eq(routines.id, routine.id)),
          )
          expect(corrupted).toEqual([
            {
              enabled: false,
              pause: IntegrationNotice.cases.Corrupt.make({
                reason: 'Its stored Integration configuration is invalid',
              }),
            },
          ])
          yield* scheduler.runDue()
          expect(yield* Ref.get(yield* Deliveries)).toHaveLength(1)
        }),
    )

    it.effect(
      're-enabling an Integration Routine prepares a fresh baseline while metadata edits preserve its cursor',
      () =>
        Effect.gen(function* () {
          const { owner, routine, store, scheduler } = yield* integrationFixture()
          const previous = WatchCursor.cases.Item.make({
            id: ProviderEventId.make('previous-baseline'),
          })
          yield* store.recordEvents(
            yield* store.get(owner, routine.id),
            WatchBatch.make({ items: [], cursor: previous }),
          )
          yield* store.patch(owner, routine.id, { prompt: 'Summarize briefly' })
          expect(
            Option.map(
              Option.fromNullishOr((yield* store.get(owner, routine.id)).integration),
              (watch) => watch.cursor,
            ),
          ).toEqual(Option.some(previous))
          yield* store.patch(owner, routine.id, { enabled: false })
          yield* store.patch(owner, routine.id, { enabled: true })
          expect(
            Option.map(
              Option.fromNullishOr((yield* store.get(owner, routine.id)).integration),
              (watch) => watch.cursor,
            ),
          ).toEqual(Option.some(WatchCursor.cases.Empty.make({})))
          yield* Ref.set(yield* WatchEvents, [email(7)])
          yield* TestClock.adjust('5 minutes')
          yield* scheduler.runDue()
          expect((yield* returned(yield* store.list(owner), 'Routine')).runs).toHaveLength(1)
        }),
    )

    it.effect(
      'a lost cursor starts from now, keeps the Routine enabled and tells its Thread once',
      () =>
        Effect.gen(function* () {
          const { owner, routine, store, scheduler } = yield* integrationFixture()
          yield* Ref.set(yield* WatchGap, true)
          yield* Ref.set(yield* WatchEvents, [email(1)])
          yield* TestClock.adjust('5 minutes')
          yield* scheduler.runDue()
          const record = yield* store.get(owner, routine.id)
          expect(record.routine.enabled).toBe(true)
          expect(
            Option.map(Option.fromNullishOr(record.integration), (watch) => watch.cursor),
          ).toEqual(
            Option.some(WatchCursor.cases.Item.make({ id: ProviderEventId.make('baseline-now') })),
          )
          expect((yield* returned(yield* store.list(owner), 'Routine')).runs).toHaveLength(0)
          yield* Ref.set(yield* WatchEvents, [])
          yield* scheduler.runDue()
          expect(yield* Ref.get(yield* Deliveries)).toHaveLength(1)
          expect(
            signalBody(yield* returned(yield* Ref.get(yield* Deliveries), 'Delivery')),
          ).toContain('from now')
          yield* Ref.set(yield* WatchEvents, [email(2)])
          yield* TestClock.adjust('5 minutes')
          yield* scheduler.runDue()
          expect((yield* returned(yield* store.list(owner), 'Routine')).runs).toHaveLength(1)
        }),
    )

    it.effect(
      'transient reads back off one, five, fifteen and sixty minutes across restart, then recover',
      () =>
        Effect.gen(function* () {
          const { owner, routine, store, scheduler } = yield* integrationFixture()
          yield* Ref.set(yield* WatchTransient, true)
          yield* TestClock.adjust('5 minutes')
          const delays = [1, 5, 15, 60, 60]
          for (const minutes of delays) {
            const reads = yield* Ref.get(yield* WatchReads)
            yield* Effect.gen(function* () {
              yield* (yield* RoutineScheduler).runDue()
            }).pipe(
              Effect.provide(routineSchedulerServiceLayer),
              Effect.provide(routineStoreServiceLayer),
              Effect.provide(testConfigLayer),
            )
            const current = yield* store.get(owner, routine.id)
            expect(current.routine.enabled).toBe(true)
            expect(current.routine.nextExpectedAt).toBe(
              (yield* Clock.currentTimeMillis) + minutes * 60_000,
            )
            expect(yield* Ref.get(yield* WatchReads)).toBe(reads + 1)
            yield* scheduler.runDue()
            expect(yield* Ref.get(yield* WatchReads)).toBe(reads + 1)
            yield* TestClock.adjust(minutes * 60_000)
          }
          yield* Ref.set(yield* WatchTransient, false)
          yield* Ref.set(yield* WatchEvents, [email(9)])
          yield* Effect.gen(function* () {
            yield* (yield* RoutineScheduler).runDue()
          }).pipe(
            Effect.provide(routineSchedulerServiceLayer),
            Effect.provide(routineStoreServiceLayer),
            Effect.provide(testConfigLayer),
          )
          expect((yield* returned(yield* store.list(owner), 'Routine')).runs).toHaveLength(1)
          yield* Ref.set(yield* WatchTransient, true)
          yield* TestClock.adjust('5 minutes')
          yield* scheduler.runDue()
          expect((yield* store.get(owner, routine.id)).routine.nextExpectedAt).toBe(
            (yield* Clock.currentTimeMillis) + 60_000,
          )
          expect(yield* Ref.get(yield* Deliveries)).toHaveLength(1)
        }),
    )

    it.effect(
      'Integration Membership loss is audited once, advances revision and publishes both scopes',
      () =>
        Effect.gen(function* () {
          const { owner, routine, store, scheduler } = yield* integrationFixture()
          const before = yield* store.get(owner, routine.id)
          const database = yield* Database
          yield* database.run(
            database.delete(membershipTable).where(eq(membershipTable.userId, owner.person.id)),
          )
          yield* Ref.set(yield* Published, [])
          yield* TestClock.adjust('5 minutes')
          yield* scheduler.runDue()
          const stopped = yield* store.get(owner, routine.id)
          expect(stopped.routine.enabled).toBe(false)
          expect(stopped.watchRevision).toBe(before.watchRevision + 1)
          yield* scheduler.runDue()
          const audit = yield* database.run(
            database.select().from(auditEntries).where(eq(auditEntries.personId, owner.person.id)),
          )
          expect(audit).toMatchObject([
            {
              by: 'vivid',
              personId: owner.person.id,
              companyId: companyColumnOf(owner.workspace),
              event: AuditEvent.cases.RoutineStopped.make({
                routineId: routine.id,
                reason: 'Membership',
              }),
            },
          ])
          expect(audit).toHaveLength(1)
          expect(yield* Ref.get(yield* Published)).toContain(Topic.person(owner.person.id))
          const company = companyColumnOf(owner.workspace)
          if (company === null) expect.fail('The fixture must belong to a Company')
          expect(yield* Ref.get(yield* Published)).toContain(Topic.company(company))
        }),
    )

    it.effect(
      'a revoked Integration pauses its Routine, persists a reason and tells its Thread once',
      () =>
        Effect.gen(function* () {
          const { owner, routine, store, scheduler } = yield* integrationFixture()
          yield* Ref.set(yield* WatchRevoked, true)
          yield* TestClock.adjust('5 minutes')
          yield* scheduler.runDue()
          yield* TestClock.adjust('5 minutes')
          yield* scheduler.runDue()
          expect((yield* store.get(owner, routine.id)).routine.enabled).toBe(false)
          expect((yield* returned(yield* store.list(owner), 'Routine')).runs).toHaveLength(0)
          expect(yield* store.integrationNotices()).toHaveLength(0)
          const delivered = yield* Ref.get(yield* Deliveries)
          expect(delivered).toHaveLength(1)
          expect(signalBody(yield* returned(delivered, 'Delivery'))).toContain(
            'Its Integration was revoked or needs sign-in',
          )
          expect((yield* returned(delivered, 'Delivery')).threadId).toBe(`routine-${routine.id}`)
          // Vivid switched this Routine off on its own, so the record says so, once.
          const database = yield* Database
          const audit = yield* database.run(
            database.select().from(auditEntries).where(eq(auditEntries.personId, owner.person.id)),
          )
          expect(audit).toMatchObject([
            {
              by: 'vivid',
              event: AuditEvent.cases.RoutineStopped.make({
                routineId: routine.id,
                reason: 'Revoked',
              }),
            },
          ])
          expect(audit).toHaveLength(1)
        }),
    )

    it.effect(
      'a restart after the provider receipt commits recovers admission without a new read or duplicate',
      () =>
        Effect.gen(function* () {
          const { owner, routine, store } = yield* integrationFixture()
          const record = yield* store.get(owner, routine.id)
          yield* store.recordEvents(
            record,
            WatchBatch.make({
              items: [email(1)],
              cursor: WatchCursor.cases.Item.make({ id: email(1).id }),
            }),
          )
          expect(yield* store.pendingEvents()).toHaveLength(1)
          // Fresh store and scheduler services recover only from PostgreSQL, with no timer or provider call.
          const restarted = Effect.gen(function* () {
            const scheduler = yield* RoutineScheduler
            yield* scheduler.runDue()
            yield* scheduler.runDue()
          }).pipe(
            Effect.provide(routineSchedulerServiceLayer),
            Effect.provide(routineStoreServiceLayer),
            Effect.provide(testConfigLayer),
          )
          yield* restarted
          const visible = yield* returned(yield* store.list(owner), 'Routine')
          expect(visible.runs).toHaveLength(1)
          expect((yield* returned(visible.runs, 'Occurrence')).submissionId).not.toBeNull()
          expect(yield* store.pendingEvents()).toHaveLength(0)
          expect(yield* Ref.get(yield* WatchReads)).toBe(0)
          expect(yield* Ref.get(yield* Deliveries)).toHaveLength(1)
        }),
    )

    it.effect(
      'a failing Integration notice does not block later notices and retries only its own key',
      () =>
        Effect.gen(function* () {
          const { owner, routine, store, scheduler } = yield* integrationFixture()
          const second = yield* store.create(owner, {
            name: 'Second notice',
            prompt: 'Summarize',
            trigger: routine.trigger,
          })
          for (const id of [routine.id, second.id])
            yield* store.pauseIntegration(
              yield* store.get(owner, id),
              IntegrationStopReason.cases.Revoked.make({}),
            )
          yield* Ref.set(
            yield* DeliveryFailure,
            Option.some(new RuntimeUnavailable({ message: 'Unavailable' })),
          )
          expect(yield* scheduler.runDue().pipe(Effect.flip)).toBeInstanceOf(RuntimeUnavailable)
          expect(yield* Ref.get(yield* Deliveries)).toHaveLength(1)
          expect(yield* store.integrationNotices()).toHaveLength(1)
          yield* scheduler.runDue()
          expect(yield* Ref.get(yield* Deliveries)).toHaveLength(2)
          expect(yield* store.integrationNotices()).toHaveLength(0)
          yield* scheduler.runDue()
          expect(yield* Ref.get(yield* Deliveries)).toHaveLength(2)
        }),
    )

    it.effect('editing a paused Routine preserves its undelivered Integration notice', () =>
      Effect.gen(function* () {
        const { owner, routine, store, scheduler } = yield* integrationFixture()
        yield* store.pauseIntegration(
          yield* store.get(owner, routine.id),
          IntegrationStopReason.cases.Revoked.make({}),
        )
        yield* store.patch(owner, routine.id, { prompt: 'Summarize briefly.' })
        expect(yield* store.integrationNotices()).toHaveLength(1)
        yield* scheduler.runDue()
        yield* scheduler.runDue()
        expect(yield* Ref.get(yield* Deliveries)).toHaveLength(1)
        expect(
          signalBody(yield* returned(yield* Ref.get(yield* Deliveries), 'Delivery')),
        ).toContain('Its Integration was revoked or needs sign-in')
      }),
    )

    it.effect('changing a trigger retires queued provider data before admitting any Run', () =>
      Effect.gen(function* () {
        const { owner, routine, store, scheduler } = yield* integrationFixture()
        yield* store.recordEvents(
          yield* store.get(owner, routine.id),
          WatchBatch.make({
            items: [email(1)],
            cursor: WatchCursor.cases.Item.make({ id: email(1).id }),
          }),
        )
        yield* store.patch(owner, routine.id, { trigger: RoutineTrigger.cases.Webhook.make({}) })
        yield* scheduler.runDue()
        expect(yield* store.pendingEvents()).toHaveLength(0)
        const visible = yield* returned(yield* store.list(owner), 'Routine')
        expect((yield* returned(visible.runs, 'Occurrence')).error).toBe(
          'Its Routine trigger changed before delivery',
        )
        expect(yield* Ref.get(yield* Deliveries)).toHaveLength(0)
      }),
    )
  })
})
