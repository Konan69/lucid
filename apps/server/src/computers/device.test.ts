import { Runtime } from '../runtime/client.ts'
import * as NodeCrypto from 'node:crypto'
import { PgClient } from '@effect/sql-pg/PgClient'
import { describe, expect, layer } from '@effect/vitest'
import { eq } from 'drizzle-orm'
import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate,
  Queue,
  Schema,
  Stream,
} from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import {
  BrowserAction,
  BrowseOutcome,
  BrowseResult,
  Company,
  CompanyId,
  DeviceAnswer,
  DeviceAccess,
  DeviceWork,
  type DeviceAbility,
  WindowAction,
  WindowId,
  LookId,
  WindowResult,
  WindowOutcome,
  DevicePresence,
  DeviceRequestId,
  InstallationId,
  Person,
  PersonId,
  RunId,
  SessionId,
  ThreadId,
  Workspace,
  type Device,
  DEVICE_ASKING_MILLIS,
  DeviceListResponse,
  DeviceRequest,
} from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { refusalLogs } from '../observability/testlogger.ts'
import { Auth, authLayer } from '../auth/provider.ts'
import { personTable, sessionTable } from '../auth/tables.ts'
import { companyTable, membershipTable } from '../companies/tables.ts'
import { Database, decodeStored } from '../database/client.ts'
import { testConfigLayer, testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { CHANNEL, Changes, changesLayer, Topic, everyPart } from '../live/changes.ts'
import { nextValue, payload, silent } from '../live/testing.ts'
import { StoredRunOrigin } from '../threads/conversation.ts'
import { actingRun } from '../threads/runs.ts'
import { approvals } from '../approvals/tables.ts'
import { ActionOrigin, actionOrigin } from '../approvals/gate.ts'
import { runs, threads } from '../threads/tables.ts'
import { BrowseAuthority, DeviceRegistry, deviceLayer } from './device.ts'
import { computerHandlers } from './handlers.ts'
import { DeviceReceipt, DeviceSubscriptionId } from './receipt.ts'
import { deviceRequests, devices } from './tables.ts'

/**
 * Observe subscriptions on the real PostgreSQL change bus. Session removal announces through
 * the auth dialect's writing transaction, so replacing this bus would hide the committed notice.
 * A desktop link subscribes only after the registry has opened it; `watching` is that receipt.
 */
interface BusService {
  readonly watching: Queue.Queue<void>
}
class Bus extends Context.Service<Bus, BusService>()('vivid/test/DeviceBus') {}

const busLayer = Layer.unwrap(
  Effect.gen(function* () {
    const changes = yield* Changes
    const watching = yield* Queue.unbounded<void>()
    const observed = Changes.of({
      publish: (topics) => changes.publish(topics),
      subscribe: Effect.fn('DeviceTest.subscribe')(function* (topics) {
        const subscription = yield* changes.subscribe(topics, everyPart)
        yield* Queue.offer(watching, undefined)
        return subscription
      }),
    })
    return Layer.mergeAll(Layer.succeed(Bus, { watching }), Layer.succeed(Changes, observed))
  }),
).pipe(Layer.provide(changesLayer))

/** Observe the public abort adapter while exercising real Device and Run persistence. */
interface StopsService {
  readonly calls: Queue.Queue<ThreadId>
}
class Stops extends Context.Service<Stops, StopsService>()('vivid/test/DeviceStops') {}
const runtimeTestLayer = Layer.effectContext(
  Effect.gen(function* () {
    const calls = yield* Queue.unbounded<ThreadId>()
    const runtime = Layer.mock(Runtime, {
      stop: Effect.fn('DeviceTest.abort')((thread) =>
        Queue.offer(calls, thread).pipe(Effect.as(true)),
      ),
    })
    return (yield* Layer.build(runtime)).pipe(Context.add(Stops, { calls }))
  }),
)
const testLayer = deviceLayer.pipe(
  Layer.provideMerge(busLayer),
  Layer.provideMerge(runtimeTestLayer),
  Layer.provideMerge(Layer.effect(Database, Database)),
  Layer.provideMerge(testConfigLayer),
)

/** The case layer with the server's own Better Auth, for a case that signs in and out for real. */
const authenticatedLayer = Layer.mergeAll(testLayer, authLayer.pipe(Layer.provide(testConfigLayer)))

const encodeOrigin = Schema.encodeSync(StoredRunOrigin)
const encodeReceipt = Schema.encodeSync(DeviceReceipt)
const typed = 'a secret the ledger must never keep'
const result = BrowseResult.make({
  address: 'https://example.test',
  title: 'Signed-in page',
  outline: 'The signed-in account',
  truncated: false,
  tabs: [{ address: 'https://example.test', title: 'Signed-in page', showing: true }],
})
const done = DeviceAnswer.cases.Done.make({ result })

/** A Person with a session that has not run out. Cleanup is registered before the first write. */
const somebody = Effect.fn('DeviceTest.somebody')(function* (expiresAt: Date) {
  const database = yield* Database
  const id = PersonId.make(NodeCrypto.randomUUID())
  const sessionId = SessionId.make(NodeCrypto.randomUUID())
  yield* Effect.addFinalizer(() =>
    database.run(database.delete(personTable).where(eq(personTable.id, id))).pipe(
      Effect.asVoid,
      Effect.catch(() => Effect.sync(() => expect.fail('Device fixture cleanup failed'))),
    ),
  )
  const person = Person.make({ id, name: 'Device test', email: `${id}@example.test` })
  yield* database.run(
    database.insert(personTable).values({ id, name: person.name, email: person.email }),
  )
  yield* database.run(
    database
      .insert(sessionTable)
      .values({ id: sessionId, token: sessionId, userId: id, expiresAt }),
  )
  return { person, sessionId }
})

type Somebody = Effect.Success<ReturnType<typeof somebody>>
const farFuture = new Date('2999-01-01T00:00:00Z')

/** Runs a handler as a signed-in Person in their personal space, as the auth middleware would. */
const as = (who: Somebody) =>
  Effect.provideService(
    AuthContext,
    AuthState.Person({
      person: who.person,
      sessionId: who.sessionId,
      workspace: Workspace.cases.Personal.make({}),
    }),
  )

/** A real Company selection makes accidental Company fanout observable at the SQL bus. */
const companyWorkspace = Effect.fn('DeviceTest.companyWorkspace')(function* (who: Somebody) {
  const database = yield* Database
  const company = Company.make({
    id: CompanyId.make(NodeCrypto.randomUUID()),
    name: 'Device Company',
    slug: NodeCrypto.randomUUID(),
  })
  yield* Effect.addFinalizer(() =>
    database.run(database.delete(companyTable).where(eq(companyTable.id, company.id))).pipe(
      Effect.asVoid,
      Effect.catch(() => Effect.sync(() => expect.fail('Device Company cleanup failed'))),
    ),
  )
  yield* database.run(database.insert(companyTable).values(company))
  yield* database.run(
    database.insert(membershipTable).values({
      id: NodeCrypto.randomUUID(),
      companyId: company.id,
      userId: who.person.id,
      role: 'member',
    }),
  )
  yield* database.run(
    database
      .update(sessionTable)
      .set({ activeCompanyId: company.id })
      .where(eq(sessionTable.id, who.sessionId)),
  )
  return Effect.provideService(
    AuthContext,
    AuthState.Person({
      person: who.person,
      sessionId: who.sessionId,
      workspace: Workspace.cases.Company.make({ company, role: 'member' }),
    }),
  )
})

/** A Thread with one admitted, working Run that acts for `actingFor`. */
const working = Effect.fn('DeviceTest.working')(function* (owner: Person, actingFor: Person) {
  const database = yield* Database
  const threadId = ThreadId.make(NodeCrypto.randomUUID())
  const runId = RunId.make(NodeCrypto.randomUUID())
  yield* database.run(
    database.insert(threads).values({
      id: threadId,
      title: 'Device test',
      titleSource: 'Person',
      personId: owner.id,
      updatedAt: 0,
    }),
  )
  yield* database.run(
    database.insert(runs).values({
      id: runId,
      threadId,
      personId: actingFor.id,
      turn: 1,
      state: 'working',
      origin: encodeOrigin(StoredRunOrigin.cases.Message.make({})),
      startedAt: 0,
      admittedAt: 0,
    }),
  )
  return { threadId, runId }
})

/** Enrols one installation through the handler, as a desktop app does after sign-in. */
const enrolled = Effect.fn('DeviceTest.enrolled')(function* (who: Somebody, name: string) {
  const installation = InstallationId.make(NodeCrypto.randomUUID())
  const { device } = yield* computerHandlers.EnrolDevice({ installation, name }).pipe(as(who))
  return { device, installation }
})

/**
 * Opens the desktop app's link through the handler and returns once the computer is listening.
 * `ended` is how the stream finished: a success when the link was ended for it, a failure when
 * the session behind it stopped being one.
 */
const listenWith = Effect.fn('DeviceTest.listenWith')(function* (
  who: Somebody,
  device: Device,
  installation: InstallationId,
  ability: DeviceAbility,
) {
  const bus = yield* Bus
  const requests = yield* Queue.unbounded<typeof DeviceRequest.cases.Act.Type>()
  const runEnds = yield* Queue.unbounded<RunId>()
  const ended = yield* computerHandlers
    .WatchDeviceRequests({ device: device.id, installation, ability })
    .pipe(
      Stream.runForEach((request) =>
        DeviceRequest.match(request, {
          Act: (act) => Queue.offer(requests, act),
          RunEnded: ({ runId }) => Queue.offer(runEnds, runId),
        }),
      ),
      as(who),
      Effect.forkScoped,
    )
  yield* Queue.take(bus.watching)
  return { requests, runEnds, ended }
})

/** Existing page tests keep their page-only desktop capability. */
const listen = (who: Somebody, device: Device, installation: InstallationId) =>
  listenWith(who, device, installation, { pages: true, apps: false, egress: false })

/** Use the runtime-only RPC with the same Person/Thread authority as Browse. */
const useWindow = (who: Somebody, threadId: ThreadId, action: WindowAction) =>
  computerHandlers.UseWindow({ action, summary: 'Work in the window' }).pipe(
    Effect.provideService(
      AuthContext,
      AuthState.Vivid({
        person: who.person,
        workspace: Workspace.cases.Personal.make({}),
        threadId,
      }),
    ),
  )

/** Real connected Device and admitted Run; only the desktop's answers are controlled. */
const native = Effect.fn('DeviceTest.native')(function* () {
  const who = yield* somebody(farFuture)
  const { device, installation } = yield* enrolled(who, 'Windows computer')
  yield* computerHandlers.AllowDevice({ id: device.id }).pipe(as(who))
  const link = yield* listenWith(who, device, installation, {
    pages: true,
    apps: true,
    egress: false,
  })
  const run = yield* working(who.person, who.person)
  return { who, device, installation, link, ...run }
})

/**
 * Acknowledge the public handler's bounded turn wait, without replacing its permit or SQL.
 * Effect 4.0.2 timeoutOption races work with Clock.sleep. With the first desktop request held,
 * its ten-second timer proves this next handler reached the queue; interruption joins both
 * race branches before the first request is answered. Delegate every clock reading and wait
 * to this case's TestClock, preserving method receivers.
 */
const queuedWindow = Effect.fn('DeviceTest.queuedWindow')(function* (
  who: Somebody,
  threadId: ThreadId,
) {
  const clock = yield* Clock.Clock
  const entered = yield* Deferred.make<void>()
  const observed: Clock.Clock = {
    currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
    currentTimeMillis: clock.currentTimeMillis,
    currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
    currentTimeNanos: clock.currentTimeNanos,
    monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: clock.monotonicTimeNanos,
    sleep: (duration) =>
      Effect.gen(function* () {
        if (Duration.toMillis(duration) === 10_000) yield* Deferred.succeed(entered, undefined)
        yield* clock.sleep(duration)
      }),
  }
  const running = yield* useWindow(who, threadId, look).pipe(
    Effect.provideService(Clock.Clock, observed),
    Effect.forkScoped,
  )
  yield* Effect.raceFirst(
    Deferred.await(entered),
    Fiber.join(running).pipe(
      Effect.andThen(
        Effect.sync(() =>
          expect.fail('Queued Window work settled before acknowledging its turn wait'),
        ),
      ),
    ),
  )
  return running
})

/** Accept a controlled desktop answer through the authenticated public handler. */
const answerWindow = (test: Effect.Success<ReturnType<typeof native>>, id: DeviceRequestId) =>
  computerHandlers
    .AnswerDeviceRequest({
      device: test.device.id,
      id,
      answer: DeviceAnswer.cases.Did.make({ result: seen }),
    })
    .pipe(as(test.who))

/** Read only this fixture Device's ledger, so other cases cannot make an empty assertion pass. */
const windowLedger = Effect.fn('DeviceTest.windowLedger')(function* (
  test: Effect.Success<ReturnType<typeof native>>,
) {
  const database = yield* Database
  return yield* database.run(
    database.select().from(deviceRequests).where(eq(deviceRequests.deviceId, test.device.id)),
  )
})

const windowId = WindowId.make('window-1')
const look = WindowAction.cases.Look.make({ window: windowId })
const seen = WindowResult.cases.Seen.make({
  view: {
    window: windowId,
    app: 'Terminal',
    look: LookId.make('look-1'),
    picture: 'private picture',
    width: 100,
    height: 100,
    outline: 'private outline',
    truncated: false,
  },
})

const listed = (who: Somebody) =>
  computerHandlers.ListDevices().pipe(
    as(who),
    Effect.map(({ devices: all }) =>
      all.map((device) => [device.name, device.access._tag, device.presence._tag]),
    ),
  )

/** Await the real WatchDevices first emission before exercising writes or desktop lifecycle. */
const watchingDevices = Effect.fn('DeviceTest.watchingDevices')(function* (who: Somebody) {
  const values = yield* Queue.unbounded<typeof DeviceListResponse.Type>()
  const first = yield* Deferred.make<void>()
  const fiber = yield* computerHandlers.WatchDevices().pipe(
    Stream.runForEach((value) =>
      Queue.offer(values, value).pipe(Effect.andThen(Deferred.succeed(first, undefined))),
    ),
    as(who),
    Effect.forkScoped,
  )
  yield* Effect.raceFirst(Deferred.await(first), Fiber.join(fiber))
  const initial = yield* Queue.take(values)
  const receipt = yield* (yield* Changes).subscribe([Topic.person(who.person.id)], everyPart)
  // listen() uses Bus's next subscription receipt to prove desktop admission. The list's own
  // subscription receipts are already accounted for by its initial emission, so consume them.
  yield* Queue.takeAll((yield* Bus).watching)
  return { values, fiber, initial, receipt }
})

const read = BrowserAction.cases.Read.make({})

/** Why a dispatch was refused for want of a Run, or the tag of whatever else refused it. */
const reasonOf = (failure: Effect.Error<ReturnType<DeviceRegistry['Service']['browse']>>) =>
  Predicate.isTagged(failure, 'NoActingRun') ? failure.reason : failure._tag

/** Ordinary EOF must be successful; defects and interruption are failures even without a typed error. */
const failureOf = <E extends { readonly _tag: string }>(exit: Exit.Exit<void, E>) => {
  if (Exit.isSuccess(exit)) return 'ended'
  return Option.match(Exit.findErrorOption(exit), {
    onNone: () => 'defect or interruption',
    onSome: (failure) => failure._tag,
  })
}

/** Acquire each Device registry and notice queue in its case scope so links and presence workers cannot survive into another case. Install a fresh clock first, except for production sign-out, which needs real time. */
function scopedCase<Services, LayerError, Dependencies, A, E, R>(
  caseLayer: Layer.Layer<Services, LayerError, Dependencies>,
  program: Effect.Effect<A, E, R>,
  clock: 'fresh' | 'inherited',
) {
  const acquired = Layer.build(caseLayer).pipe(
    Effect.flatMap((context) => program.pipe(Effect.provide(context))),
    Effect.scoped,
  )
  if (clock === 'inherited') return acquired
  return acquired.pipe(Effect.provideServiceEffect(Clock.Clock, TestClock.make()))
}

/** Real PostgreSQL holds the Devices, Runs and ledger; the desktop app is the handlers' caller. */
describe.skipIf(!testDatabaseConfigured)('A Person’s own computer', () => {
  layer(testDatabaseLayer, { excludeTestServices: true })((it) => {
    it.effect(
      'desktop connect and disconnect announce only the Person in a Company workspace',
      () =>
        Effect.gen(function* () {
          const ada = yield* somebody(farFuture)
          const signedInCompany = yield* companyWorkspace(ada)
          const { device, installation } = yield* enrolled(ada, 'Laptop')
          yield* computerHandlers.AllowDevice({ id: device.id }).pipe(signedInCompany)
          const notices = yield* (yield* PgClient).listen(CHANNEL)
          const connected = yield* computerHandlers
            .WatchDeviceRequests({
              device: device.id,
              installation,
              ability: { pages: true, apps: false, egress: false },
            })
            .pipe(Stream.runDrain, signedInCompany, Effect.forkScoped)
          yield* Queue.take((yield* Bus).watching)
          yield* payload(notices, [Topic.person(ada.person.id)])
          yield* Fiber.interrupt(connected)
          yield* payload(notices, [Topic.person(ada.person.id)])
          expect(yield* listed(ada)).toEqual([['Laptop', 'Allowed', 'Offline']])
        }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )

    it.effect('refused desktop admission announces nothing on any topic', () =>
      Effect.gen(function* () {
        const ada = yield* somebody(farFuture)
        const signedInCompany = yield* companyWorkspace(ada)
        const { device, installation } = yield* enrolled(ada, 'Laptop')
        const notices = yield* (yield* PgClient).listen(CHANNEL)
        const failure = yield* computerHandlers
          .WatchDeviceRequests({
            device: device.id,
            installation,
            ability: { pages: true, apps: false, egress: false },
          })
          .pipe(Stream.runDrain, signedInCompany, Effect.flip)
        expect(failure._tag).toBe('Forbidden')
        yield* silent(notices)
        expect(yield* listed(ada)).toEqual([['Laptop', 'Pending', 'Offline']])
      }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )

    it.effect('replacement keeps the Device Connected until the successor disconnects', () =>
      Effect.gen(function* () {
        const ada = yield* somebody(farFuture)
        const { device, installation } = yield* enrolled(ada, 'Laptop')
        yield* computerHandlers.AllowDevice({ id: device.id }).pipe(as(ada))
        const watch = yield* watchingDevices(ada)
        const previous = yield* listen(ada, device, installation)
        expect((yield* nextValue(watch)).devices[0]).toMatchObject({
          presence: DevicePresence.cases.Connected.make({
            ability: { pages: true, apps: false, egress: false },
          }),
        })
        const successor = yield* listen(ada, device, installation)
        expect(Exit.isSuccess(yield* Fiber.await(previous.ended))).toBe(true)
        // Replacement opens one link and closes the old one. Consume both actual bus receipts
        // before advancing the debounce clock; neither can emit a false Offline transition.
        yield* watch.receipt.pipe(Stream.take(2), Stream.runDrain)
        yield* TestClock.adjust('20 millis')
        expect(yield* listed(ada)).toEqual([['Laptop', 'Allowed', 'Connected']])
        expect(yield* Queue.size(watch.values)).toBe(0)
        yield* Fiber.interrupt(successor.ended)
        expect((yield* nextValue(watch)).devices[0]).toMatchObject({
          presence: DevicePresence.cases.Offline.make({}),
        })
      }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )

    it.effect('WatchDevices emits enrol, allow and revoke using the one-shot loader', () =>
      Effect.gen(function* () {
        const ada = yield* somebody(farFuture)
        const watch = yield* watchingDevices(ada)
        expect(watch.initial.devices).toEqual([])
        const { device } = yield* enrolled(ada, 'Laptop')
        const enrolledNotice = yield* nextValue(watch)
        expect(enrolledNotice.devices).toMatchObject([
          {
            id: device.id,
            name: 'Laptop',
            access: DeviceAccess.cases.Pending.make({ since: 0 }),
            presence: DevicePresence.cases.Offline.make({}),
          },
        ])
        // Its app enrolled just now and it is waiting: it is asking to be allowed.
        expect(enrolledNotice.asking).toEqual([device.id])
        // Each nextValue advances the debounce clock by 20 ms; access dates precede that advance.
        const allowed = yield* computerHandlers.AllowDevice({ id: device.id }).pipe(as(ada))
        const allowedNotice = yield* nextValue(watch)
        expect(allowedNotice.devices).toMatchObject([
          {
            id: device.id,
            name: 'Laptop',
            access: DeviceAccess.cases.Allowed.make({ since: 20 }),
            presence: DevicePresence.cases.Offline.make({}),
          },
        ])
        expect(allowedNotice.devices).toEqual([allowed.device])
        expect(allowedNotice.asking).toEqual([])
        const revoked = yield* computerHandlers.RevokeDevice({ id: device.id }).pipe(as(ada))
        const live = yield* nextValue(watch)
        expect(live.devices).toMatchObject([
          {
            id: device.id,
            name: 'Laptop',
            access: DeviceAccess.cases.Revoked.make({ since: 40 }),
            presence: DevicePresence.cases.Offline.make({}),
          },
        ])
        expect(live.devices).toEqual([revoked.device])
        expect(yield* computerHandlers.ListDevices().pipe(as(ada))).toEqual(live)
      }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )

    it.effect('a waiting computer asks only while its app keeps enrolling', () =>
      Effect.gen(function* () {
        const ada = yield* somebody(farFuture)
        const { device, installation } = yield* enrolled(ada, 'Laptop')
        const asking = computerHandlers.ListDevices().pipe(
          as(ada),
          Effect.map((list) => list.asking),
        )
        expect(yield* asking).toEqual([device.id])
        yield* TestClock.adjust(DEVICE_ASKING_MILLIS - 1)
        expect(yield* asking).toEqual([device.id])
        // The app was closed: a minute without enrolling and it is no longer asked about.
        yield* TestClock.adjust(1)
        expect(yield* asking).toEqual([])
        // The same app enrolling again is asking again.
        yield* computerHandlers.EnrolDevice({ installation, name: 'Laptop' }).pipe(as(ada))
        expect(yield* asking).toEqual([device.id])
      }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )

    it.effect('WatchDevices emits desktop connection and scoped disconnection', () =>
      Effect.gen(function* () {
        const ada = yield* somebody(farFuture)
        const { device, installation } = yield* enrolled(ada, 'Laptop')
        yield* computerHandlers.AllowDevice({ id: device.id }).pipe(as(ada))
        const watch = yield* watchingDevices(ada)
        expect(watch.initial.devices[0]).toMatchObject({
          presence: DevicePresence.cases.Offline.make({}),
        })
        const link = yield* listen(ada, device, installation)
        expect((yield* nextValue(watch)).devices[0]).toMatchObject({
          presence: DevicePresence.cases.Connected.make({
            ability: { pages: true, apps: false, egress: false },
          }),
        })
        yield* Fiber.interrupt(link.ended)
        expect((yield* nextValue(watch)).devices[0]).toMatchObject({
          presence: DevicePresence.cases.Offline.make({}),
        })
      }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )

    it.effect('WatchDevices only lists the signed-in Person computers', () =>
      Effect.gen(function* () {
        const ada = yield* somebody(farFuture)
        const tola = yield* somebody(farFuture)
        yield* enrolled(ada, 'Ada’s laptop')
        const watch = yield* watchingDevices(tola)
        expect(watch.initial.devices).toEqual([])
        const { device } = yield* enrolled(tola, 'Tola’s laptop')
        expect((yield* nextValue(watch)).devices).toMatchObject([
          {
            id: device.id,
            name: 'Tola’s laptop',
            access: DeviceAccess.cases.Pending.make({ since: 0 }),
            presence: DevicePresence.cases.Offline.make({}),
          },
        ])
      }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )

    /** Only the accepted ledger answer decides Refused; repeats and outward Browse values do not. */
    it.effect('records a device refusal once after accepting the answer and rejects replay', () => {
      const logs = refusalLogs()
      return Effect.gen(function* () {
        const ada = yield* somebody(farFuture)
        const { device, installation } = yield* enrolled(ada, 'Laptop')
        yield* computerHandlers.AllowDevice({ id: device.id }).pipe(as(ada))
        const link = yield* listen(ada, device, installation)
        const { threadId, runId } = yield* working(ada.person, ada.person)
        const running = yield* (yield* DeviceRegistry)
          .browse({
            personId: ada.person.id,
            threadId,
            runId,
            action: read,
            authority: BrowseAuthority.cases.Acting.make({}),
          })
          .pipe(Effect.forkScoped)
        const request = yield* Queue.take(link.requests)
        const answer = {
          device: device.id,
          id: request.id,
          answer: DeviceAnswer.cases.Refused.make({ reason: 'NotAllowed' }),
        }
        yield* computerHandlers.AnswerDeviceRequest(answer).pipe(as(ada))
        expect(yield* Fiber.join(running)).toEqual(BrowseOutcome.cases.AddressRefused.make({}))
        expect(
          (yield* computerHandlers.AnswerDeviceRequest(answer).pipe(as(ada), Effect.flip))._tag,
        ).toBe('Forbidden')
        const database = yield* Database
        const [row] = yield* database.run(
          database.select().from(deviceRequests).where(eq(deviceRequests.id, request.id)),
        )
        expect(row).toMatchObject({
          receipt: encodeReceipt(DeviceReceipt.cases.Refused.make({ reason: 'NotAllowed' })),
        })
        const recorded = logs.recorded()
        expect(recorded).toHaveLength(1)
        expect(recorded[0]).toContain('vivid.refusal.kind=DeviceRefused')
        expect(recorded[0]).toContain('vivid.refusal.reason=NotAllowed')
      }).pipe(Effect.scoped, (program) =>
        scopedCase(testLayer.pipe(Layer.provideMerge(logs.layer)), program, 'fresh'),
      )
    })

    it.effect('enrolling is repeatable per Person and installation, and grants nothing', () =>
      Effect.gen(function* () {
        const ada = yield* somebody(farFuture)
        const tola = yield* somebody(farFuture)
        const first = yield* enrolled(ada, 'Ada’s laptop')
        const again = yield* computerHandlers
          .EnrolDevice({ installation: first.installation, name: 'Renamed by the app' })
          .pipe(as(ada))
        expect(again.device).toEqual(first.device)
        expect(first.device.access._tag).toBe('Pending')
        // The same installation signed in as somebody else is that Person's own, separate Device.
        const theirs = yield* computerHandlers
          .EnrolDevice({ installation: first.installation, name: 'Shared machine' })
          .pipe(as(tola))
        expect(theirs.device.id).not.toBe(first.device.id)
        expect(yield* listed(ada)).toEqual([['Ada’s laptop', 'Pending', 'Offline']])
        const vivid = yield* computerHandlers
          .EnrolDevice({ installation: first.installation, name: 'Vivid' })
          .pipe(
            Effect.provideService(
              AuthContext,
              AuthState.Vivid({
                person: ada.person,
                workspace: Workspace.cases.Personal.make({}),
                threadId: ThreadId.make('any'),
              }),
            ),
            Effect.flip,
          )
        expect(vivid._tag).toBe('Forbidden')
      }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )

    it.effect('only the enrolled installation of an allowed Device may listen', () =>
      Effect.gen(function* () {
        const ada = yield* somebody(farFuture)
        const tola = yield* somebody(farFuture)
        const { device, installation } = yield* enrolled(ada, 'Ada’s laptop')
        const refused = (who: Somebody, presented: InstallationId) =>
          computerHandlers
            .WatchDeviceRequests({
              device: device.id,
              installation: presented,
              ability: { pages: true, apps: false, egress: false },
            })
            .pipe(
              Stream.runDrain,
              as(who),
              Effect.flip,
              Effect.map((failure) => failure._tag),
            )
        // Enrolled, never allowed.
        expect(yield* refused(ada, installation)).toBe('Forbidden')
        yield* computerHandlers.AllowDevice({ id: device.id }).pipe(as(ada))
        // A web or mobile session of the same Person knows the Device from the list, but has no
        // installation to present.
        expect(yield* refused(ada, InstallationId.make(NodeCrypto.randomUUID()))).toBe('NotFound')
        // Another Person, even holding the installation value.
        expect(yield* refused(tola, installation)).toBe('NotFound')
        expect(yield* listed(ada)).toEqual([['Ada’s laptop', 'Allowed', 'Offline']])
        const allowing = yield* computerHandlers
          .AllowDevice({ id: device.id })
          .pipe(as(tola), Effect.flip)
        expect(allowing._tag).toBe('NotFound')
      }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )

    it.effect('allowing one computer revokes the other and ends its link', () =>
      Effect.gen(function* () {
        const ada = yield* somebody(farFuture)
        const laptop = yield* enrolled(ada, 'Laptop')
        const tower = yield* enrolled(ada, 'Tower')
        yield* computerHandlers.AllowDevice({ id: laptop.device.id }).pipe(as(ada))
        const link = yield* listen(ada, laptop.device, laptop.installation)
        expect(yield* listed(ada)).toContainEqual(['Laptop', 'Allowed', 'Connected'])
        yield* computerHandlers.AllowDevice({ id: tower.device.id }).pipe(as(ada))
        expect(Exit.isSuccess(yield* Fiber.await(link.ended))).toBe(true)
        expect(new Set(yield* listed(ada))).toEqual(
          new Set([
            ['Laptop', 'Revoked', 'Offline'],
            ['Tower', 'Allowed', 'Offline'],
          ]),
        )
      }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )

    it.effect('revoking ends presence at once and the computer cannot listen again', () =>
      Effect.gen(function* () {
        const ada = yield* somebody(farFuture)
        const { device, installation } = yield* enrolled(ada, 'Laptop')
        yield* computerHandlers.AllowDevice({ id: device.id }).pipe(as(ada))
        const link = yield* listen(ada, device, installation)
        const revoked = yield* computerHandlers.RevokeDevice({ id: device.id }).pipe(as(ada))
        expect([revoked.device.access._tag, revoked.device.presence._tag]).toEqual([
          'Revoked',
          'Offline',
        ])
        expect(Exit.isSuccess(yield* Fiber.await(link.ended))).toBe(true)
        const again = yield* computerHandlers
          .WatchDeviceRequests({
            device: device.id,
            installation,
            ability: { pages: true, apps: false, egress: false },
          })
          .pipe(Stream.runDrain, as(ada), Effect.flip)
        expect(again._tag).toBe('Forbidden')
        const registry = yield* DeviceRegistry
        expect((yield* registry.requireConnected(ada.person.id).pipe(Effect.flip))._tag).toBe(
          'NoDeviceConnected',
        )
      }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )

    it.effect(
      'a newer link replaces the older one, a request is bound to its Run, and the ledger keeps no content',
      () =>
        Effect.gen(function* () {
          const ada = yield* somebody(farFuture)
          const { device, installation } = yield* enrolled(ada, 'Laptop')
          yield* computerHandlers.AllowDevice({ id: device.id }).pipe(as(ada))
          const stale = yield* listen(ada, device, installation)
          const fresh = yield* listen(ada, device, installation)
          expect(Exit.isSuccess(yield* Fiber.await(stale.ended))).toBe(true)
          const { threadId, runId } = yield* working(ada.person, ada.person)
          const registry = yield* DeviceRegistry
          const running = yield* registry
            .browse({
              personId: ada.person.id,
              threadId,
              runId,
              action: BrowserAction.cases.Type.make({ target: 'Password', text: typed }),
              authority: BrowseAuthority.cases.Acting.make({}),
            })
            .pipe(Effect.forkScoped)
          const request = yield* Queue.take(fresh.requests)
          expect([request.threadId, request.runId]).toEqual([threadId, runId])
          expect(yield* Queue.size(stale.requests)).toBe(0)
          const answer = { device: device.id, id: request.id, answer: done }
          // Another session of the same Person is not the link the request went out on.
          const elsewhere = yield* somebody(farFuture)
          const other = { person: ada.person, sessionId: elsewhere.sessionId }
          expect(
            (yield* computerHandlers.AnswerDeviceRequest(answer).pipe(as(other), Effect.flip))._tag,
          ).toBe('Forbidden')
          yield* computerHandlers.AnswerDeviceRequest(answer).pipe(as(ada))
          expect(yield* Fiber.join(running)).toEqual(BrowseOutcome.cases.Completed.make({ result }))
          expect(
            (yield* computerHandlers.AnswerDeviceRequest(answer).pipe(as(ada), Effect.flip))._tag,
          ).toBe('Forbidden')
          const database = yield* Database
          const [row] = yield* database.run(
            database.select().from(deviceRequests).where(eq(deviceRequests.id, request.id)),
          )
          expect(row).toMatchObject({
            deviceId: device.id,
            threadId,
            runId,
            action: 'Type',
            status: 'Done',
            receipt: encodeReceipt(DeviceReceipt.cases.Done.make({})),
          })
          const kept = JSON.stringify(row)
          expect(kept).not.toContain(typed)
          expect(kept).not.toContain(result.outline)
        }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )

    it.effect('a Run acting for another Person in a shared Thread cannot use this computer', () =>
      Effect.gen(function* () {
        const ada = yield* somebody(farFuture)
        const tola = yield* somebody(farFuture)
        const { device, installation } = yield* enrolled(ada, 'Laptop')
        yield* computerHandlers.AllowDevice({ id: device.id }).pipe(as(ada))
        const link = yield* listen(ada, device, installation)
        const registry = yield* DeviceRegistry
        const database = yield* Database
        // Tola's message started the Run; Ada is only present in the Thread.
        const shared = yield* working(ada.person, tola.person)
        const refused = yield* registry
          .browse({
            personId: ada.person.id,
            threadId: shared.threadId,
            runId: shared.runId,
            action: read,
            authority: BrowseAuthority.cases.Acting.make({}),
          })
          .pipe(Effect.flip)
        expect(reasonOf(refused)).toBe('ActsForAnotherPerson')
        // No Run at all, and a turn that was reserved but never accepted, are refused the same way.
        const idle = yield* working(ada.person, ada.person)
        yield* database.run(
          database.update(runs).set({ admittedAt: null }).where(eq(runs.id, idle.runId)),
        )
        expect(
          reasonOf(
            yield* registry
              .browse({
                personId: ada.person.id,
                threadId: idle.threadId,
                runId: idle.runId,
                action: read,
                authority: BrowseAuthority.cases.Acting.make({}),
              })
              .pipe(Effect.flip),
          ),
        ).toBe('NoWorkingRun')
        // Joined same-Person Runs keep their host origin; an explicitly absent Run refuses absence.
        const busy = yield* working(ada.person, ada.person)
        yield* database.run(
          database.insert(runs).values({
            id: RunId.make(NodeCrypto.randomUUID()),
            threadId: busy.threadId,
            personId: ada.person.id,
            turn: 2,
            state: 'working',
            origin: encodeOrigin(StoredRunOrigin.cases.Message.make({})),
            startedAt: 0,
            admittedAt: 0,
          }),
        )
        expect(yield* actingRun(busy.threadId, ada.person.id)).toBe(busy.runId)
        expect(
          yield* actionOrigin({
            person: ada.person,
            workspace: Workspace.cases.Personal.make({}),
            by: 'vivid',
            threadId: Option.some(busy.threadId),
          }),
        ).toEqual(ActionOrigin.cases.Run.make({ threadId: busy.threadId, runId: busy.runId }))
        expect(
          (yield* actionOrigin({
            person: ada.person,
            workspace: Workspace.cases.Personal.make({}),
            by: 'vivid',
            threadId: Option.some(shared.threadId),
          }).pipe(Effect.flip))._tag,
        ).toBe('NotFound')
        expect(
          reasonOf(
            yield* registry
              .browse({
                personId: ada.person.id,
                threadId: busy.threadId,
                runId: RunId.make(NodeCrypto.randomUUID()),
                action: read,
                authority: BrowseAuthority.cases.Acting.make({}),
              })
              .pipe(Effect.flip),
          ),
        ).toBe('NoWorkingRun')
        expect(yield* Queue.size(link.requests)).toBe(0)
        expect(
          yield* database.run(
            database.select().from(deviceRequests).where(eq(deviceRequests.deviceId, device.id)),
          ),
        ).toEqual([])
      }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )

    it.effect('one Person’s unanswered request does not hold up another Person’s computer', () =>
      Effect.gen(function* () {
        const ada = yield* somebody(farFuture)
        const tola = yield* somebody(farFuture)
        const registry = yield* DeviceRegistry
        const ready = Effect.fn('DeviceTest.ready')(function* (who: Somebody) {
          const { device, installation } = yield* enrolled(who, 'Computer')
          yield* computerHandlers.AllowDevice({ id: device.id }).pipe(as(who))
          const link = yield* listen(who, device, installation)
          const { threadId, runId } = yield* working(who.person, who.person)
          const running = yield* registry
            .browse({
              personId: who.person.id,
              threadId,
              runId,
              action: read,
              authority: BrowseAuthority.cases.Acting.make({}),
            })
            .pipe(Effect.forkScoped)
          return { device, running, request: yield* Queue.take(link.requests) }
        })
        // Ada's computer has taken a request and says nothing.
        const slow = yield* ready(ada)
        const quick = yield* ready(tola)
        yield* computerHandlers
          .AnswerDeviceRequest({ device: quick.device.id, id: quick.request.id, answer: done })
          .pipe(as(tola))
        expect(yield* Fiber.join(quick.running)).toEqual(
          BrowseOutcome.cases.Completed.make({ result }),
        )
        // Tola cannot answer for Ada's computer either.
        expect(
          (yield* computerHandlers
            .AnswerDeviceRequest({ device: slow.device.id, id: slow.request.id, answer: done })
            .pipe(as(tola), Effect.flip))._tag,
        ).toBe('Forbidden')
        yield* computerHandlers
          .AnswerDeviceRequest({ device: slow.device.id, id: slow.request.id, answer: done })
          .pipe(as(ada))
        expect(yield* Fiber.join(slow.running)).toEqual(
          BrowseOutcome.cases.Completed.make({ result }),
        )
      }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )

    it.effect('a passed deadline is recorded as unknown and a late answer changes nothing', () =>
      Effect.gen(function* () {
        const ada = yield* somebody(farFuture)
        const { device, installation } = yield* enrolled(ada, 'Laptop')
        yield* computerHandlers.AllowDevice({ id: device.id }).pipe(as(ada))
        const link = yield* listen(ada, device, installation)
        const { threadId, runId } = yield* working(ada.person, ada.person)
        const running = yield* (yield* DeviceRegistry)
          .browse({
            personId: ada.person.id,
            threadId,
            runId,
            action: read,
            authority: BrowseAuthority.cases.Acting.make({}),
          })
          .pipe(Effect.forkScoped)
        const request = yield* Queue.take(link.requests)
        yield* TestClock.adjust('30 seconds')
        expect(yield* Fiber.join(running)).toEqual(BrowseOutcome.cases.OutcomeUnknown.make({}))
        expect(
          (yield* computerHandlers
            .AnswerDeviceRequest({ device: device.id, id: request.id, answer: done })
            .pipe(as(ada), Effect.flip))._tag,
        ).toBe('Forbidden')
        const database = yield* Database
        const [row] = yield* database.run(
          database
            .select({ status: deviceRequests.status })
            .from(deviceRequests)
            .where(eq(deviceRequests.id, request.id)),
        )
        expect(row).toEqual({ status: 'OutcomeUnknown' })
      }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )

    it.effect('a restarted server closes the expired requests a previous one left open', () =>
      Effect.gen(function* () {
        const ada = yield* somebody(farFuture)
        const { device } = yield* enrolled(ada, 'Laptop')
        const { threadId, runId } = yield* working(ada.person, ada.person)
        const database = yield* Database
        const abandoned = Effect.fn('DeviceTest.abandoned')(function* (expiresAt: number) {
          const id = DeviceRequestId.make(NodeCrypto.randomUUID())
          // The crash boundary: the row was committed and the process that was waiting is gone.
          yield* database.run(
            database.insert(deviceRequests).values({
              id,
              deviceId: device.id,
              personId: ada.person.id,
              sessionId: ada.sessionId,
              subscriptionId: DeviceSubscriptionId.make(NodeCrypto.randomUUID()),
              threadId,
              runId,
              action: 'Click',
              receipt: encodeReceipt(DeviceReceipt.cases.Dispatched.make({})),
              dispatchedAt: expiresAt - 30_000,
              expiresAt,
            }),
          )
          return id
        })
        const expired = yield* abandoned(60_000)
        // Still inside its deadline: it may belong to a server that is alive, so it is left alone.
        const live = yield* abandoned(120_000)
        yield* TestClock.adjust('60 seconds')
        const statuses = Effect.fn('DeviceTest.statuses')(function* () {
          const rows = yield* database.run(
            database.select().from(deviceRequests).where(eq(deviceRequests.deviceId, device.id)),
          )
          return new Map(rows.map((row) => [row.id, row.status]))
        })
        yield* Effect.gen(function* () {
          yield* DeviceRegistry
          expect(yield* statuses()).toEqual(
            new Map([
              [expired, 'OutcomeUnknown'],
              [live, 'Dispatched'],
            ]),
          )
        }).pipe((program) => scopedCase(Layer.fresh(deviceLayer), program, 'inherited'))
      }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )

    it.effect('a session that runs out ends presence without any write', () =>
      Effect.gen(function* () {
        const ada = yield* somebody(new Date(60_000))
        const { device, installation } = yield* enrolled(ada, 'Laptop')
        yield* computerHandlers.AllowDevice({ id: device.id }).pipe(as(ada))
        const link = yield* listen(ada, device, installation)
        expect(yield* listed(ada)).toEqual([['Laptop', 'Allowed', 'Connected']])
        yield* TestClock.adjust('60 seconds')
        const ended = yield* Fiber.await(link.ended)
        expect(failureOf(ended)).toBe('Unauthenticated')
        const registry = yield* DeviceRegistry
        expect((yield* registry.list(ada.person.id)).map((each) => each.presence._tag)).toEqual([
          'Offline',
        ])
      }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )

    /** Real time: production auth signs out and commits the notice that ends device presence. */
    it.effect('signing out ends presence', () =>
      Effect.gen(function* () {
        const database = yield* Database
        const email = `${NodeCrypto.randomUUID()}@example.test`
        yield* Effect.addFinalizer(() =>
          database.run(database.delete(personTable).where(eq(personTable.email, email))).pipe(
            Effect.asVoid,
            Effect.catch(() => Effect.sync(() => expect.fail('Device fixture cleanup failed'))),
          ),
        )
        const auth = yield* Auth
        const call = (path: string, init: RequestInit) =>
          Effect.promise(() =>
            auth.handler(new Request(`http://127.0.0.1:8787/api/auth/${path}`, init)),
          ).pipe(Effect.map(HttpServerResponse.fromWeb))
        const json = { 'content-type': 'application/json', origin: 'http://127.0.0.1:8787' }
        const signedUp = yield* call('sign-up/email', {
          method: 'POST',
          headers: json,
          body: JSON.stringify({
            email,
            name: 'Device test',
            password: 'test-Device-0123456789',
          }),
        })
        expect(signedUp.status).toBe(200)
        const cookie = Object.values(signedUp.cookies.cookies)
          .map((entry) => `${entry.name}=${entry.valueEncoded}`)
          .join('; ')
        const [row] = yield* database.run(
          database
            .select({ person: personTable, sessionId: sessionTable.id })
            .from(sessionTable)
            .innerJoin(personTable, eq(personTable.id, sessionTable.userId))
            .where(eq(personTable.email, email)),
        )
        if (row === undefined) return expect.fail('Sign-up must persist a Person and a session')
        const ada = {
          person: yield* decodeStored(Person, 'device test Person')(row.person),
          sessionId: SessionId.make(row.sessionId),
        }
        const { device, installation } = yield* enrolled(ada, 'Laptop')
        yield* computerHandlers.AllowDevice({ id: device.id }).pipe(as(ada))
        const link = yield* listen(ada, device, installation)
        const signedOut = yield* call('sign-out', {
          method: 'POST',
          headers: { ...json, cookie },
          body: '{}',
        })
        expect(signedOut.status).toBe(200)
        const ended = yield* Fiber.await(link.ended)
        expect(failureOf(ended)).toBe('Unauthenticated')
        // The Device and its access are the Person's decision and outlive the session.
        const [kept] = yield* database.run(
          database
            .select({ access: devices.access })
            .from(devices)
            .where(eq(devices.id, device.id)),
        )
        expect(kept).toEqual({ access: 'Allowed' })
        return undefined
      }).pipe(Effect.scoped, (program) => scopedCase(authenticatedLayer, program, 'inherited')),
    )
  })
})

/** Windows work crosses the same authenticated handlers and real ledger as page work. */
describe.skipIf(!testDatabaseConfigured)('Windows on the Person’s computer', () => {
  layer(testDatabaseLayer, { excludeTestServices: true })((it) => {
    it.effect('requires one Working Run before connectivity and admits only runtime callers', () =>
      Effect.gen(function* () {
        const test = yield* native()
        expect(
          (yield* computerHandlers
            .UseWindow({ action: look, summary: 'Look' })
            .pipe(as(test.who), Effect.flip))._tag,
        ).toBe('Forbidden')
        const database = yield* Database
        yield* database.run(
          database
            .update(runs)
            .set({ state: 'completed', finishedAt: 0 })
            .where(eq(runs.id, test.runId)),
        )
        expect(yield* useWindow(test.who, test.threadId, look)).toEqual(
          WindowOutcome.cases.RunRequired.make({}),
        )
        expect(yield* Queue.size(test.link.requests)).toBe(0)
      }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )

    /** An interrupted waiter must not consume a later turn or create a dispatch receipt. */
    it.effect(
      'interrupts queued window work and admits exactly one next dispatch on the same Device',
      () =>
        Effect.gen(function* () {
          const test = yield* native()
          const first = yield* useWindow(test.who, test.threadId, look).pipe(Effect.forkScoped)
          const request = yield* Queue.take(test.link.requests)
          const queuedRun = yield* working(test.who.person, test.who.person)
          const queued = yield* queuedWindow(test.who, queuedRun.threadId)
          expect(yield* Queue.size(test.link.requests)).toBe(0)
          expect((yield* windowLedger(test)).map((row) => row.runId)).toEqual([test.runId])
          yield* Fiber.interrupt(queued)
          expect(Exit.hasInterrupts(yield* Fiber.await(queued))).toBe(true)
          yield* answerWindow(test, request.id)
          expect(yield* Fiber.join(first)).toEqual(
            WindowOutcome.cases.Completed.make({ result: seen }),
          )
          const nextRun = yield* working(test.who.person, test.who.person)
          const next = yield* useWindow(test.who, nextRun.threadId, look).pipe(Effect.forkScoped)
          const nextRequest = yield* Queue.take(test.link.requests)
          expect(nextRequest.runId).toBe(nextRun.runId)
          expect(nextRequest.id).not.toBe(request.id)
          yield* answerWindow(test, nextRequest.id)
          expect(yield* Fiber.join(next)).toEqual(
            WindowOutcome.cases.Completed.make({ result: seen }),
          )
          expect(yield* Queue.size(test.link.requests)).toBe(0)
          expect(
            new Map((yield* windowLedger(test)).map((row) => [row.id, [row.runId, row.status]])),
          ).toEqual(
            new Map([
              [request.id, [test.runId, 'Did']],
              [nextRequest.id, [nextRun.runId, 'Did']],
            ]),
          )
        }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )

    /** Stop is persisted while a different Run holds this Device; admission rechecks after taking the turn. */
    it.effect('a Run stopped while queued sends no window request and creates no ledger row', () =>
      Effect.gen(function* () {
        const test = yield* native()
        const first = yield* useWindow(test.who, test.threadId, look).pipe(Effect.forkScoped)
        const request = yield* Queue.take(test.link.requests)
        const queuedRun = yield* working(test.who.person, test.who.person)
        const queued = yield* queuedWindow(test.who, queuedRun.threadId)
        yield* computerHandlers
          .ReportDeviceStop({
            device: test.device.id,
            installation: test.installation,
            runId: queuedRun.runId,
          })
          .pipe(as(test.who))
        expect(yield* Queue.take((yield* Stops).calls)).toBe(queuedRun.threadId)
        yield* answerWindow(test, request.id)
        expect(yield* Fiber.join(first)).toEqual(
          WindowOutcome.cases.Completed.make({ result: seen }),
        )
        expect(yield* Fiber.join(queued)).toEqual(WindowOutcome.cases.RunRequired.make({}))
        expect(yield* Queue.size(test.link.requests)).toBe(0)
        expect((yield* windowLedger(test)).map((row) => [row.id, row.runId, row.status])).toEqual([
          [request.id, test.runId, 'Did'],
        ])
      }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )

    /** The turn-wait deadline is shorter than the already dispatched request's budget. */
    it.effect('window work queued for ten seconds is Busy without an extra dispatch', () =>
      Effect.gen(function* () {
        const test = yield* native()
        const first = yield* useWindow(test.who, test.threadId, look).pipe(Effect.forkScoped)
        const request = yield* Queue.take(test.link.requests)
        const queuedRun = yield* working(test.who.person, test.who.person)
        const queued = yield* queuedWindow(test.who, queuedRun.threadId)
        yield* TestClock.adjust('9999 millis')
        expect(
          queued.pollUnsafe(),
          'The acknowledged wait has not reached its deadline',
        ).toBeUndefined()
        expect(yield* Queue.size(test.link.requests)).toBe(0)
        yield* TestClock.adjust('1 millis')
        expect(yield* Fiber.join(queued)).toEqual(WindowOutcome.cases.Busy.make({}))
        expect(yield* Queue.size(test.link.requests)).toBe(0)
        expect((yield* windowLedger(test)).map((row) => [row.id, row.status])).toEqual([
          [request.id, 'Dispatched'],
        ])
        yield* answerWindow(test, request.id)
        expect(yield* Fiber.join(first)).toEqual(
          WindowOutcome.cases.Completed.make({ result: seen }),
        )
      }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )

    it.effect('offline, Pending and Revoked Devices are NotConnected; capability is live', () =>
      Effect.gen(function* () {
        const who = yield* somebody(farFuture)
        const run = yield* working(who.person, who.person)
        const call = useWindow(who, run.threadId, look)
        expect(yield* call).toEqual(WindowOutcome.cases.NotConnected.make({}))
        const { device, installation } = yield* enrolled(who, 'Laptop')
        expect(yield* call).toEqual(WindowOutcome.cases.NotConnected.make({}))
        yield* computerHandlers.AllowDevice({ id: device.id }).pipe(as(who))
        expect(yield* call).toEqual(WindowOutcome.cases.NotConnected.make({}))
        const link = yield* listen(who, device, installation)
        expect(yield* call).toEqual(
          WindowOutcome.cases.Unavailable.make({
            reason: 'The Windows helper is not running on this computer.',
          }),
        )
        expect(yield* Queue.size(link.requests)).toBe(0)
        yield* computerHandlers.RevokeDevice({ id: device.id }).pipe(as(who))
        expect(yield* call).toEqual(WindowOutcome.cases.NotConnected.make({}))
      }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )

    it.effect('another Person never reaches this Device or borrows its Run', () =>
      Effect.gen(function* () {
        const test = yield* native()
        const other = yield* somebody(farFuture)
        expect(yield* useWindow(other, test.threadId, look)).toEqual(
          WindowOutcome.cases.RunRequired.make({}),
        )
        const run = yield* working(other.person, other.person)
        expect(yield* useWindow(other, run.threadId, look)).toEqual(
          WindowOutcome.cases.NotConnected.make({}),
        )
        expect(yield* Queue.size(test.link.requests)).toBe(0)
      }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )

    it.effect(
      'offers Look without Approval and keeps only action/receipt metadata for window work',
      () =>
        Effect.gen(function* () {
          const test = yield* native()
          const database = yield* Database
          const running = yield* useWindow(test.who, test.threadId, look).pipe(Effect.forkScoped)
          const request = yield* Queue.take(test.link.requests)
          expect(request.work).toEqual(DeviceWork.cases.Window.make({ action: look }))
          expect(
            yield* database.run(
              database.select().from(approvals).where(eq(approvals.personId, test.who.person.id)),
            ),
          ).toEqual([])
          // The durable ledger exists before the desktop has received any answer.
          const [before] = yield* database.run(
            database.select().from(deviceRequests).where(eq(deviceRequests.id, request.id)),
          )
          expect(before).toMatchObject({ action: 'Look', status: 'Dispatched' })
          yield* computerHandlers
            .AnswerDeviceRequest({
              device: test.device.id,
              id: request.id,
              answer: DeviceAnswer.cases.Did.make({ result: seen }),
            })
            .pipe(as(test.who))
          expect(yield* Fiber.join(running)).toEqual(
            WindowOutcome.cases.Completed.make({ result: seen }),
          )
          const typing = yield* useWindow(
            test.who,
            test.threadId,
            WindowAction.cases.Type.make({ window: windowId, text: typed }),
          ).pipe(Effect.forkScoped)
          const next = yield* Queue.take(test.link.requests)
          yield* computerHandlers
            .AnswerDeviceRequest({
              device: test.device.id,
              id: next.id,
              answer: DeviceAnswer.cases.Did.make({ result: seen }),
            })
            .pipe(as(test.who))
          yield* Fiber.join(typing)
          const rows = yield* database.run(
            database.select().from(deviceRequests).where(eq(deviceRequests.runId, test.runId)),
          )
          expect(new Map(rows.map((row) => [row.id, [row.action, row.status]]))).toEqual(
            new Map([
              [request.id, ['Look', 'Did']],
              [next.id, ['Type', 'Did']],
            ]),
          )
          const kept = JSON.stringify(rows)
          for (const content of [typed, seen.view.picture, seen.view.outline, seen.view.app])
            expect(kept).not.toContain(content)
        }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )

    for (const reason of [
      'Elevated',
      'WindowGone',
      'LookStale',
      'NotInFront',
      'Unsupported',
    ] as const) {
      it.effect(`returns the desktop refusal ${reason}`, () =>
        Effect.gen(function* () {
          const test = yield* native()
          const running = yield* useWindow(test.who, test.threadId, look).pipe(Effect.forkScoped)
          const request = yield* Queue.take(test.link.requests)
          yield* computerHandlers
            .AnswerDeviceRequest({
              device: test.device.id,
              id: request.id,
              answer: DeviceAnswer.cases.Declined.make({ reason }),
            })
            .pipe(as(test.who))
          expect(yield* Fiber.join(running)).toEqual(WindowOutcome.cases.Refused.make({ reason }))
        }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
      )
    }

    it.effect('Stopped revokes dispatch authority and aborts the Run once', () =>
      Effect.gen(function* () {
        const test = yield* native()
        const running = yield* useWindow(test.who, test.threadId, look).pipe(Effect.forkScoped)
        const request = yield* Queue.take(test.link.requests)
        yield* computerHandlers
          .AnswerDeviceRequest({
            device: test.device.id,
            id: request.id,
            answer: DeviceAnswer.cases.Declined.make({ reason: 'Stopped' }),
          })
          .pipe(as(test.who))
        expect(yield* Fiber.join(running)).toEqual(
          WindowOutcome.cases.Refused.make({ reason: 'Stopped' }),
        )
        expect(yield* Queue.take((yield* Stops).calls)).toBe(test.threadId)
        const report = {
          device: test.device.id,
          installation: test.installation,
          runId: test.runId,
        }
        yield* computerHandlers.ReportDeviceStop(report).pipe(as(test.who))
        expect(yield* Queue.size((yield* Stops).calls)).toBe(0)
        expect(yield* Queue.take(test.link.runEnds)).toBe(test.runId)
        expect(yield* Queue.size(test.link.runEnds)).toBe(0)
        expect(yield* useWindow(test.who, test.threadId, look)).toEqual(
          WindowOutcome.cases.RunRequired.make({}),
        )
      }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )

    it.effect(
      'ReportDeviceStop proves Device, installation and Run ownership and stops idempotently',
      () =>
        Effect.gen(function* () {
          const test = yield* native()
          const other = yield* somebody(farFuture)
          const report = {
            device: test.device.id,
            installation: test.installation,
            runId: test.runId,
          }
          expect(
            (yield* computerHandlers.ReportDeviceStop(report).pipe(as(other), Effect.flip))._tag,
          ).toBe('NotFound')
          expect(
            (yield* computerHandlers
              .ReportDeviceStop({
                ...report,
                installation: InstallationId.make(NodeCrypto.randomUUID()),
              })
              .pipe(as(test.who), Effect.flip))._tag,
          ).toBe('Forbidden')
          const foreign = yield* working(other.person, other.person)
          expect(
            (yield* computerHandlers
              .ReportDeviceStop({ ...report, runId: foreign.runId })
              .pipe(as(test.who), Effect.flip))._tag,
          ).toBe('NotFound')
          yield* computerHandlers.ReportDeviceStop(report).pipe(as(test.who))
          expect(yield* Queue.take((yield* Stops).calls)).toBe(test.threadId)
          yield* computerHandlers.ReportDeviceStop(report).pipe(as(test.who))
          expect(yield* Queue.size((yield* Stops).calls)).toBe(0)
          expect(yield* useWindow(test.who, test.threadId, look)).toEqual(
            WindowOutcome.cases.RunRequired.make({}),
          )
          expect(yield* Queue.size(test.link.runEnds)).toBe(0)
        }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )

    for (const ending of ['timeout', 'disconnect', 'failed', 'wrong vocabulary'] as const) {
      it.effect(`settles ${ending} without replay`, () =>
        Effect.gen(function* () {
          const test = yield* native()
          const running = yield* useWindow(test.who, test.threadId, look).pipe(Effect.forkScoped)
          const request = yield* Queue.take(test.link.requests)
          if (ending === 'timeout') yield* TestClock.adjust('30 seconds')
          if (ending === 'disconnect') yield* Fiber.interrupt(test.link.ended)
          if (ending === 'failed' || ending === 'wrong vocabulary')
            yield* computerHandlers
              .AnswerDeviceRequest({
                device: test.device.id,
                id: request.id,
                answer: ending === 'failed' ? DeviceAnswer.cases.Failed.make({}) : done,
              })
              .pipe(as(test.who))
          expect((yield* Fiber.join(running))._tag).toBe(
            ending === 'failed' ? 'Unavailable' : 'OutcomeUnknown',
          )
          expect(yield* Queue.size(test.link.requests)).toBe(0)
          const [row] = yield* (yield* Database).run(
            (yield* Database)
              .select()
              .from(deviceRequests)
              .where(eq(deviceRequests.id, request.id)),
          )
          expect(row).toMatchObject({ status: ending === 'failed' ? 'Failed' : 'OutcomeUnknown' })
        }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
      )
    }

    it.effect('window-vocabulary answers cannot complete page work', () =>
      Effect.gen(function* () {
        const test = yield* native()
        const registry = yield* DeviceRegistry
        const running = yield* registry
          .browse({
            personId: test.who.person.id,
            threadId: test.threadId,
            runId: test.runId,
            action: read,
            authority: BrowseAuthority.cases.Acting.make({}),
          })
          .pipe(Effect.forkScoped)
        const request = yield* Queue.take(test.link.requests)
        expect(request.work).toEqual(DeviceWork.cases.Page.make({ action: read }))
        yield* computerHandlers
          .AnswerDeviceRequest({
            device: test.device.id,
            id: request.id,
            answer: DeviceAnswer.cases.Did.make({ result: seen }),
          })
          .pipe(as(test.who))
        expect(yield* Fiber.join(running)).toEqual(BrowseOutcome.cases.OutcomeUnknown.make({}))
        yield* registry.ended(test.runId)
        expect(yield* Queue.size(test.link.runEnds)).toBe(0)
      }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )
  })
})
