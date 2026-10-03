import * as NodeCrypto from 'node:crypto'
import { describe, expect, it } from '@effect/vitest'
import { eq, inArray } from 'drizzle-orm'
import {
  Clock,
  Context,
  Deferred,
  Effect,
  Layer,
  Option,
  PubSub,
  Ref,
  Result,
  Redacted,
  Queue,
  Fiber,
  Stream,
} from 'effect'
import {
  ActionTarget,
  CommandOutcome,
  Company,
  CompanyId,
  Approval,
  ApprovalId,
  ApprovalState,
  BrowserAction,
  BrowseTarget,
  InstallationId,
  DesktopAction,
  DesktopOutcome,
  ComputerState,
  Person,
  PersonId,
  ProposedAction,
  SessionId,
  ThreadId,
  Workspace,
} from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { Gate, GateDecision, ActionOutcome } from '../approvals/gate.ts'
import { personTable, sessionTable } from '../auth/tables.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { Changes, Topic, silentChangesLayer } from '../live/changes.ts'
import {
  Machine,
  MachineExecutionUnknown,
  MachineNotRunning,
  MachineOperationFailed,
  unavailableMachineLayer,
  type MachineKey,
} from './machine.ts'
import { computerHandlers, computerRunner } from './handlers.ts'
import {
  ComputerStore,
  computerStoreLayer,
  computerMachineKey,
  computerScreenAddress,
} from './store.ts'
import * as TestClock from 'effect/testing/TestClock'
import { DeviceRegistry, deviceLayer } from './device.ts'
import { computers } from './tables.ts'

/** Test authority records actual seam calls and can lose machines or command receipts deliberately. */
interface EvidenceService {
  readonly states: Ref.Ref<ReadonlyMap<MachineKey, ComputerState>>
  readonly started: Queue.Queue<MachineKey>
  readonly stopped: Queue.Queue<MachineKey>
  readonly ensures: Ref.Ref<ReadonlyArray<MachineKey>>
  readonly calls: Ref.Ref<ReadonlyArray<MachineKey>>
  readonly decisions: Ref.Ref<GateDecision>
  readonly actions: Ref.Ref<ReadonlyArray<ProposedAction>>
  readonly viewerReads: Ref.Ref<number>
  readonly lost: Ref.Ref<boolean>
  readonly boot: Ref.Ref<Option.Option<Deferred.Deferred<void>>>
  readonly executionGate: Ref.Ref<Option.Option<Deferred.Deferred<void>>>
  readonly executing: Queue.Queue<MachineKey>
  readonly bootFailed: Ref.Ref<boolean>
  readonly beforeGateReturn: Ref.Ref<Effect.Effect<void>>
}
class ProviderEvidence extends Context.Service<ProviderEvidence, EvidenceService>()(
  'vivid/ComputerTestEvidence',
) {}

const evidenceLayer = Layer.effect(
  ProviderEvidence,
  Effect.gen(function* () {
    return ProviderEvidence.of({
      started: yield* Queue.unbounded<MachineKey>(),
      stopped: yield* Queue.unbounded<MachineKey>(),
      ensures: yield* Ref.make<ReadonlyArray<MachineKey>>([]),
      states: yield* Ref.make<ReadonlyMap<MachineKey, ComputerState>>(new Map()),
      calls: yield* Ref.make<ReadonlyArray<MachineKey>>([]),
      decisions: yield* Ref.make<GateDecision>(GateDecision.cases.Allowed.make({})),
      actions: yield* Ref.make<ReadonlyArray<ProposedAction>>([]),
      viewerReads: yield* Ref.make(0),
      lost: yield* Ref.make(false),
      executing: yield* Queue.unbounded<MachineKey>(),
      executionGate: yield* Ref.make<Option.Option<Deferred.Deferred<void>>>(Option.none()),
      bootFailed: yield* Ref.make(false),
      beforeGateReturn: yield* Ref.make(Effect.void),
      boot: yield* Ref.make<Option.Option<Deferred.Deferred<void>>>(Option.none()),
    })
  }),
)

