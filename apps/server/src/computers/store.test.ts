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
  ApprovalDecision,
  BrowseOutcome,
  BrowseResult,
  DeviceAnswer,
  RunId,
  type DeviceRequest,
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
  ComputerInventory,
  Person,
  PersonId,
  ProposedAction,
  SessionId,
  ThreadId,
  Workspace,
} from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import {
  Gate,
  GateDecision,
  ActionOutcome,
  ActionOrigin,
  ActionRunner,
  gateLayer as policyGateLayer,
} from '../approvals/gate.ts'
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
import { ApprovalStore, approvalStoreLayer } from '../approvals/store.ts'
import { stores, fixture as trustFixture } from '../approvals/testing.ts'
import { approvals } from '../approvals/tables.ts'
import { StoredRunOrigin } from '../threads/conversation.ts'
import { runs, threads } from '../threads/tables.ts'
import * as Schema from 'effect/Schema'
import { deviceRequests, computers } from './tables.ts'

/** Test authority records actual seam calls and can lose machines or command receipts deliberately. */
interface EvidenceService {
  readonly commandResult: Ref.Ref<{
    readonly exitCode: number
    readonly output: string
    readonly truncated: boolean
  }>
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
      commandResult: yield* Ref.make({ exitCode: 0, output: 'hello', truncated: false }),
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
      return yield* Ref.get(evidence.commandResult)
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
/** Real approval claim and Gate over a test Device, with the Computer runner used in production. */
const browserRunnerLayer = Layer.effect(
  ActionRunner,
  Effect.gen(function* () {
    const context = yield* Effect.context<ComputerStore | DeviceRegistry>()
    return ActionRunner.of({
      run: ({ person, action, origin }) => {
        if (ActionTarget.guards.Connection(action.target))
          return Effect.succeed(
            ActionOutcome.cases.Failed.make({
              reason: 'This test executes only Computer actions.',
            }),
          )
        return computerRunner({ person, target: action.target, origin }).pipe(
          Effect.provideContext(context),
        )
      },
    })
  }),
)
const browserApprovalsLayer = Layer.fresh(approvalStoreLayer).pipe(
  Layer.provideMerge(
    Layer.mergeAll(stores, testLayer, browserRunnerLayer.pipe(Layer.provide(testLayer))),
  ),
)
const personBrowserLayer = policyGateLayer.pipe(Layer.provideMerge(browserApprovalsLayer))

/** One admitted Run and real subscribed Device; no cloud provider call is needed. */
const encodeRunOrigin = Schema.encodeSync(StoredRunOrigin)
const personalBrowser = Effect.fn('Computer.test.personalBrowser')(function* () {
  const test = yield* trustFixture()
  const registry = yield* DeviceRegistry
  const database = yield* Database
  const runId = RunId.make(NodeCrypto.randomUUID())
  yield* database.run(
    database.insert(runs).values({
      id: runId,
      threadId: test.personalId,
      personId: test.personal.person.id,
      turn: 1,
      state: 'working',
      origin: encodeRunOrigin(StoredRunOrigin.cases.Message.make({})),
      startedAt: 0,
      admittedAt: 0,
    }),
  )
  const installation = InstallationId.make(NodeCrypto.randomUUID())
  const device = yield* registry.enrol(test.personal.person.id, {
    installation,
    name: 'Personal browser',
  })
  const session = yield* watchAuth(test.personal.person)
  const requests = yield* Queue.unbounded<DeviceRequest>()
  /** Acquiring watch establishes presence before the producer can dispatch. */
  const connect = Effect.fn('Computer.test.connect')(function* () {
    yield* registry.allow(test.personal.person.id, device.id)
    const ready = yield* Deferred.make<void>()
    const fiber = yield* Effect.gen(function* () {
      const stream = yield* registry.watch({
        personId: test.personal.person.id,
        sessionId: session.sessionId,
        device: device.id,
        installation,
      })
      yield* Deferred.succeed(ready, undefined)
      yield* stream.pipe(Stream.runForEach((request) => Queue.offer(requests, request)))
    }).pipe(Effect.scoped, Effect.forkScoped)
    yield* Deferred.await(ready)
    return fiber
  })

  const actor = {
    ...test.vivid,
    origin: ActionOrigin.cases.Run.make({ threadId: test.personalId, runId }),
  }
  return { test, registry, database, runId, device, session, requests, connect, actor }
})
const signedPage = BrowseResult.make({
  address: 'https://example.test',
  title: 'Signed-in page',
  outline: 'Account',
  truncated: false,
  tabs: [],
})
const personalRead = {
  target: BrowseTarget.cases.Person.make({}),
  action: BrowserAction.cases.Read.make({}),
  summary: 'Read my page',
}

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
    'Person browsing reports access and connection failures without dispatch or cloud fallback',
    () =>
      Effect.gen(function* () {
        const browser = yield* personalBrowser()
        expect(
          yield* computerHandlers.Browse(personalRead).pipe(
            Effect.provideService(
              AuthContext,
              AuthState.Vivid({
                person: browser.actor.person,
                workspace: browser.actor.workspace,
                threadId: browser.test.personalId,
              }),
            ),
          ),
        ).toEqual(BrowseOutcome.cases.NotAllowed.make({}))
        yield* browser.registry.allow(browser.actor.person.id, browser.device.id)
        expect(
          yield* computerHandlers.Browse(personalRead).pipe(
            Effect.provideService(
              AuthContext,
              AuthState.Vivid({
                person: browser.actor.person,
                workspace: browser.actor.workspace,
                threadId: browser.test.personalId,
              }),
            ),
          ),
        ).toEqual(BrowseOutcome.cases.NotConnected.make({}))
        expect(yield* Queue.size(browser.requests)).toBe(0)
        expect(yield* Ref.get((yield* ProviderEvidence).calls)).toEqual([])
      }).pipe(Effect.scoped, Effect.provide(personBrowserLayer)),
  )

  it.effect(
    'allowed Person reads dispatch once and return Done with transient screenshot bytes',
    () =>
      Effect.gen(function* () {
        const browser = yield* personalBrowser()
        yield* browser.connect()
        const running = yield* computerHandlers
          .Browse({ ...personalRead, action: BrowserAction.cases.Screenshot.make({}) })
          .pipe(
            Effect.provideService(
              AuthContext,
              AuthState.Vivid({
                person: browser.actor.person,
                workspace: browser.actor.workspace,
                threadId: browser.test.personalId,
              }),
            ),
            Effect.forkScoped,
          )
        const dispatched = yield* Queue.take(browser.requests)
        const page = BrowseResult.make({ ...signedPage, picture: 'png-bytes' })
        yield* browser.registry.answer(browser.actor.person.id, browser.session.sessionId, {
          device: browser.device.id,
          id: dispatched.id,
          answer: DeviceAnswer.cases.Done.make({ result: page }),
        })
        expect(yield* Fiber.join(running)).toEqual(
          BrowseOutcome.cases.Completed.make({ result: page }),
        )
        expect([dispatched.threadId, dispatched.runId]).toEqual([
          browser.test.personalId,
          browser.runId,
        ])
        const [ledger] = yield* browser.database.run(
          browser.database
            .select()
            .from(deviceRequests)
            .where(eq(deviceRequests.id, dispatched.id)),
        )
        if (ledger === undefined) expect.fail('Expected durable receipt')
        expect(JSON.stringify(ledger)).not.toContain(page.outline)
        expect(JSON.stringify(ledger)).not.toContain('png-bytes')
        expect(yield* Queue.size(browser.requests)).toBe(0)
        expect(yield* Ref.get((yield* ProviderEvidence).calls)).toEqual([])
      }).pipe(Effect.scoped, Effect.provide(personBrowserLayer)),
  )

  it.effect(
    'Person writes wait for approval and dispatch exactly once from the stored proposing Run',
    () =>
      Effect.gen(function* () {
        const browser = yield* personalBrowser()
        yield* browser.connect()
        const outcome = yield* computerHandlers
          .Browse({ ...personalRead, action: BrowserAction.cases.Click.make({ target: 'Send' }) })
          .pipe(
            Effect.provideService(
              AuthContext,
              AuthState.Vivid({
                person: browser.actor.person,
                workspace: browser.actor.workspace,
                threadId: browser.test.personalId,
              }),
            ),
          )
        if (!BrowseOutcome.guards.ApprovalRequired(outcome)) expect.fail('Expected approval')
        expect(yield* Queue.size(browser.requests)).toBe(0)
        const store = yield* ApprovalStore
        const [approval] = yield* store.inThread(browser.test.personalId)
        if (approval === undefined) expect.fail('Expected stored approval')
        expect(approval.runId).toBe(browser.runId)
        expect(approval.threadId).toBe(browser.test.personalId)
        const [row] = yield* browser.database.run(
          browser.database.select().from(approvals).where(eq(approvals.id, approval.id)),
        )
        if (row === undefined) expect.fail('Expected persisted Approval')
        expect(row.runId).toBe(browser.runId)
        // The proposing turn ends before the Person decides; a newer Run cannot replace it.
        yield* browser.database.run(
          browser.database
            .update(runs)
            .set({ state: 'completed', finishedAt: 1 })
            .where(eq(runs.id, browser.runId)),
        )
        const decide = {
          id: approval.id,
          digest: approval.digest,
          decision: ApprovalDecision.cases.AllowOnce.make({}),
        }
        const executing = yield* store.decide(browser.test.personal, decide).pipe(Effect.forkScoped)
        const dispatched = yield* Queue.take(browser.requests)
        expect(dispatched.runId).toBe(browser.runId)
        yield* browser.registry.answer(browser.actor.person.id, browser.session.sessionId, {
          device: browser.device.id,
          id: dispatched.id,
          answer: DeviceAnswer.cases.Done.make({ result: signedPage }),
        })
        expect((yield* Fiber.join(executing)).state._tag).toBe('Succeeded')
        expect((yield* store.decide(browser.test.personal, decide).pipe(Effect.flip))._tag).toBe(
          'Conflict',
        )
        expect(yield* Queue.size(browser.requests)).toBe(0)
      }).pipe(Effect.scoped, Effect.provide(personBrowserLayer)),
  )

  for (const reason of ['Stopped', 'PageGone', 'NotAllowed', 'Unsupported'] as const) {
    it.effect(`Device refusal ${reason} remains a distinct model outcome`, () =>
      Effect.gen(function* () {
        const browser = yield* personalBrowser()
        yield* browser.connect()
        const running = yield* computerHandlers.Browse(personalRead).pipe(
          Effect.provideService(
            AuthContext,
            AuthState.Vivid({
              person: browser.actor.person,
              workspace: browser.actor.workspace,
              threadId: browser.test.personalId,
            }),
          ),
          Effect.forkScoped,
        )
        const dispatched = yield* Queue.take(browser.requests)
        yield* browser.registry.answer(browser.actor.person.id, browser.session.sessionId, {
          device: browser.device.id,
          id: dispatched.id,
          answer: DeviceAnswer.cases.Refused.make({ reason }),
        })
        expect(yield* Fiber.join(running)).toEqual(BrowseOutcome.cases[reason].make({}))
        expect(yield* Queue.size(browser.requests)).toBe(0)
      }).pipe(Effect.scoped, Effect.provide(personBrowserLayer)),
    )
  }

  it.effect('a stopped proposing Run returns OutcomeUnknown without dispatch', () =>
    Effect.gen(function* () {
      const browser = yield* personalBrowser()
      yield* browser.connect()
      yield* browser.database.run(
        browser.database
          .update(runs)
          .set({ state: 'stopped', finishedAt: 1 })
          .where(eq(runs.id, browser.runId)),
      )
      expect(
        yield* browser.registry.browse({
          personId: browser.actor.person.id,
          threadId: browser.test.personalId,
          runId: browser.runId,
          action: personalRead.action,
        }),
      ).toEqual(BrowseOutcome.cases.OutcomeUnknown.make({}))
      expect(yield* Queue.size(browser.requests)).toBe(0)
    }).pipe(Effect.scoped, Effect.provide(personBrowserLayer)),
  )

  it.effect('a link dropping mid-action returns OutcomeUnknown and never replays', () =>
    Effect.gen(function* () {
      const browser = yield* personalBrowser()
      const link = yield* browser.connect()
      const running = yield* computerHandlers.Browse(personalRead).pipe(
        Effect.provideService(
          AuthContext,
          AuthState.Vivid({
            person: browser.actor.person,
            workspace: browser.actor.workspace,
            threadId: browser.test.personalId,
          }),
        ),
        Effect.forkScoped,
      )
      const dispatched = yield* Queue.take(browser.requests)
      yield* Fiber.interrupt(link)
      expect(yield* Fiber.join(running)).toEqual(BrowseOutcome.cases.OutcomeUnknown.make({}))
      yield* browser.connect()
      expect(yield* Queue.size(browser.requests)).toBe(0)
      const [receipt] = yield* browser.database.run(
        browser.database.select().from(deviceRequests).where(eq(deviceRequests.id, dispatched.id)),
      )
      if (receipt === undefined) expect.fail('Expected persisted receipt')
      expect(receipt.status).toBe('OutcomeUnknown')
    }).pipe(Effect.scoped, Effect.provide(personBrowserLayer)),
  )

  it.effect('approved non-Run Person actions fail explicitly without dispatch', () =>
    Effect.gen(function* () {
      const browser = yield* personalBrowser()
      yield* browser.connect()
      const approval = yield* (yield* ApprovalStore).raise(
        browser.test.vivid,
        ProposedAction.make({
          summary: 'Click Send',
          rationale: '',
          effect: 'write',
          target: ActionTarget.cases.Browser.make({
            action: BrowserAction.cases.Click.make({ target: 'Send' }),
            target: BrowseTarget.cases.Person.make({}),
          }),
        }),
      )
      const settled = yield* (yield* ApprovalStore).decide(browser.test.personal, {
        id: approval.id,
        digest: approval.digest,
        decision: ApprovalDecision.cases.AllowOnce.make({}),
      })
      expect(settled.state._tag).toBe('Failed')
      expect(yield* Queue.size(browser.requests)).toBe(0)
    }).pipe(Effect.scoped, Effect.provide(personBrowserLayer)),
  )

  it.effect(
    'a cloud screenshot uses the existing desktop PNG and returns an outline under one permit',
    () =>
      Effect.gen(function* () {
        const { first } = yield* fixture()
        const result = yield* (yield* ComputerStore).browse(
          first.id,
          BrowserAction.cases.Screenshot.make({}),
        )
        expect(result.picture).toBe('test-picture')
        expect(result.outline).toBeDefined()
        expect(yield* Ref.get((yield* ProviderEvidence).calls)).toHaveLength(2)
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  )

  it.effect(
    'another Thread member cannot approve the Person’s computer or consume the pending Approval',
    () =>
      Effect.gen(function* () {
        const browser = yield* personalBrowser()
        const database = yield* Database
        const store = yield* ApprovalStore
        const origin = ActionOrigin.cases.Thread.make({ threadId: browser.test.companyId })
        const approval = yield* store.raise(
          { ...browser.test.companyVivid, origin },
          ProposedAction.make({
            summary: 'Click Send',
            rationale: '',
            effect: 'write',
            target: ActionTarget.cases.Browser.make({
              action: BrowserAction.cases.Click.make({ target: 'Send' }),
              target: BrowseTarget.cases.Person.make({}),
            }),
          }),
        )
        yield* database.run(
          database
            .update(threads)
            .set({ audience: 'company' })
            .where(eq(threads.id, browser.test.companyId)),
        )
        const result = yield* store
          .decide(browser.test.owner, {
            id: approval.id,
            digest: approval.digest,
            decision: ApprovalDecision.cases.AllowOnce.make({}),
          })
          .pipe(Effect.flip)
        expect(result._tag).toBe('InvalidRequest')
        const [pending] = yield* store.inThread(browser.test.companyId)
        if (pending === undefined) expect.fail('Expected pending Approval')
        expect(pending.state._tag).toBe('Pending')
      }).pipe(Effect.scoped, Effect.provide(personBrowserLayer)),
  )

  it.effect(
    'inventory never starts an absent Computer and reports only a successful real probe',
    () =>
      Effect.gen(function* () {
        const { first } = yield* fixture()
        const evidence = yield* ProviderEvidence
        const absent = yield* computerHandlers.GetComputerApps().pipe(asPerson(first))
        expect(ComputerInventory.guards.Unavailable(absent)).toBe(true)
        expect(yield* Ref.get(evidence.ensures)).toEqual([])
        yield* start(first)
        const installed = ComputerInventory.cases.Installed.make({
          apps: [{ name: 'GIMP', purpose: 'Edit raster images' }],
        })
        yield* Ref.set(evidence.commandResult, {
          exitCode: 0,
          output: JSON.stringify(installed),
          truncated: false,
        })
        expect(yield* computerHandlers.GetComputerApps().pipe(asVivid(first))).toEqual(installed)
        yield* (yield* ComputerStore).hold(first.id, true)
        expect(
          ComputerInventory.guards.Unavailable(
            yield* computerHandlers.GetComputerApps().pipe(asPerson(first)),
          ),
        ).toBe(true)
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  )

  it.effect(
    'inventory does not renew the idle deadline and a passive probe cannot wake a stopped Computer',
    () =>
      Effect.gen(function* () {
        const { first } = yield* fixture()
        const evidence = yield* ProviderEvidence
        yield* start(first)
        yield* TestClock.adjust('19 minutes')
        yield* Ref.set(evidence.commandResult, {
          exitCode: 0,
          output: '{"_tag":"Installed","apps":[]}',
          truncated: false,
        })
        yield* computerHandlers.GetComputerApps().pipe(asPerson(first))
        yield* TestClock.adjust('1 minute')
        expect(yield* Queue.take(evidence.stopped)).toBe(computerMachineKey(first.id))
        const store = yield* ComputerStore
        const stopped = yield* store
          .probe(first.id, { command: 'true', timeoutSeconds: 10 })
          .pipe(Effect.result)
        expect(Result.isFailure(stopped)).toBe(true)
        expect(yield* Ref.get(evidence.ensures)).toHaveLength(1)
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  )

  for (const receipt of [
    { exitCode: 1, output: 'missing catalogue', truncated: false },
    { exitCode: 0, output: '{"_tag":"Installed","apps":[{"name":"GIMP"}]}', truncated: false },
    { exitCode: 0, output: '{"_tag":"Installed","apps":[]}', truncated: true },
  ]) {
    it.effect(`inventory withholds names for an unverified probe: ${receipt.output}`, () =>
      Effect.gen(function* () {
        const { first } = yield* fixture()
        yield* start(first)
        const evidence = yield* ProviderEvidence
        yield* Ref.set(evidence.commandResult, receipt)
        expect(
          ComputerInventory.guards.Unavailable(
            yield* computerHandlers.GetComputerApps().pipe(asPerson(first)),
          ),
        ).toBe(true)
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    )
  }

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
            origin: ActionOrigin.cases.Person.make({}),
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
    'the Person’s computer is never replaced by Vivid’s Computer and a non-Run proposal cannot dispatch',
    () =>
      Effect.gen(function* () {
        const { first } = yield* fixture()
        const evidence = yield* ProviderEvidence
        const personRequest = {
          target: BrowseTarget.cases.Person.make({}),
          action: BrowserAction.cases.Read.make({}),
          summary: 'Read my browser',
        }
        expect((yield* computerHandlers.Browse(personRequest).pipe(asVivid(first)))._tag).toBe(
          'NotConnected',
        )
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
        expect(response._tag).toBe('RunRequired')
        expect(yield* Ref.get(evidence.calls)).toEqual([])
        expect(yield* Ref.get(evidence.actions)).toEqual([])
        expect(
          yield* computerRunner({
            origin: ActionOrigin.cases.Person.make({}),
            person: first,
            target: ActionTarget.cases.Browser.make({
              action: personRequest.action,
              target: personRequest.target,
            }),
          }),
        ).toEqual(
          ActionOutcome.cases.Failed.make({
            reason: 'The Person’s computer requires the Run that proposed this action.',
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
            origin: ActionOrigin.cases.Person.make({}),
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
