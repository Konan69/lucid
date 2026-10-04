import * as NodeCrypto from 'node:crypto'
import { describe, expect, it } from '@effect/vitest'
import { eq } from 'drizzle-orm'
import {
  Context,
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
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest'
import {
  BrowserAction,
  BrowseOutcome,
  BrowseResult,
  DeviceAnswer,
  DeviceRequestId,
  InstallationId,
  Person,
  PersonId,
  RunId,
  SessionId,
  ThreadId,
  Workspace,
  type Device,
  type DeviceRequest,
} from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { authEffect, localAuthRuntimeLayer } from '../auth/provider.ts'
import { personTable, sessionTable } from '../auth/tables.ts'
import { Database, decodeStored } from '../database/client.ts'
import { testConfigLayer, testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { Changes, changesLayer } from '../live/changes.ts'
import { StoredRunOrigin } from '../threads/conversation.ts'
import { runs, threads } from '../threads/tables.ts'
import { DeviceRegistry, deviceLayer } from './device.ts'
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
        const subscription = yield* changes.subscribe(topics)
        yield* Queue.offer(watching, undefined)
        return subscription
      }),
    })
    return Layer.mergeAll(Layer.succeed(Bus, { watching }), Layer.succeed(Changes, observed))
  }),
).pipe(Layer.provide(changesLayer))

const testLayer = deviceLayer.pipe(
  Layer.provideMerge(busLayer),
  Layer.provideMerge(testDatabaseLayer),
  Layer.provideMerge(testConfigLayer),
)

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
const listen = Effect.fn('DeviceTest.listen')(function* (
  who: Somebody,
  device: Device,
  installation: InstallationId,
) {
  const bus = yield* Bus
  const requests = yield* Queue.unbounded<DeviceRequest>()
  const ended = yield* computerHandlers
    .WatchDeviceRequests({ device: device.id, installation })
    .pipe(
      Stream.runForEach((request) => Queue.offer(requests, request)),
      as(who),
      Effect.forkScoped,
    )
  yield* Queue.take(bus.watching)
  return { requests, ended }
})

const listed = (who: Somebody) =>
  computerHandlers.ListDevices().pipe(
    as(who),
    Effect.map(({ devices: all }) =>
      all.map((device) => [device.name, device.access._tag, device.presence._tag]),
    ),
  )

const read = BrowserAction.cases.Read.make({})

/** Why a dispatch was refused for want of a Run, or the tag of whatever else refused it. */
const reasonOf = (failure: Effect.Error<ReturnType<DeviceRegistry['Service']['browse']>>) =>
  Predicate.isTagged(failure, 'NoActingRun') ? failure.reason : failure._tag

/** The tag a link's stream failed with, or `ended` when it simply finished. */
const failureOf = <E extends { readonly _tag: string }>(exit: Exit.Exit<void, E>) =>
  Option.match(Exit.findErrorOption(exit), {
    onNone: () => 'ended',
    onSome: (failure) => failure._tag,
  })

/** Real PostgreSQL holds the Devices, Runs and ledger; the desktop app is the handlers' caller. */
describe.skipIf(!testDatabaseConfigured)('A Person’s own computer', () => {
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
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  )

  it.effect('only the enrolled installation of an allowed Device may listen', () =>
    Effect.gen(function* () {
      const ada = yield* somebody(farFuture)
      const tola = yield* somebody(farFuture)
      const { device, installation } = yield* enrolled(ada, 'Ada’s laptop')
      const refused = (who: Somebody, presented: InstallationId) =>
        computerHandlers.WatchDeviceRequests({ device: device.id, installation: presented }).pipe(
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
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
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
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
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
        .WatchDeviceRequests({ device: device.id, installation })
        .pipe(Stream.runDrain, as(ada), Effect.flip)
      expect(again._tag).toBe('Forbidden')
      const registry = yield* DeviceRegistry
      expect((yield* registry.requireConnected(ada.person.id).pipe(Effect.flip))._tag).toBe(
        'NoDeviceConnected',
      )
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
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
            action: BrowserAction.cases.Type.make({ target: 'Password', text: typed }),
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
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
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
        .browse({ personId: ada.person.id, threadId: shared.threadId, action: read })
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
            .browse({ personId: ada.person.id, threadId: idle.threadId, action: read })
            .pipe(Effect.flip),
        ),
      ).toBe('NoWorkingRun')
      // Two working Runs: which one asked cannot be told, so neither is picked.
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
      expect(
        reasonOf(
          yield* registry
            .browse({ personId: ada.person.id, threadId: busy.threadId, action: read })
            .pipe(Effect.flip),
        ),
      ).toBe('SeveralWorkingRuns')
      expect(yield* Queue.size(link.requests)).toBe(0)
      expect(
        yield* database.run(
          database.select().from(deviceRequests).where(eq(deviceRequests.deviceId, device.id)),
        ),
      ).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
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
        const { threadId } = yield* working(who.person, who.person)
        const running = yield* registry
          .browse({ personId: who.person.id, threadId, action: read })
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
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  )

  it.effect('a passed deadline is recorded as unknown and a late answer changes nothing', () =>
    Effect.gen(function* () {
      const ada = yield* somebody(farFuture)
      const { device, installation } = yield* enrolled(ada, 'Laptop')
      yield* computerHandlers.AllowDevice({ id: device.id }).pipe(as(ada))
      const link = yield* listen(ada, device, installation)
      const { threadId } = yield* working(ada.person, ada.person)
      const running = yield* (yield* DeviceRegistry)
        .browse({ personId: ada.person.id, threadId, action: read })
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
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
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
      }).pipe(Effect.provide(Layer.fresh(deviceLayer)))
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
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
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  )

  /** Real time: production auth signs out and commits the notice that ends device presence. */
  it.live('signing out ends presence', () =>
    Effect.gen(function* () {
      const database = yield* Database
      const email = `${NodeCrypto.randomUUID()}@example.test`
      yield* Effect.addFinalizer(() =>
        database.run(database.delete(personTable).where(eq(personTable.email, email))).pipe(
          Effect.asVoid,
          Effect.catch(() => Effect.sync(() => expect.fail('Device fixture cleanup failed'))),
        ),
      )
      const auth = yield* authEffect
      const call = (path: string, init: RequestInit) =>
        auth.fetch.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(new Request(`http://127.0.0.1:8787/api/auth/${path}`, init)),
          ),
          Effect.provide(localAuthRuntimeLayer),
        )
      const json = { 'content-type': 'application/json', origin: 'http://127.0.0.1:8787' }
      const signedUp = yield* call('sign-up/email', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ email, name: 'Device test', password: 'test-Device-0123456789' }),
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
        database.select({ access: devices.access }).from(devices).where(eq(devices.id, device.id)),
      )
      expect(kept).toEqual({ access: 'Allowed' })
      return undefined
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  )
})