/** This provider Layer is the test dependency; the persisted Computer service and handlers are real. */
const providerLayer = Layer.effect(
  Machine,
  Effect.gen(function* () {
    const evidence = yield* ProviderEvidence
    const inspect = Effect.fn('Computer.test.inspect')(function* (key: MachineKey) {
      const states = yield* Ref.get(evidence.states)
      const state = states.get(key)
      return state === undefined ? ComputerState.cases.Absent.make({}) : state
    })
    const status = Effect.fn('Computer.test.status')(function* (key: MachineKey) {
      yield* Ref.update(evidence.viewerReads, (count) => count + 1)
      return yield* inspect(key)
    })
    const ensure = Effect.fn('Computer.test.ensure')(function* (key: MachineKey) {
      yield* Ref.update(evidence.ensures, (calls) => [...calls, key])
      yield* Queue.offer(evidence.started, key)
      const wait = yield* Ref.get(evidence.boot)
      if (Option.isSome(wait)) yield* Deferred.await(wait.value)
      if (yield* Ref.get(evidence.bootFailed))
        return yield* Effect.fail(new MachineOperationFailed({ operation: 'startup' }))
      const state = ComputerState.cases.Running.make({
        since: 100,
        screen: ComputerState.cases.Running.fields.screen.cases.Relay.make({
          address: computerScreenAddress,
        }),
      })
      yield* Ref.update(evidence.states, (states) => new Map(states).set(key, state))
      return state
    })
    const stop = Effect.fn('Computer.test.stop')(function* (key: MachineKey) {
      yield* Queue.offer(evidence.stopped, key)
      yield* Ref.update(evidence.states, (states) =>
        new Map(states).set(key, ComputerState.cases.Stopped.make({ since: 200 })),
      )
    })
    const exec = Effect.fn('Computer.test.exec')(function* ({
      key,
    }: Parameters<typeof Machine.Service.exec>[0]) {
      yield* Ref.update(evidence.calls, (calls) => [...calls, key])
      yield* Queue.offer(evidence.executing, key)
      const wait = yield* Ref.get(evidence.executionGate)
      if (Option.isSome(wait)) yield* Deferred.await(wait.value)
      if (yield* Ref.get(evidence.lost))
        return yield* Effect.fail(new MachineExecutionUnknown({ key }))
      return { exitCode: 0, output: 'hello', truncated: false }
    })
    const browse = Effect.fn('Computer.test.browse')(function* ({
      key,
    }: Parameters<typeof Machine.Service.browse>[0]) {
      yield* Ref.update(evidence.calls, (calls) => [...calls, key])
      if (yield* Ref.get(evidence.lost))
        return yield* Effect.fail(new MachineExecutionUnknown({ key }))
      return {
        address: 'https://example.com',
        title: 'Example',
        outline: 'Example outline',
        truncated: false,
        tabs: [{ title: 'Example', address: 'https://example.com', showing: true }],
      }
    })
    const screen = Effect.fn('Computer.test.screen')(function* (key: MachineKey) {
      const state = yield* inspect(key)
      if (!ComputerState.guards.Running(state))
        return yield* Effect.fail(new MachineNotRunning({ key }))
      return {
        address: 'ws://127.0.0.1:62001/websockify',
        authorization: Redacted.make('test-only-screen-authority'),
      }
    })
    const desktop = Effect.fn('Computer.test.desktop')(function* ({
      key,
    }: Parameters<typeof Machine.Service.desktop>[0]) {
      yield* Ref.update(evidence.calls, (calls) => [...calls, key])
      if (yield* Ref.get(evidence.lost))
        return yield* Effect.fail(new MachineExecutionUnknown({ key }))
      return {
        picture: 'test-picture',
        width: 1920,
        height: 1080,
        pointer: { x: 1, y: 2 },
        window: 'Example',
      }
    })
    return Machine.of({ status, inspect, ensure, stop, exec, browse, screen, desktop })
  }),
).pipe(Layer.provide(evidenceLayer))

/** A subscribed change receipt, rather than polling or sleeping, waits for the startup worker's commit. */
const changesLayer = Layer.effect(
  Changes,
  Effect.gen(function* () {
    const hub = yield* PubSub.unbounded<ReadonlyArray<Topic>>()
    return Changes.of({
      publish: Effect.fn('Computer.test.publish')((topics) =>
        PubSub.publish(hub, topics).pipe(Effect.asVoid),
      ),
      subscribe: Effect.fn('Computer.test.subscribe')(function* (topics) {
        const subscription = yield* PubSub.subscribe(hub)
        return Stream.fromSubscription(subscription).pipe(
          Stream.filter((moved) => moved.some((topic) => topics.includes(topic))),
          Stream.map(() => undefined),
        )
      }),
    })
  }),
)

const gateLayer = Layer.effect(
  Gate,
  Effect.gen(function* () {
    const evidence = yield* ProviderEvidence
    return Gate.of({
      check: Effect.fn('Computer.test.gate')(function* (_actor, action, exposure) {
        expect(exposure).toBe('Ordinary')
        yield* Ref.update(evidence.actions, (actions) => [...actions, action])
        yield* yield* Ref.get(evidence.beforeGateReturn)
        return yield* Ref.get(evidence.decisions)
      }),
    })
  }),
).pipe(Layer.provide(evidenceLayer))

const dependencies = Layer.mergeAll(
  testDatabaseLayer,
  evidenceLayer,
  providerLayer,
  changesLayer,
  gateLayer,
)
const testLayer = computerStoreLayer.pipe(
  Layer.provideMerge(deviceLayer),
  Layer.provideMerge(dependencies),
)
const request = { command: 'echo hello', summary: 'Read a greeting', timeoutSeconds: 10 }

/** A pending stored command is the same permission receipt for a cold or running Computer. */
const pendingApproval = (person: Person) => {
  const action = ProposedAction.make({
    summary: request.summary,
    rationale: '',
    effect: 'write',
    target: ActionTarget.cases.Command.make({ command: request.command }),
  })
  return Approval.make({
    id: ApprovalId.make(NodeCrypto.randomUUID()),
    threadId: ThreadId.make(NodeCrypto.randomUUID()),
    runId: null,
    action,
    digest: 'stored-action',
    askedOf: {
      id: person.id,
      name: person.name,
      image: Option.getOrNull(Option.fromNullishOr(person.image)),
    },
    state: ApprovalState.cases.Pending.make({ expiresAt: 1000 }),
    createdAt: 0,
  })
}
/** Cleanup is registered before the first insert; the two identities never touch application data. */
const fixture = Effect.fn('Computer.test.fixture')(function* () {
  const database = yield* Database
  const people = [1, 2].map(() => {
    const id = PersonId.make(NodeCrypto.randomUUID())
    return Person.make({ id, name: 'Computer test', email: `${id}@example.test`, image: null })
  })
  yield* Effect.addFinalizer(() =>
    database
      .run(
        database.delete(personTable).where(
          inArray(
            personTable.id,
            people.map((person) => person.id),
          ),
        ),
      )
      .pipe(
        Effect.asVoid,
        Effect.catch(() => Effect.sync(() => expect.fail('Computer test cleanup failed.'))),
      ),
  )
  yield* database.run(database.insert(personTable).values(people))
  const first = people[0]
  const second = people[1]
  if (first === undefined || second === undefined)
    expect.fail('Two Computer test Persons are required.')
  return { first, second }
})

/** Live queries revalidate persisted sessions; the fixture's Person cleanup cascades this row even if watching fails. */
const watchAuth = Effect.fn('Computer.test.watchAuth')(function* (person: Person) {
  const database = yield* Database
  const sessionId = SessionId.make(NodeCrypto.randomUUID())
  const now = yield* Clock.currentTimeMillis
  yield* database.run(
    database.insert(sessionTable).values({
      id: sessionId,
      userId: person.id,
      token: NodeCrypto.randomUUID(),
      expiresAt: new Date(now + 60_000),
    }),
  )
  return AuthState.Person({ person, sessionId, workspace: Workspace.cases.Personal.make({}) })
})

/** Transport identity is explicit, so a caller cannot inject another Person through a tool payload. */
const asPerson = (person: Person) =>
  Effect.provideService(
    AuthContext,
    AuthState.Person({
      person,
      sessionId: SessionId.make(NodeCrypto.randomUUID()),
      workspace: Workspace.cases.Personal.make({}),
    }),
  )
const asVivid = (person: Person) =>
  Effect.provideService(
    AuthContext,
    AuthState.Vivid({
      person,
      threadId: ThreadId.make(NodeCrypto.randomUUID()),
      workspace: Workspace.cases.Personal.make({}),
    }),
  )

/** Subscribe before starting; the running commit wakes the test even if it finishes before the stream is consumed. */
const start = Effect.fn('Computer.test.start')(function* (person: Person) {
  const changes = yield* Changes
  const store = yield* ComputerStore
  const moved = yield* changes.subscribe([Topic.person(person.id)])
  const receipt = yield* computerHandlers.StartComputer().pipe(asPerson(person))
  expect(receipt.computer.state._tag).toBe('Starting')
  const ready = yield* Stream.concat(Stream.make(undefined), moved).pipe(
    Stream.mapEffect(() => store.get(person.id)),
    Stream.filter((computer) => ComputerState.guards.Running(computer.state)),
    Stream.runHead,
  )
  expect(Option.isSome(ready)).toBe(true)
})

describe.skipIf(!testDatabaseConfigured)('Computer ownership and trust', () => {
  it.effect(
    'wakes once for concurrent permitted actions, waits for startup and resumes the same Computer',
    () =>
      Effect.gen(function* () {
        const { first } = yield* fixture()
        const store = yield* ComputerStore
        const evidence = yield* ProviderEvidence
        const boot = yield* Deferred.make<void>()
        yield* Ref.set(evidence.boot, Option.some(boot))
        const command = yield* store.exec(first.id, request).pipe(Effect.forkScoped)
        expect(yield* Queue.take(evidence.started)).toBe(computerMachineKey(first.id))
        const browser = yield* store
          .browse(first.id, BrowserAction.cases.Read.make({}))
          .pipe(Effect.forkScoped)
        expect(yield* Ref.get(evidence.calls)).toEqual([])
        expect((yield* store.get(first.id)).state._tag).toBe('Starting')
        yield* Deferred.succeed(boot, undefined)
        expect((yield* Fiber.join(command)).output).toBe('hello')
        expect((yield* Fiber.join(browser)).title).toBe('Example')
        const id = (yield* store.get(first.id)).id
        expect(yield* Ref.get(evidence.ensures)).toEqual([computerMachineKey(first.id)])
        yield* store.stop(first.id)
        yield* store.desktop(first.id, DesktopAction.cases.Look.make({}))
        expect((yield* store.get(first.id)).id).toBe(id)
        expect(yield* Ref.get(evidence.ensures)).toEqual([
          computerMachineKey(first.id),
          computerMachineKey(first.id),
        ])
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  )

  it.effect('bounds wake readiness at 90 seconds and never retries a failed start', () =>
    Effect.gen(function* () {
      const { first } = yield* fixture()
      const store = yield* ComputerStore
      const evidence = yield* ProviderEvidence
      const boot = yield* Deferred.make<void>()
      yield* Ref.set(evidence.boot, Option.some(boot))
      const action = yield* store.exec(first.id, request).pipe(Effect.result, Effect.forkScoped)
      yield* Queue.take(evidence.started)
      yield* TestClock.adjust('90 seconds')
      const result = yield* Fiber.join(action)
      expect(result._tag).toBe('Failure')
      if (Result.isFailure(result)) expect(result.failure._tag).toBe('ComputerWakeTimedOut')
      const changes = yield* Changes
      const moved = yield* changes.subscribe([Topic.person(first.id)])
      yield* Stream.concat(Stream.make(undefined), moved).pipe(
        Stream.mapEffect(() => store.get(first.id)),
        Stream.filter((computer) => ComputerState.guards.Failed(computer.state)),
        Stream.runHead,
      )
      expect((yield* store.exec(first.id, request).pipe(Effect.flip))._tag).toBe(
        'ComputerStartFailed',
      )
      expect(yield* Ref.get(evidence.ensures)).toHaveLength(1)
      expect(yield* Ref.get(evidence.calls)).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  )

  it.effect('keeps failed starts and keyboard takeover distinct without retrying either', () =>
    Effect.gen(function* () {
      const { first } = yield* fixture()
      const store = yield* ComputerStore
      const evidence = yield* ProviderEvidence
      yield* Ref.set(evidence.bootFailed, true)
      expect(
        (yield* store.browse(first.id, BrowserAction.cases.Read.make({})).pipe(Effect.flip))._tag,
      ).toBe('ComputerStartFailed')
      expect(
        (yield* store.desktop(first.id, DesktopAction.cases.Look.make({})).pipe(Effect.flip))._tag,
      ).toBe('ComputerStartFailed')
      expect(yield* Ref.get(evidence.ensures)).toHaveLength(1)
      yield* Ref.set(evidence.bootFailed, false)
      yield* start(first)
      yield* store.hold(first.id, true)
      expect((yield* store.exec(first.id, request).pipe(Effect.flip))._tag).toBe('ComputerHeld')
      expect(yield* Ref.get(evidence.calls)).toEqual([])
      expect(yield* Ref.get(evidence.ensures)).toHaveLength(2)
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  )

  it.effect('blocked actions leave an absent Computer asleep', () =>
    Effect.gen(function* () {
      const { first } = yield* fixture()
      const evidence = yield* ProviderEvidence
      yield* Ref.set(evidence.decisions, GateDecision.cases.Blocked.make({ rule: 'Never' }))
      expect((yield* computerHandlers.RunCommand(request).pipe(asVivid(first)))._tag).toBe(
        'Blocked',
      )
      expect(
        (yield* computerHandlers
          .Browse({
            target: BrowseTarget.cases.Vivid.make({}),
            action: BrowserAction.cases.Read.make({}),
            summary: 'Read',
          })
          .pipe(asVivid(first)))._tag,
      ).toBe('Blocked')
      expect(
        (yield* computerHandlers
          .UseDesktop({ action: DesktopAction.cases.Look.make({}), summary: 'Look' })
          .pipe(asVivid(first)))._tag,
      ).toBe('Blocked')
      expect((yield* (yield* ComputerStore).get(first.id)).state._tag).toBe('Absent')
      yield* Ref.set(
        evidence.decisions,
        GateDecision.cases.ApprovalRequired.make({ approval: pendingApproval(first) }),
      )
      expect((yield* computerHandlers.RunCommand(request).pipe(asVivid(first)))._tag).toBe(
        'ApprovalRequired',
      )
      expect((yield* (yield* ComputerStore).get(first.id)).state._tag).toBe('Absent')
      expect(yield* Ref.get(evidence.ensures)).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  )

  it.effect(
    'activity replaces the owned idle deadline, then stops after twenty quiet minutes',
    () =>
      Effect.gen(function* () {
        const { first } = yield* fixture()
        const store = yield* ComputerStore
        const evidence = yield* ProviderEvidence
        yield* store.exec(first.id, request)
        yield* TestClock.adjust('19 minutes')
        yield* store.browse(first.id, BrowserAction.cases.Read.make({}))
        yield* TestClock.adjust('19 minutes')
        expect((yield* store.get(first.id)).state._tag).toBe('Running')
        expect(yield* Queue.size(evidence.stopped)).toBe(0)
        yield* TestClock.adjust('1 minute')
        expect(yield* Queue.take(evidence.stopped)).toBe(computerMachineKey(first.id))
        expect((yield* store.get(first.id)).state._tag).toBe('Stopped')
        yield* TestClock.adjust('20 minutes')
        expect(yield* Queue.size(evidence.stopped)).toBe(0)
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  )

  it.effect(
    'watching and keyboard ownership suppress idle stop until the last watcher leaves',
    () =>
      Effect.gen(function* () {
        const { first } = yield* fixture()
        const store = yield* ComputerStore
        const evidence = yield* ProviderEvidence
        yield* store.exec(first.id, request)
        const opened = yield* Deferred.make<void>()
        const closed = yield* Deferred.make<void>()
        const watcher = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* store.watching(first.id)
            yield* Deferred.succeed(opened, undefined)
            yield* Deferred.await(closed)
          }),
        ).pipe(Effect.forkScoped)
        yield* Deferred.await(opened)
        yield* TestClock.adjust('40 minutes')
        expect((yield* store.get(first.id)).state._tag).toBe('Running')
        expect(yield* Queue.size(evidence.stopped)).toBe(0)
        yield* store.hold(first.id, true)
        yield* Deferred.succeed(closed, undefined)
        yield* Fiber.join(watcher)
        yield* TestClock.adjust('40 minutes')
        expect((yield* store.get(first.id)).state._tag).toBe('Running')
        yield* store.hold(first.id, false)
        yield* TestClock.adjust('20 minutes')
        expect(yield* Queue.take(evidence.stopped)).toBe(computerMachineKey(first.id))
        expect((yield* store.get(first.id)).state._tag).toBe('Stopped')
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  )

  it.effect('restores an idle deadline from stored activity when the server layer restarts', () =>
    Effect.gen(function* () {
      const { first } = yield* fixture()
      const evidence = yield* ProviderEvidence
      const id = yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* ComputerStore
          yield* store.exec(first.id, request)
          return (yield* store.get(first.id)).id
        }).pipe(Effect.provide(computerStoreLayer)),
      )
      yield* TestClock.adjust('19 minutes')
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* ComputerStore
          expect((yield* store.get(first.id)).id).toBe(id)
          expect((yield* store.get(first.id)).state._tag).toBe('Running')
          yield* TestClock.adjust('1 minute')
          expect(yield* Queue.take(evidence.stopped)).toBe(computerMachineKey(first.id))
          expect((yield* store.get(first.id)).state._tag).toBe('Stopped')
        }).pipe(Effect.provide(computerStoreLayer)),
      )
      expect(yield* Ref.get(evidence.ensures)).toHaveLength(1)
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
  )

  it.effect(
    'an executing command suppresses idle stop and completion starts a fresh deadline',
    () =>
      Effect.gen(function* () {
        const { first } = yield* fixture()
        const store = yield* ComputerStore
        const evidence = yield* ProviderEvidence
        yield* store.exec(first.id, request)
        yield* Queue.take(evidence.executing)
        yield* TestClock.adjust('19 minutes')
        const gate = yield* Deferred.make<void>()
        yield* Ref.set(evidence.executionGate, Option.some(gate))
        const action = yield* store.exec(first.id, request).pipe(Effect.forkScoped)
        yield* Queue.take(evidence.executing)
        yield* TestClock.adjust('40 minutes')
        expect((yield* store.get(first.id)).state._tag).toBe('Running')
        expect(yield* Queue.size(evidence.stopped)).toBe(0)
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(action)
        yield* TestClock.adjust('20 minutes')
        expect(yield* Queue.take(evidence.stopped)).toBe(computerMachineKey(first.id))
        expect((yield* store.get(first.id)).state._tag).toBe('Stopped')
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  )

  it.effect('the last of two watching subscriptions starts the idle deadline', () =>
    Effect.gen(function* () {
      const { first } = yield* fixture()
      const store = yield* ComputerStore
      const evidence = yield* ProviderEvidence
      yield* store.exec(first.id, request)
      const opened = yield* Queue.unbounded<void>()
      const closeFirst = yield* Deferred.make<void>()
      const closeSecond = yield* Deferred.make<void>()
      const watch = Effect.fn('Computer.test.watch')(function* (close: Deferred.Deferred<void>) {
        yield* store.watching(first.id)
        yield* Queue.offer(opened, undefined)
        yield* Deferred.await(close)
      }, Effect.scoped)
      const firstWatch = yield* watch(closeFirst).pipe(Effect.forkScoped)
      const secondWatch = yield* watch(closeSecond).pipe(Effect.forkScoped)
      yield* Queue.take(opened)
      yield* Queue.take(opened)
      yield* Deferred.succeed(closeFirst, undefined)
      yield* Fiber.join(firstWatch)
      yield* TestClock.adjust('40 minutes')
      expect(yield* Queue.size(evidence.stopped)).toBe(0)
      yield* Deferred.succeed(closeSecond, undefined)
      yield* Fiber.join(secondWatch)
      yield* TestClock.adjust('20 minutes')
      expect(yield* Queue.take(evidence.stopped)).toBe(computerMachineKey(first.id))
      expect((yield* store.get(first.id)).state._tag).toBe('Stopped')
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  )

  it.effect(
    'waits for a persisted Starting Computer through the same provider readiness receipt',
    () =>
      Effect.gen(function* () {
        const { first } = yield* fixture()
        const database = yield* Database
        const evidence = yield* ProviderEvidence
        const key = computerMachineKey(first.id)
        yield* database.run(
          database.insert(computers).values({
            id: NodeCrypto.randomUUID(),
            personId: first.id,
            machine: key,
            status: 'starting',
            since: 0,
            lastActivityAt: 0,
            held: false,
            reason: null,
            createdAt: 0,
          }),
        )
        yield* Ref.update(evidence.states, (states) =>
          new Map(states).set(key, ComputerState.cases.Starting.make({ since: 0 })),
        )
        const gate = yield* Deferred.make<void>()
        yield* Ref.set(evidence.boot, Option.some(gate))
        const action = yield* (yield* ComputerStore).exec(first.id, request).pipe(Effect.forkScoped)
        expect(yield* Queue.take(evidence.started)).toBe(key)
        expect(yield* Ref.get(evidence.calls)).toEqual([])
        yield* Deferred.succeed(gate, undefined)
        expect((yield* Fiber.join(action)).output).toBe('hello')
        expect(yield* Ref.get(evidence.ensures)).toEqual([key])
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  )

  it.effect(
    'isolates Person calls and Vivid actions, refuses held Computers, and reconciles a lost machine',
    () =>
      Effect.gen(function* () {
        const { first, second } = yield* fixture()
        const store = yield* ComputerStore
        const evidence = yield* ProviderEvidence
        yield* start(first)
        const own = yield* computerHandlers.GetComputer().pipe(asPerson(first))
        const authenticated = yield* watchAuth(first)
        const watched = yield* computerHandlers
          .WatchComputer()
          .pipe(Stream.runHead, Effect.provideService(AuthContext, authenticated))
        expect(Option.isSome(watched)).toBe(true)
        if (Option.isSome(watched)) expect(watched.value.computer.id).toBe(own.computer.id)
        const company = Company.make({
          id: CompanyId.make(NodeCrypto.randomUUID()),
          name: 'Computer test Company',
          slug: 'computer-test',
        })
        const companyRead = yield* computerHandlers.GetComputer().pipe(
          Effect.provideService(
            AuthContext,
            AuthState.Person({
              person: first,
              sessionId: SessionId.make(NodeCrypto.randomUUID()),
              workspace: Workspace.cases.Company.make({ company, role: 'member' }),
            }),
          ),
        )
        expect(companyRead.computer.id).toBe(own.computer.id)
        expect(own.computer.state).toEqual(
          ComputerState.cases.Running.make({
            since: 100,
            screen: ComputerState.cases.Running.fields.screen.cases.Relay.make({
              address: computerScreenAddress,
            }),
          }),
        )
        expect(
          (yield* computerHandlers.GetComputer().pipe(asPerson(second))).computer.state._tag,
        ).toBe('Absent')
        expect(
          (yield* computerHandlers.HoldComputer({ held: true }).pipe(asPerson(second))).computer
            .state._tag,
        ).toBe('Absent')
        expect((yield* store.screen(second.id))._tag).toBe('None')
        expect((yield* computerHandlers.RunCommand(request).pipe(asVivid(second)))._tag).toBe(
          'Completed',
        )
        expect(yield* Ref.get(evidence.calls)).toEqual([computerMachineKey(second.id)])
        yield* computerHandlers.HoldComputer({ held: true }).pipe(asPerson(first))
        expect(yield* computerHandlers.RunCommand(request).pipe(asVivid(first))).toEqual(
          CommandOutcome.cases.Unavailable.make({ reason: 'the Person is using the Computer' }),
        )
        expect(
          yield* computerRunner({
            person: first,
            target: ActionTarget.cases.Command.make({ command: request.command }),
          }),
        ).toEqual(ActionOutcome.cases.Failed.make({ reason: 'the Person is using the Computer' }))
        yield* computerHandlers.HoldComputer({ held: false }).pipe(asPerson(first))
        expect((yield* computerHandlers.RunCommand(request).pipe(asVivid(first)))._tag).toBe(
          'Completed',
        )
        expect(yield* Ref.get(evidence.calls)).toEqual([
          computerMachineKey(second.id),
          computerMachineKey(first.id),
        ])
        expect((yield* store.get(first.id)).id).toBe(own.computer.id)
        yield* Ref.update(evidence.states, (states) => {
          const lost = new Map(states)
          lost.delete(computerMachineKey(first.id))
          return lost
        })
        expect((yield* store.get(first.id)).state._tag).toBe('Stopped')
        const database = yield* Database
        const persisted = yield* database.run(
          database.select().from(computers).where(eq(computers.personId, first.id)),
        )
        expect(persisted.map((row) => row.status)).toEqual(['stopped'])
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    15000,
  )

  it.effect(
    'the Person’s computer is never replaced by Vivid’s Computer and nothing is sent to it yet',
    () =>
      Effect.gen(function* () {
        const { first } = yield* fixture()
        const evidence = yield* ProviderEvidence
        const personRequest = {
          target: BrowseTarget.cases.Person.make({}),
          action: BrowserAction.cases.Read.make({}),
          summary: 'Read my browser',
        }
        expect(
          (yield* computerHandlers.Browse(personRequest).pipe(asVivid(first), Effect.flip))._tag,
        ).toBe('NoDeviceConnected')
        // An allowed computer that is listening: acquiring the stream is what establishes presence.
        const registry = yield* DeviceRegistry
        const installation = InstallationId.make(NodeCrypto.randomUUID())
        const device = yield* registry.enrol(first.id, { installation, name: 'Test computer' })
        yield* registry.allow(first.id, device.id)
        yield* registry.watch({
          personId: first.id,
          sessionId: SessionId.make(NodeCrypto.randomUUID()),
          device: device.id,
          installation,
        })
        const response = yield* computerHandlers.Browse(personRequest).pipe(asVivid(first))
        expect(response._tag).toBe('Unavailable')
        expect(yield* Ref.get(evidence.calls)).toEqual([])
        expect(yield* Ref.get(evidence.actions)).toEqual([])
        expect(
          yield* computerRunner({
            person: first,
            target: ActionTarget.cases.Browser.make({
              action: personRequest.action,
              target: personRequest.target,
            }),
          }),
        ).toEqual(
          ActionOutcome.cases.Failed.make({
            reason: 'The Person’s computer cannot be used for browsing yet.',
          }),
        )
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  )

  it.effect(
    'Blocked and ApprovalRequired never execute; browser policy and lost receipts remain honest',
    () =>
      Effect.gen(function* () {
        const { first } = yield* fixture()
        const evidence = yield* ProviderEvidence
        yield* start(first)
        yield* Ref.set(
          evidence.decisions,
          GateDecision.cases.Blocked.make({ rule: 'Never change this Computer' }),
        )
        expect((yield* computerHandlers.RunCommand(request).pipe(asVivid(first)))._tag).toBe(
          'Blocked',
        )
        expect(
          (yield* computerHandlers
            .Browse({
              target: BrowseTarget.cases.Vivid.make({}),
              action: BrowserAction.cases.Read.make({}),
              summary: 'Read the page',
            })
            .pipe(asVivid(first)))._tag,
        ).toBe('Blocked')
        const approval = pendingApproval(first)
        yield* Ref.set(evidence.decisions, GateDecision.cases.ApprovalRequired.make({ approval }))
        expect((yield* computerHandlers.RunCommand(request).pipe(asVivid(first)))._tag).toBe(
          'ApprovalRequired',
        )
        expect(
          (yield* computerHandlers
            .Browse({
              target: BrowseTarget.cases.Vivid.make({}),
              action: BrowserAction.cases.Click.make({ target: 'e1' }),
              summary: 'Click the page',
            })
            .pipe(asVivid(first)))._tag,
        ).toBe('ApprovalRequired')
        expect(yield* Ref.get(evidence.calls)).toHaveLength(0)
        expect((yield* Ref.get(evidence.actions)).map((proposed) => proposed.effect)).toEqual([
          'write',
          'read',
          'write',
          'write',
        ])
        yield* Ref.set(evidence.decisions, GateDecision.cases.Allowed.make({}))
        yield* Ref.set(evidence.lost, true)
        expect(
          (yield* computerRunner({
            person: first,
            target: ActionTarget.cases.Command.make({ command: request.command }),
          }))._tag,
        ).toBe('Unknown')
        expect((yield* computerHandlers.RunCommand(request).pipe(asVivid(first)))._tag).toBe(
          'OutcomeUnknown',
        )
        expect(
          (yield* computerHandlers.RunCommand(request).pipe(asPerson(first), Effect.flip))._tag,
        ).toBe('Forbidden')
        expect(
          (yield* computerHandlers.StartComputer().pipe(asVivid(first), Effect.flip))._tag,
        ).toBe('Forbidden')
        expect(
          (yield* computerHandlers.HoldComputer({ held: false }).pipe(asVivid(first), Effect.flip))
            ._tag,
        ).toBe('Forbidden')
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    15000,
  )

  it.effect(
    'desktop policy classifies observational steps as read, gates mutations, and rechecks takeover',
    () =>
      Effect.gen(function* () {
        const { first } = yield* fixture()
        const store = yield* ComputerStore
        const evidence = yield* ProviderEvidence
        yield* start(first)
        const actions = [
          DesktopAction.cases.Look.make({}),
          DesktopAction.cases.Move.make({ to: { x: 1, y: 2 } }),
          DesktopAction.cases.Scroll.make({ at: { x: 1, y: 2 }, direction: 'down', notches: 1 }),
          DesktopAction.cases.Wait.make({ seconds: 1 }),
          DesktopAction.cases.Click.make({ at: { x: 1, y: 2 }, button: 'left', times: 1 }),
          DesktopAction.cases.Drag.make({ from: { x: 1, y: 2 }, to: { x: 3, y: 4 } }),
          DesktopAction.cases.Type.make({ text: 'Private text' }),
          DesktopAction.cases.Press.make({ keys: 'Return' }),
        ]
        for (const action of actions) {
          const result = yield* computerHandlers
            .UseDesktop({ action, summary: 'Desktop fixture' })
            .pipe(asVivid(first))
          expect(DesktopOutcome.guards.Completed(result)).toBe(true)
        }
        expect((yield* Ref.get(evidence.actions)).map((action) => action.effect)).toEqual([
          'read',
          'read',
          'read',
          'read',
          'write',
          'write',
          'write',
          'write',
        ])
        const count = (yield* Ref.get(evidence.calls)).length
        yield* Ref.set(evidence.decisions, GateDecision.cases.Blocked.make({ rule: 'Never' }))
        expect(
          DesktopOutcome.guards.Blocked(
            yield* computerHandlers
              .UseDesktop({
                action: DesktopAction.cases.Click.make({
                  at: { x: 1, y: 2 },
                  button: 'left',
                  times: 1,
                }),
                summary: 'Click fixture',
              })
              .pipe(asVivid(first)),
          ),
        ).toBe(true)
        yield* Ref.set(evidence.decisions, GateDecision.cases.Allowed.make({}))
        yield* Ref.set(
          evidence.beforeGateReturn,
          store.hold(first.id, true).pipe(
            Effect.asVoid,
            Effect.catch(() => Effect.sync(() => expect.fail('Takeover fixture failed'))),
          ),
        )
        expect(
          yield* computerHandlers
            .UseDesktop({ action: DesktopAction.cases.Look.make({}), summary: 'Look fixture' })
            .pipe(asVivid(first)),
        ).toEqual(
          DesktopOutcome.cases.Unavailable.make({ reason: 'the Person is using the Computer' }),
        )
        expect((yield* Ref.get(evidence.calls)).length).toBe(count)
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    15000,
  )

  it.effect('Vivid readiness and permitted actions never request Person viewer authority', () =>
    Effect.gen(function* () {
      const { first } = yield* fixture()
      const store = yield* ComputerStore
      const evidence = yield* ProviderEvidence
      expect((yield* computerHandlers.RunCommand(request).pipe(asVivid(first)))._tag).toBe(
        'Completed',
      )
      expect(yield* Ref.get(evidence.viewerReads)).toBe(0)
      expect(
        (yield* computerHandlers.GetComputer().pipe(asPerson(first))).computer.state._tag,
      ).toBe('Running')
      const before = yield* Ref.get(evidence.viewerReads)
      yield* store.access(first.id)
      yield* computerHandlers.RunCommand(request).pipe(asVivid(first))
      yield* computerHandlers
        .Browse({
          target: BrowseTarget.cases.Vivid.make({}),
          action: BrowserAction.cases.Read.make({}),
          summary: 'Read',
        })
        .pipe(asVivid(first))
      yield* computerHandlers
        .UseDesktop({ action: DesktopAction.cases.Look.make({}), summary: 'Look' })
        .pipe(asVivid(first))
      expect(yield* Ref.get(evidence.viewerReads)).toBe(before)
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  )

  it.effect('public Computer outcomes distinguish lost dispatch receipts from refused calls', () =>
    Effect.gen(function* () {
      const { first } = yield* fixture()
      yield* start(first)
      const evidence = yield* ProviderEvidence
      yield* Ref.set(evidence.lost, true)
      const outcomes = [
        yield* computerHandlers.RunCommand(request).pipe(asVivid(first)),
        yield* computerHandlers
          .Browse({
            target: BrowseTarget.cases.Vivid.make({}),
            action: BrowserAction.cases.Read.make({}),
            summary: 'Read page',
          })
          .pipe(asVivid(first)),
        yield* computerHandlers
          .UseDesktop({ action: DesktopAction.cases.Look.make({}), summary: 'Look' })
          .pipe(asVivid(first)),
      ]
      expect(outcomes.map((outcome) => outcome._tag)).toEqual([
        'OutcomeUnknown',
        'OutcomeUnknown',
        'OutcomeUnknown',
      ])
      expect(yield* Ref.get(evidence.calls)).toHaveLength(3)
      yield* (yield* ComputerStore).hold(first.id, true)
      expect((yield* computerHandlers.RunCommand(request).pipe(asVivid(first)))._tag).toBe(
        'Unavailable',
      )
      expect(yield* Ref.get(evidence.calls)).toHaveLength(3)
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  )

  it.effect(
    'taking the keyboard returns before an in-flight action and refuses the next action',
    () =>
      Effect.gen(function* () {
        const { first } = yield* fixture()
        const store = yield* ComputerStore
        const evidence = yield* ProviderEvidence
        yield* start(first)
        const finish = yield* Deferred.make<void>()
        yield* Ref.set(evidence.executionGate, Option.some(finish))
        const command = yield* store.exec(first.id, request).pipe(Effect.forkScoped)
        yield* Queue.take(evidence.executing)
        expect(
          (yield* computerHandlers.HoldComputer({ held: true }).pipe(asPerson(first))).computer
            .heldByPerson,
        ).toBe(true)
        expect((yield* store.get(first.id)).heldByPerson).toBe(true)
        yield* Deferred.succeed(finish, undefined)
        expect((yield* Fiber.join(command)).output).toBe('hello')
        expect((yield* computerHandlers.RunCommand(request).pipe(asVivid(first)))._tag).toBe(
          'Unavailable',
        )
        expect(yield* Ref.get(evidence.calls)).toHaveLength(1)
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  )

  it.effect('a running state learned by a status read always arms its idle deadline', () =>
    Effect.gen(function* () {
      const { first } = yield* fixture()
      const store = yield* ComputerStore
      const evidence = yield* ProviderEvidence
      const key = computerMachineKey(first.id)
      yield* Ref.set(evidence.bootFailed, true)
      yield* store.exec(first.id, request).pipe(Effect.flip)
      yield* Ref.update(evidence.states, (states) =>
        new Map(states).set(
          key,
          ComputerState.cases.Running.make({
            since: 100,
            screen: ComputerState.cases.Running.fields.screen.cases.Relay.make({
              address: computerScreenAddress,
            }),
          }),
        ),
      )
      expect((yield* store.get(first.id)).state._tag).toBe('Running')
      yield* TestClock.adjust('20 minutes')
      expect(yield* Queue.take(evidence.stopped)).toBe(key)
      expect((yield* store.get(first.id)).state._tag).toBe('Stopped')
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  )

  it.effect(
    'returns starting immediately, publishes failed startup, and preserves its truthful reason',
    () =>
      Effect.gen(function* () {
        const { first } = yield* fixture()
        const store = yield* ComputerStore
        const evidence = yield* ProviderEvidence
        const changes = yield* Changes
        const latch = yield* Deferred.make<void>()
        yield* Ref.set(evidence.boot, Option.some(latch))
        const moved = yield* changes.subscribe([Topic.person(first.id)])
        expect(
          (yield* computerHandlers.StartComputer().pipe(asPerson(first))).computer.state._tag,
        ).toBe('Starting')
        expect((yield* store.access(first.id))._tag).toBe('Unavailable')
        expect(
          (yield* computerHandlers.StartComputer().pipe(asPerson(first))).computer.state._tag,
        ).toBe('Starting')
        yield* Ref.set(evidence.bootFailed, true)
        yield* Deferred.succeed(latch, undefined)
        const database = yield* Database
        const failed = yield* moved.pipe(
          Stream.mapEffect(() =>
            database.run(database.select().from(computers).where(eq(computers.personId, first.id))),
          ),
          Stream.filter((rows) => rows.some((row) => row.status === 'failed')),
          Stream.runHead,
        )
        expect(Option.isSome(failed)).toBe(true)
        if (Option.isSome(failed))
          expect(failed.value.map((row) => row.reason)).toEqual([
            'The Computer provider could not finish the operation.',
          ])
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    15000,
  )
  it.effect(
    'reports an unset provider before any row exists and never fabricates or changes machine state',
    () =>
      Effect.gen(function* () {
        const { first } = yield* fixture()
        const database = yield* Database
        const store = yield* ComputerStore
        expect(
          (yield* computerHandlers.GetComputer().pipe(asPerson(first))).computer.state._tag,
        ).toBe('Unavailable')
        expect(
          (yield* computerHandlers.StartComputer().pipe(asPerson(first))).computer.state._tag,
        ).toBe('Unavailable')
        expect(
          yield* database.run(
            database.select().from(computers).where(eq(computers.personId, first.id)),
          ),
        ).toHaveLength(0)
        yield* database.run(
          database.insert(computers).values({
            id: NodeCrypto.randomUUID(),
            personId: first.id,
            machine: computerMachineKey(first.id),
            status: 'running',
            since: 100,
            reason: null,
            held: false,
            createdAt: 100,
          }),
        )
        expect((yield* store.exec(first.id, request).pipe(Effect.flip))._tag).toBe(
          'ComputerProviderUnavailable',
        )
        expect((yield* store.stop(first.id)).state._tag).toBe('Unavailable')
        const persisted = yield* database.run(
          database.select().from(computers).where(eq(computers.personId, first.id)),
        )
        expect(persisted.map((row) => row.status)).toEqual(['running'])
      }).pipe(
        Effect.scoped,
        Effect.provide(
          computerStoreLayer.pipe(
            Layer.provideMerge(
              Layer.mergeAll(testDatabaseLayer, unavailableMachineLayer, silentChangesLayer),
            ),
          ),
        ),
      ),
    15000,
  )
  it.effect(
    'stops a starting Computer by canceling its scoped worker, with no late resurrection',
    () =>
      Effect.gen(function* () {
        const { first } = yield* fixture()
        const evidence = yield* ProviderEvidence
        const latch = yield* Deferred.make<void>()
        yield* Ref.set(evidence.boot, Option.some(latch))
        expect(
          (yield* computerHandlers.StartComputer().pipe(asPerson(first))).computer.state._tag,
        ).toBe('Starting')
        expect(
          (yield* computerHandlers.StopComputer().pipe(asPerson(first))).computer.state._tag,
        ).toBe('Stopped')
        yield* Deferred.succeed(latch, undefined)
        const store = yield* ComputerStore
        expect((yield* store.get(first.id)).state._tag).toBe('Stopped')
        const physical = Option.fromUndefinedOr(
          (yield* Ref.get(evidence.states)).get(computerMachineKey(first.id)),
        )
        expect(
          Option.match(physical, { onNone: () => false, onSome: ComputerState.guards.Running }),
        ).toBe(false)
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    15000,
  )
})
