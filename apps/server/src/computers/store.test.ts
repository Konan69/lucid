import { unbound } from '../approvals/action.ts'
import { scopedCase } from '../../tests/case.ts'
import { Runtime } from '../runtime/client.ts'
import { ChildRuns } from '../runs/store.ts'
import * as NodeCrypto from 'node:crypto'
import { describe, expect, layer } from '@effect/vitest'
import { eq, inArray } from 'drizzle-orm'
import {
  Clock,
  Cause,
  Exit,
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
  Predicate,
} from 'effect'
import {
  ActionTarget,
  ApprovalDecision,
  BrowseOutcome,
  BrowseResult,
  BrowserPicture,
  DeviceAnswer,
  RunId,
  DeviceRequest,
  ComputerShellOutcome,
  Company,
  CompanyId,
  Approval,
  ApprovalBinding,
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
import { Changes, Topic, everyPart } from '../live/changes.ts'
import {
  Machine,
  MachineExecutionUnknown,
  MachineNotRunning,
  MachineOperationFailed,
  MachineOutgrown,
  MachineRequestRejected,
  MachineUnreachable,
  type MachineKey,
} from './machine.ts'
import { computerHandlers, computerRunner } from './handlers.ts'
import {
  ComputerAccess,
  ComputerStore,
  computerStoreLayer,
  computerShell,
  computerBrowse,
  computerDesktop,
  computerMachineKey,
  computerScreenAddress,
} from './store.ts'
import * as TestClock from 'effect/testing/TestClock'
import { BrowseAuthority, DeviceRegistry, deviceLayer } from './device.ts'
import { ApprovalStore, approvalStoreLayer } from '../approvals/store.ts'
import { stores, fixture as trustFixture } from '../approvals/testing.ts'
import { approvals } from '../approvals/tables.ts'
import { StoredRunOrigin } from '../threads/conversation.ts'
import { runs, threads } from '../threads/tables.ts'
import { handoffs } from '../inputs/tables.ts'
import { Definition } from '../inputs/handoff.ts'
import * as Schema from 'effect/Schema'
import { deviceRequests, computers } from './tables.ts'
import { incidentsLayer } from '../observability/incidents.ts'

/** The store as the server composes it: its Incidents go to the real recorder. */
const computerStores = computerStoreLayer.pipe(Layer.provide(incidentsLayer))
/** Test authority records actual seam calls and can lose machines or command receipts deliberately. */
interface EvidenceService {
  readonly commandResult: Ref.Ref<{
    readonly exitCode: number
    readonly output: string
    readonly truncated: boolean
  }>
  /** A case may observe durable state at publication, after lifecycle timer rearming. */
  readonly onPublish: Ref.Ref<Effect.Effect<void>>
  readonly states: Ref.Ref<ReadonlyMap<MachineKey, ComputerState>>
  readonly started: Queue.Queue<MachineKey>
  /** Provider completion distinguishes cancellation from a late successful start. */
  readonly bootExited: Queue.Queue<{ readonly key: MachineKey; readonly interrupted: boolean }>
  readonly stopped: Queue.Queue<MachineKey>
  /** Every stop the store asked for, including one the provider could not answer. */
  readonly stopAttempts: Queue.Queue<MachineKey>
  readonly ensures: Ref.Ref<ReadonlyArray<MachineKey>>
  readonly calls: Ref.Ref<ReadonlyArray<MachineKey>>
  readonly decisions: Ref.Ref<GateDecision>
  readonly actions: Ref.Ref<ReadonlyArray<ProposedAction>>
  readonly viewerReads: Ref.Ref<number>
  /** While true the provider refuses to issue a screen for a machine that runs. */
  readonly screenRefused: Ref.Ref<boolean>
  readonly lost: Ref.Ref<boolean>
  readonly boot: Ref.Ref<Option.Option<Deferred.Deferred<void>>>
  readonly executionGate: Ref.Ref<Option.Option<Deferred.Deferred<void>>>
  readonly executing: Queue.Queue<MachineKey>
  readonly bootFailed: Ref.Ref<boolean>
  /** While true a start is refused because the Computer holds more than any machine may. */
  readonly bootOutgrown: Ref.Ref<boolean>
  /** While true the provider cannot be asked anything: every call fails as an outage. */
  readonly outage: Ref.Ref<boolean>
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
      bootExited: yield* Queue.unbounded<{
        readonly key: MachineKey
        readonly interrupted: boolean
      }>(),
      stopped: yield* Queue.unbounded<MachineKey>(),
      stopAttempts: yield* Queue.unbounded<MachineKey>(),
      ensures: yield* Ref.make<ReadonlyArray<MachineKey>>([]),
      onPublish: yield* Ref.make(Effect.void),
      states: yield* Ref.make<ReadonlyMap<MachineKey, ComputerState>>(new Map()),
      calls: yield* Ref.make<ReadonlyArray<MachineKey>>([]),
      decisions: yield* Ref.make<GateDecision>(GateDecision.cases.Allowed.make({ basis: 'Read' })),
      actions: yield* Ref.make<ReadonlyArray<ProposedAction>>([]),
      viewerReads: yield* Ref.make(0),
      screenRefused: yield* Ref.make(false),
      lost: yield* Ref.make(false),
      executing: yield* Queue.unbounded<MachineKey>(),
      executionGate: yield* Ref.make<Option.Option<Deferred.Deferred<void>>>(Option.none()),
      bootFailed: yield* Ref.make(false),
      bootOutgrown: yield* Ref.make(false),
      outage: yield* Ref.make(false),
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
    const answering = Effect.fn('Computer.test.answering')(function* () {
      if (yield* Ref.get(evidence.outage)) return yield* new MachineUnreachable()
      return undefined
    })
    const inspect = Effect.fn('Computer.test.inspect')(function* (key: MachineKey) {
      yield* answering()
      const states = yield* Ref.get(evidence.states)
      const state = states.get(key)
      return state === undefined ? ComputerState.cases.Absent.make({}) : state
    })
    const status = Effect.fn('Computer.test.status')(function* (key: MachineKey) {
      yield* Ref.update(evidence.viewerReads, (count) => count + 1)
      const state = yield* inspect(key)
      if (ComputerState.guards.Running(state) && (yield* Ref.get(evidence.screenRefused)))
        return yield* new MachineRequestRejected({ status: 409 })
      return state
    })
    const ensure = Effect.fn('Computer.test.ensure')(
      function* (key: MachineKey) {
        yield* Ref.update(evidence.ensures, (calls) => [...calls, key])
        yield* answering()
        yield* Queue.offer(evidence.started, key)
        const wait = yield* Ref.get(evidence.boot)
        if (Option.isSome(wait)) yield* Deferred.await(wait.value)
        if (yield* Ref.get(evidence.bootOutgrown))
          return yield* new MachineOutgrown({ upgrade: true })
        if (yield* Ref.get(evidence.bootFailed))
          return yield* new MachineOperationFailed({ operation: 'startup' })
        const state = ComputerState.cases.Running.make({
          since: 100,
          screen: ComputerState.cases.Running.fields.screen.cases.Relay.make({
            address: computerScreenAddress,
          }),
        })
        yield* Ref.update(evidence.states, (states) => new Map(states).set(key, state))
        return state
      },
      (program, key) =>
        program.pipe(
          Effect.onExit((exit) =>
            Queue.offer(evidence.bootExited, {
              key,
              interrupted: Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause),
            }),
          ),
        ),
    )
    const stop = Effect.fn('Computer.test.stop')(function* (key: MachineKey) {
      yield* Queue.offer(evidence.stopAttempts, key)
      yield* answering()
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
      if (yield* Ref.get(evidence.lost)) return yield* new MachineExecutionUnknown({ key })
      return yield* Ref.get(evidence.commandResult)
    })
    /** The shell reaches the machine through the same recorded call, wait and lost receipt as `exec`. */
    const run = Effect.fn('Computer.test.run')(function* ({
      key,
    }: Parameters<typeof Machine.Service.run>[0]) {
      const { output, exitCode, truncated } = yield* exec({ key, command: '', timeoutSeconds: 1 })
      return { stdout: output, stderr: '', exitCode, timedOut: false, truncated }
    })
    const browse = Effect.fn('Computer.test.browse')(function* ({
      key,
    }: Parameters<typeof Machine.Service.browse>[0]) {
      yield* Ref.update(evidence.calls, (calls) => [...calls, key])
      if (yield* Ref.get(evidence.lost)) return yield* new MachineExecutionUnknown({ key })
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
      if (!ComputerState.guards.Running(state)) return yield* new MachineNotRunning({ key })
      return {
        address: 'ws://127.0.0.1:62001/websockify',
        authorization: Redacted.make('test-only-screen-authority'),
      }
    })
    const desktop = Effect.fn('Computer.test.desktop')(function* ({
      key,
    }: Parameters<typeof Machine.Service.desktop>[0]) {
      yield* Ref.update(evidence.calls, (calls) => [...calls, key])
      if (yield* Ref.get(evidence.lost)) return yield* new MachineExecutionUnknown({ key })
      return {
        picture:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9f8AAAAASUVORK5CYII=',
        width: 1920,
        height: 1080,
        pointer: { x: 1, y: 2 },
        window: 'Example',
      }
    })
    // No test here follows a command or writes a file; a program's use of both has its own tests.
    const follow = () => Stream.fail(new MachineOperationFailed({ operation: 'follow' }))
    const write = Effect.fn('Test.Machine.write')(() =>
      Effect.fail(new MachineOperationFailed({ operation: 'write' })),
    )
    // Nor does any use the machine's own shell and files; `shell.test.ts` runs those for real.
    const unused = (operation: string) =>
      Effect.fn(`Test.Machine.${operation}`)(() =>
        Effect.fail(new MachineOperationFailed({ operation })),
      )
    return Machine.of({
      health: unused('health'),
      recover: unused('recover'),
      copySignIn: unused('copySignIn'),
      status,
      inspect,
      ensure,
      stop,
      exec,
      follow,
      write,
      run,
      converse: unused('converse'),
      tunnel: unused('tunnel'),
      read: unused('read'),
      put: unused('put'),
      browse,
      screen,
      desktop,
      findFields: unused('findFields'),
      fillFields: unused('fillFields'),
      clearFields: unused('clearFields'),
    })
  }),
).pipe(Layer.provide(evidenceLayer))

/** A subscribed change receipt, rather than polling or sleeping, waits for the startup worker's commit. */
const changesLayer = Layer.effect(
  Changes,
  Effect.gen(function* () {
    const hub = yield* PubSub.unbounded<ReadonlyArray<Topic>>()
    const evidence = yield* ProviderEvidence
    return Changes.of({
      // Publication happens after timer rearming; a row snapshot alone cannot prove that ordering.
      publish: Effect.fn('Computer.test.publish')(function* (topics) {
        const observePublication = yield* Ref.get(evidence.onPublish)
        yield* observePublication
        yield* PubSub.publish(hub, topics)
      }),
      subscribe: Effect.fn('Computer.test.subscribe')(function* (topics) {
        const subscription = yield* PubSub.subscribe(hub)
        return Stream.fromSubscription(subscription).pipe(
          Stream.filter((moved) => moved.some((topic) => topics.includes(topic))),
          Stream.map(() => undefined),
        )
      }),
    })
  }),
).pipe(Layer.provide(evidenceLayer))

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
  Layer.effect(Database, Database),
  evidenceLayer,
  providerLayer,
  changesLayer,
  gateLayer,
)
/** Device answers may stop their Run through the public runtime abort adapter. */
const runtimeTestLayer = Layer.merge(
  Layer.mock(Runtime, {
    stop: Effect.fn('ComputerTest.abort')((_thread) => Effect.succeed(true)),
  }),
  // These Threads start no helpers, so a Stop has none to stop.
  Layer.mock(ChildRuns, { stopThread: () => Effect.void }),
)
const testLayer = computerStores.pipe(
  Layer.provideMerge(deviceLayer),
  Layer.provideMerge(runtimeTestLayer),
  Layer.provideMerge(dependencies),
)
/** Real approval claim and Gate over a test Device, with the Computer runner used in production. */
const browserRunnerLayer = Layer.effect(
  ActionRunner,
  Effect.gen(function* () {
    const context = yield* Effect.context<ComputerStore | DeviceRegistry>()
    return ActionRunner.of({
      inspect: () => Effect.succeed([]),
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
    Layer.mergeAll(stores, browserRunnerLayer).pipe(Layer.provideMerge(testLayer)),
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
  const requests = yield* Queue.unbounded<typeof DeviceRequest.cases.Act.Type>()
  /** Acquiring watch establishes presence before the producer can dispatch. */
  const connect = Effect.fn('Computer.test.connect')(function* () {
    yield* registry.allow(test.personal.person.id, device.id)
    const ready = yield* Deferred.make<void>()
    const fiber = yield* Effect.gen(function* () {
      const stream = yield* registry.watch({
        ability: { pages: true, apps: false, egress: false, signins: false },
        personId: test.personal.person.id,
        sessionId: session.sessionId,
        device: device.id,
        installation,
      })
      yield* Deferred.succeed(ready, undefined)
      yield* stream.pipe(
        Stream.runForEach((request) =>
          DeviceRequest.guards.Act(request) ? Queue.offer(requests, request) : Effect.void,
        ),
      )
    }).pipe(Effect.scoped, Effect.forkScoped)
    yield* Deferred.await(ready)
    return fiber
  })

  const actor = test.vivid
  return { test, registry, database, runId, device, session, requests, connect, actor }
})
/** A click on the Person's own signed-in page, as an Approval would hold it. */
const approvedClick = ProposedAction.make({
  summary: 'Click Send',
  rationale: '',
  effect: 'write',
  target: ActionTarget.cases.Browser.make({
    action: BrowserAction.cases.Click.make({ target: 'Send' }),
    target: BrowseTarget.cases.Person.make({}),
  }),
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

const request = { command: 'echo hello', directory: '/', timeoutSeconds: 10 }

/** A pending stored desktop action is the same permission receipt for a cold or running Computer. */
const pendingApproval = (person: Person) => {
  const action = ProposedAction.make({
    summary: 'Look at the desktop',
    rationale: '',
    effect: 'write',
    target: ActionTarget.cases.Desktop.make({ action: DesktopAction.cases.Look.make({}) }),
  })
  return Approval.make({
    id: ApprovalId.make(NodeCrypto.randomUUID()),
    threadId: ThreadId.make(NodeCrypto.randomUUID()),
    runId: null,
    action,
    digest: 'stored-action',
    binding: ApprovalBinding.make({ connectionGeneration: null, preconditions: [] }),
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

/** Subscribe before starting and await the Running publication: a persisted row alone can precede idle-timer acquisition, so clock-moving cases must wait for both. */
const start = Effect.fn('Computer.test.start')(function* (person: Person) {
  const changes = yield* Changes
  const store = yield* ComputerStore
  const moved = yield* changes.subscribe([Topic.person(person.id)], everyPart)
  const evidence = yield* ProviderEvidence
  const publishedRunning = yield* Deferred.make<void>()
  yield* Ref.set(
    evidence.onPublish,
    store.get(person.id).pipe(
      Effect.flatMap((computer) =>
        ComputerState.guards.Running(computer.state)
          ? Deferred.succeed(publishedRunning, undefined).pipe(Effect.asVoid)
          : Effect.void,
      ),
      Effect.catch(() =>
        Effect.sync(() => expect.fail('Startup publication must expose a readable Computer')),
      ),
    ),
  )
  const receipt = yield* computerHandlers.StartComputer().pipe(asPerson(person))
  expect(receipt.computer.state._tag).toBe('Starting')
  const ready = yield* Stream.concat(Stream.make(undefined), moved).pipe(
    Stream.mapEffect(() => store.get(person.id)),
    Stream.filter((computer) => ComputerState.guards.Running(computer.state)),
    Stream.runHead,
  )
  expect(Option.isSome(ready)).toBe(true)
  yield* Deferred.await(publishedRunning)
  yield* Ref.set(evidence.onPublish, Effect.void)
})

describe.skipIf(!testDatabaseConfigured)('Computer ownership and trust', () => {
  layer(testDatabaseLayer, { excludeTestServices: true })((it) => {
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
        }).pipe(Effect.scoped, (program) => scopedCase(personBrowserLayer, program, 'fresh')),
    )

    for (const step of [
      BrowserAction.cases.Read.make({}),
      BrowserAction.cases.Screenshot.make({}),
    ]) {
      it.effect(`Person ${step._tag} asks before exposing content to a Company Thread`, () =>
        Effect.gen(function* () {
          const browser = yield* personalBrowser()
          yield* browser.connect()
          yield* browser.database.run(
            browser.database
              .update(threads)
              .set({ audience: 'company' })
              .where(eq(threads.id, browser.test.companyId)),
          )
          yield* browser.database.run(
            browser.database
              .update(runs)
              .set({ threadId: browser.test.companyId })
              .where(eq(runs.id, browser.runId)),
          )
          const outcome = yield* computerHandlers.Browse({ ...personalRead, action: step }).pipe(
            Effect.provideService(
              AuthContext,
              AuthState.Vivid({
                person: browser.actor.person,
                workspace: browser.test.companyVivid.workspace,
                threadId: browser.test.companyId,
              }),
            ),
          )
          expect(BrowseOutcome.guards.ApprovalRequired(outcome)).toBe(true)
          expect(yield* Queue.size(browser.requests)).toBe(0)
          expect(yield* (yield* ApprovalStore).inThread(browser.test.companyId)).toHaveLength(1)
        }).pipe(Effect.scoped, (program) => scopedCase(personBrowserLayer, program, 'fresh')),
      )
    }

    // Closing a tab destroys the Person's state, so it is weighed as a write, not a read.
    it.effect('closing the Person’s tab is a write, and nothing is sent before it is decided', () =>
      Effect.gen(function* () {
        const browser = yield* personalBrowser()
        yield* browser.connect()
        const outcome = yield* computerHandlers
          .Browse({ ...personalRead, action: BrowserAction.cases.CloseTab.make({ tab: 1 }) })
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
        expect(BrowseOutcome.guards.ApprovalRequired(outcome)).toBe(true)
        const store = yield* ApprovalStore
        const [approval] = yield* store.inThread(browser.test.personalId)
        if (approval === undefined) expect.fail('Expected pending Approval')
        expect(approval.action.effect).toBe('write')
        expect(yield* Queue.size(browser.requests)).toBe(0)
        const denied = yield* store.decide(browser.test.personal, {
          id: approval.id,
          digest: approval.digest,
          decision: ApprovalDecision.cases.Deny.make({}),
        })
        expect(denied.state._tag).toBe('Denied')
        expect(yield* Queue.size(browser.requests)).toBe(0)
      }).pipe(Effect.scoped, (program) => scopedCase(personBrowserLayer, program, 'fresh')),
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
          const page = BrowseResult.make({
            ...signedPage,
            picture: BrowserPicture.make(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9f8AAAAASUVORK5CYII=',
            ),
          })
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
          expect(JSON.stringify(ledger)).not.toContain(page.picture)
          expect(yield* Queue.size(browser.requests)).toBe(0)
          expect(yield* Ref.get((yield* ProviderEvidence).calls)).toEqual([])
        }).pipe(Effect.scoped, (program) => scopedCase(personBrowserLayer, program, 'fresh')),
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
          // A later Run is now working in the same Thread. Approval still carries the original
          // proposal's Run, never whatever the Thread's latest Run happens to be at decision time.
          yield* browser.database.run(
            browser.database
              .update(runs)
              .set({ state: 'completed', finishedAt: 1 })
              .where(eq(runs.id, browser.runId)),
          )
          const newer = RunId.make(NodeCrypto.randomUUID())
          yield* browser.database.run(
            browser.database.insert(runs).values({
              id: newer,
              threadId: browser.test.personalId,
              personId: browser.actor.person.id,
              turn: 2,
              state: 'working',
              origin: encodeRunOrigin(StoredRunOrigin.cases.Message.make({})),
              startedAt: 2,
              admittedAt: 2,
            }),
          )
          const decide = {
            id: approval.id,
            digest: approval.digest,
            decision: ApprovalDecision.cases.AllowOnce.make({}),
          }
          const executing = yield* store
            .decide(browser.test.personal, decide)
            .pipe(Effect.forkScoped)
          const dispatched = yield* Queue.take(browser.requests)
          expect(dispatched.runId).toBe(browser.runId)
          yield* browser.registry.answer(browser.actor.person.id, browser.session.sessionId, {
            device: browser.device.id,
            id: dispatched.id,
            answer: DeviceAnswer.cases.Done.make({ result: signedPage }),
          })
          const completed = yield* Fiber.join(executing)
          if (!ApprovalState.guards.Succeeded(completed.state)) expect.fail('Expected success')
          expect(completed.state.result).toBe('The browser action completed.')
          const [receipt] = yield* browser.database.run(
            browser.database.select().from(approvals).where(eq(approvals.id, approval.id)),
          )
          expect(JSON.stringify(receipt)).not.toContain(signedPage.outline)
          expect((yield* store.decide(browser.test.personal, decide).pipe(Effect.flip))._tag).toBe(
            'ApprovalDecided',
          )
          expect(yield* Queue.size(browser.requests)).toBe(0)
        }).pipe(Effect.scoped, (program) => scopedCase(personBrowserLayer, program, 'fresh')),
    )

    for (const [reason, expected] of [
      ['Stopped', BrowseOutcome.cases.Stopped.make({})],
      ['PageGone', BrowseOutcome.cases.PageGone.make({})],
      ['NotAllowed', BrowseOutcome.cases.AddressRefused.make({})],
      ['Unsupported', BrowseOutcome.cases.Unsupported.make({})],
    ] as const) {
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
          expect(yield* Fiber.join(running)).toEqual(expected)
          expect(yield* Queue.size(browser.requests)).toBe(0)
        }).pipe(Effect.scoped, (program) => scopedCase(personBrowserLayer, program, 'fresh')),
      )
    }

    it.effect('invalid persisted Run state settles the Approval as not sent without dispatch', () =>
      Effect.gen(function* () {
        const browser = yield* personalBrowser()
        yield* browser.connect()
        const store = yield* ApprovalStore
        const approval = yield* store.raise(
          browser.actor,
          ProposedAction.make({
            summary: 'Click Send',
            rationale: '',
            effect: 'write',
            target: ActionTarget.cases.Browser.make({
              target: BrowseTarget.cases.Person.make({}),
              action: BrowserAction.cases.Click.make({ target: 'Send' }),
            }),
          }),
          unbound,
        )
        yield* browser.database.run(
          browser.database
            .update(runs)
            .set({ state: 'unrecognized', finishedAt: 1 })
            .where(eq(runs.id, browser.runId)),
        )
        const completed = yield* store.decide(browser.test.personal, {
          id: approval.id,
          digest: approval.digest,
          decision: ApprovalDecision.cases.AllowOnce.make({}),
        })
        if (!ApprovalState.guards.Failed(completed.state))
          expect.fail('Expected a not-sent failure')
        expect(completed.state.reason).toBe(
          'Nothing was sent, because the Computer record could not be read or updated.',
        )
        const [settled] = yield* browser.database.run(
          browser.database.select().from(approvals).where(eq(approvals.id, approval.id)),
        )
        if (settled === undefined) expect.fail('Approval must remain durably recorded')
        expect(settled.status).toBe('failed')
        expect(yield* Queue.size(browser.requests)).toBe(0)
        expect(
          yield* browser.database.run(
            browser.database
              .select()
              .from(deviceRequests)
              .where(eq(deviceRequests.runId, browser.runId)),
          ),
        ).toEqual([])
      }).pipe(Effect.scoped, (program) => scopedCase(personBrowserLayer, program, 'fresh')),
    )

    it.effect('a stopped proposing Run reports not sent without dispatch', () =>
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
            authority: BrowseAuthority.cases.Acting.make({}),
          }),
        ).toEqual(BrowseOutcome.cases.RunRequired.make({}))
        expect(yield* Queue.size(browser.requests)).toBe(0)
      }).pipe(Effect.scoped, (program) => scopedCase(personBrowserLayer, program, 'fresh')),
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
          browser.database
            .select()
            .from(deviceRequests)
            .where(eq(deviceRequests.id, dispatched.id)),
        )
        if (receipt === undefined) expect.fail('Expected persisted receipt')
        expect(receipt.status).toBe('OutcomeUnknown')
      }).pipe(Effect.scoped, (program) => scopedCase(personBrowserLayer, program, 'fresh')),
    )

    // Raising an Approval ends the Run's turn, so the Run has always completed by the time the
    // Person can press Allow. The approved action must still be sent, once.
    it.effect('an approved action is sent after its proposing Run has completed', () =>
      Effect.gen(function* () {
        const browser = yield* personalBrowser()
        yield* browser.connect()
        const store = yield* ApprovalStore
        const approval = yield* store.raise(browser.test.vivid, approvedClick, unbound)
        yield* browser.database.run(
          browser.database
            .update(runs)
            .set({ state: 'completed', finishedAt: 1 })
            .where(eq(runs.id, browser.runId)),
        )
        const executing = yield* store
          .decide(browser.test.personal, {
            id: approval.id,
            digest: approval.digest,
            decision: ApprovalDecision.cases.AllowOnce.make({}),
          })
          .pipe(Effect.forkScoped)
        const dispatched = yield* Queue.take(browser.requests)
        expect(dispatched.runId).toBe(browser.runId)
        yield* browser.registry.answer(browser.actor.person.id, browser.session.sessionId, {
          device: browser.device.id,
          id: dispatched.id,
          answer: DeviceAnswer.cases.Done.make({ result: signedPage }),
        })
        const settled = yield* Fiber.join(executing)
        expect(ApprovalState.guards.Succeeded(settled.state)).toBe(true)
        expect(yield* Queue.size(browser.requests)).toBe(0)
      }).pipe(Effect.scoped, (program) => scopedCase(personBrowserLayer, program, 'fresh')),
    )

    // Stopping a Run is the Person saying "no more from this": approving afterwards sends nothing.
    it.effect('an approved action is not sent when its proposing Run was stopped', () =>
      Effect.gen(function* () {
        const browser = yield* personalBrowser()
        yield* browser.connect()
        const store = yield* ApprovalStore
        const approval = yield* store.raise(browser.test.vivid, approvedClick, unbound)
        yield* browser.database.run(
          browser.database
            .update(runs)
            .set({ state: 'stopped', finishedAt: 1 })
            .where(eq(runs.id, browser.runId)),
        )
        const settled = yield* store.decide(browser.test.personal, {
          id: approval.id,
          digest: approval.digest,
          decision: ApprovalDecision.cases.AllowOnce.make({}),
        })
        expect(settled.state._tag).toBe('Failed')
        expect(yield* Queue.size(browser.requests)).toBe(0)
      }).pipe(Effect.scoped, (program) => scopedCase(personBrowserLayer, program, 'fresh')),
    )

    it.effect('direct cloud actions expose corrupt persistence instead of a provider outage', () =>
      Effect.gen(function* () {
        const browser = yield* personalBrowser()
        yield* (yield* ComputerStore).run(browser.actor.person.id, request)
        yield* browser.database.run(
          browser.database
            .update(computers)
            .set({ status: 'unrecognized' })
            .where(eq(computers.personId, browser.actor.person.id)),
        )
        const evidence = yield* ProviderEvidence
        yield* Ref.set(evidence.calls, [])
        const operations = [
          computerShell(browser.actor, request).pipe(Effect.asVoid),
          computerBrowse(browser.actor, {
            target: BrowseTarget.cases.Vivid.make({}),
            action: BrowserAction.cases.Read.make({}),
            summary: 'Read the page',
          }).pipe(Effect.asVoid),
          computerDesktop(browser.actor, {
            action: DesktopAction.cases.Look.make({}),
            summary: 'Look at the desktop',
          }).pipe(Effect.asVoid),
        ]
        for (const operation of operations) {
          const result = yield* operation.pipe(Effect.result)
          if (Result.isSuccess(result)) expect.fail('Corrupt persistence must fail the call')
          expect(result.failure._tag).toBe('DatabaseFailure')
        }
        expect(yield* Ref.get(evidence.calls)).toEqual([])
      }).pipe(Effect.scoped, (program) => scopedCase(personBrowserLayer, program, 'fresh')),
    )

    it.effect('a cloud screenshot combines the browser outline with the existing desktop PNG', () =>
      Effect.gen(function* () {
        const { first } = yield* fixture()
        const result = yield* (yield* ComputerStore).browse(
          first.id,
          BrowserAction.cases.Screenshot.make({}),
        )
        expect(result.picture).toEqual(
          BrowserPicture.make(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9f8AAAAASUVORK5CYII=',
          ),
        )
        expect(result).toMatchObject({
          address: 'https://example.com',
          title: 'Example',
          outline: 'Example outline',
          truncated: false,
          tabs: [{ title: 'Example', address: 'https://example.com', showing: true }],
        })
        expect(yield* Ref.get((yield* ProviderEvidence).calls)).toEqual([
          computerMachineKey(first.id),
          computerMachineKey(first.id),
        ])
      }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )

    it.effect(
      'another Thread member cannot approve the Person’s computer or consume the pending Approval',
      () =>
        Effect.gen(function* () {
          const browser = yield* personalBrowser()
          const database = yield* Database
          const store = yield* ApprovalStore
          const approval = yield* store.raise(
            browser.test.companyVivid,
            ProposedAction.make({
              summary: 'Click Send',
              rationale: '',
              effect: 'write',
              target: ActionTarget.cases.Browser.make({
                action: BrowserAction.cases.Click.make({ target: 'Send' }),
                target: BrowseTarget.cases.Person.make({}),
              }),
            }),
            unbound,
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
        }).pipe(Effect.scoped, (program) => scopedCase(personBrowserLayer, program, 'fresh')),
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
        }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )

    it.effect('inventory reads the catalogue beside an action, instead of queueing behind it', () =>
      Effect.gen(function* () {
        // Production, 26 October 2026: every message sent while Vivid browsed waited for this
        // probe behind the Run's own Computer action, and the fifth missed admission.
        const { first } = yield* fixture()
        const store = yield* ComputerStore
        const evidence = yield* ProviderEvidence
        yield* start(first)
        const gate = yield* Deferred.make<void>()
        yield* Ref.set(evidence.executionGate, Option.some(gate))
        const action = yield* store.run(first.id, request).pipe(Effect.forkScoped)
        yield* Queue.take(evidence.executing)
        // The action keeps waiting on its gate; the catalogue read itself is not held back.
        yield* Ref.set(evidence.executionGate, Option.none())
        const installed = ComputerInventory.cases.Installed.make({
          apps: [{ name: 'GIMP', purpose: 'Edit raster images' }],
        })
        yield* Ref.set(evidence.commandResult, {
          exitCode: 0,
          output: JSON.stringify(installed),
          truncated: false,
        })
        expect(yield* computerHandlers.GetComputerApps().pipe(asVivid(first))).toEqual(installed)
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(action)
      }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
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
        }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
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
        }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
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
          const command = yield* store.run(first.id, request).pipe(Effect.forkScoped)
          expect(yield* Queue.take(evidence.started)).toBe(computerMachineKey(first.id))
          const browser = yield* store
            .browse(first.id, BrowserAction.cases.Read.make({}))
            .pipe(Effect.forkScoped)
          expect(yield* Ref.get(evidence.calls)).toEqual([])
          expect((yield* store.get(first.id)).state._tag).toBe('Starting')
          yield* Deferred.succeed(boot, undefined)
          expect((yield* Fiber.join(command)).stdout).toBe('hello')
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
        }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )

    it.effect('waits for a start that takes as long as a real one does', () =>
      Effect.gen(function* () {
        const { first } = yield* fixture()
        const store = yield* ComputerStore
        const evidence = yield* ProviderEvidence
        const boot = yield* Deferred.make<void>()
        yield* Ref.set(evidence.boot, Option.some(boot))
        const action = yield* store.run(first.id, request).pipe(Effect.forkScoped)
        yield* Queue.take(evidence.started)
        // A healthy start on the production machine took 95 seconds on 6 October 2026: the old
        // 90 second deadline ended it and recorded the Computer as failed.
        yield* TestClock.adjust('95 seconds')
        yield* Deferred.succeed(boot, undefined)
        expect((yield* Fiber.join(action)).stdout).toBe('hello')
        expect(yield* Ref.get(evidence.ensures)).toHaveLength(1)
      }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )

    it.effect('gives a start up after three minutes, and the next action starts it again', () =>
      Effect.gen(function* () {
        const { first } = yield* fixture()
        const store = yield* ComputerStore
        const evidence = yield* ProviderEvidence
        const boot = yield* Deferred.make<void>()
        yield* Ref.set(evidence.boot, Option.some(boot))
        const action = yield* store.run(first.id, request).pipe(Effect.result, Effect.forkScoped)
        yield* Queue.take(evidence.started)
        yield* TestClock.adjust('3 minutes')
        const result = yield* Fiber.join(action)
        // The action waited for the start and hears how it ended.
        expect(Result.isFailure(result) && result.failure._tag).toBe('ComputerStartFailed')
        const recorded = (yield* store.get(first.id)).state
        expect(ComputerState.guards.Failed(recorded) && recorded.reason).toBe(
          'The Computer did not become ready within 3 minutes.',
        )
        expect(yield* Ref.get(evidence.calls)).toEqual([])
        // Nobody presses Start. The record says the last start failed; the next action starts the
        // Computer again and runs.
        yield* Ref.set(evidence.boot, Option.none())
        expect((yield* store.run(first.id, request)).stdout).toBe('hello')
        expect(yield* Ref.get(evidence.ensures)).toHaveLength(2)
        expect((yield* store.get(first.id)).state._tag).toBe('Running')
      }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )

    it.effect('starts a failed Computer again for every action, while takeover still refuses', () =>
      Effect.gen(function* () {
        const { first } = yield* fixture()
        const store = yield* ComputerStore
        const evidence = yield* ProviderEvidence
        yield* Ref.set(evidence.bootFailed, true)
        expect(
          (yield* store.browse(first.id, BrowserAction.cases.Read.make({})).pipe(Effect.flip))._tag,
        ).toBe('ComputerStartFailed')
        expect(
          (yield* store.desktop(first.id, DesktopAction.cases.Look.make({})).pipe(Effect.flip))
            ._tag,
        ).toBe('ComputerStartFailed')
        // Each action asked the provider again, once: a failed start never ends the trying, and
        // nothing is retried inside one action.
        expect(yield* Ref.get(evidence.ensures)).toHaveLength(2)
        expect(yield* Ref.get(evidence.calls)).toEqual([])
        yield* Ref.set(evidence.bootFailed, false)
        expect((yield* store.run(first.id, request)).stdout).toBe('hello')
        expect(yield* Ref.get(evidence.ensures)).toHaveLength(3)
        yield* store.hold(first.id, true)
        expect((yield* store.run(first.id, request).pipe(Effect.flip))._tag).toBe('ComputerHeld')
        expect(yield* Ref.get(evidence.calls)).toHaveLength(1)
        expect(yield* Ref.get(evidence.ensures)).toHaveLength(3)
      }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )

    it.effect(
      'says why a Computer that has outgrown its machines cannot start, and does not ask at every action',
      () =>
        Effect.gen(function* () {
          const { first } = yield* fixture()
          const store = yield* ComputerStore
          const evidence = yield* ProviderEvidence
          yield* Ref.set(evidence.bootOutgrown, true)
          const refused = yield* store.run(first.id, request).pipe(Effect.flip)
          // The Person, and Vivid in its own words, can tell what would cure it.
          expect(Predicate.isTagged(refused, 'ComputerStartFailed') && refused.reason).toBe(
            'Vivid’s computer holds more data than the largest machine its provider plan allows. It starts again once the plan is upgraded or files are removed from it.',
          )
          // Asking again cannot cure it and every start is counted by the provider, so the next
          // actions are refused with the same reason and the provider is left alone.
          expect((yield* store.run(first.id, request).pipe(Effect.flip))._tag).toBe(
            'ComputerStartFailed',
          )
          expect(
            (yield* store.desktop(first.id, DesktopAction.cases.Look.make({})).pipe(Effect.flip))
              ._tag,
          ).toBe('ComputerStartFailed')
          expect(yield* Ref.get(evidence.ensures)).toHaveLength(1)
          // After the rest an action asks once more.
          yield* TestClock.adjust('10 minutes')
          yield* store.run(first.id, request).pipe(Effect.flip)
          expect(yield* Ref.get(evidence.ensures)).toHaveLength(2)
          // A Person's Start never waits for the rest: they changed something, or want to know.
          yield* Ref.set(evidence.bootOutgrown, false)
          yield* start(first)
          expect(yield* Ref.get(evidence.ensures)).toHaveLength(3)
          expect((yield* store.run(first.id, request)).stdout).toBe('hello')
        }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )

    it.effect('a screen the provider refuses is said on that read and never recorded', () =>
      Effect.gen(function* () {
        const { first } = yield* fixture()
        const database = yield* Database
        const store = yield* ComputerStore
        const evidence = yield* ProviderEvidence
        const recorded = database
          .run(database.select().from(computers).where(eq(computers.personId, first.id)))
          .pipe(Effect.map((rows) => rows.map((row) => [row.status, row.reason])))
        yield* start(first)
        // The machine runs and is in use; only its screen cannot be issued.
        yield* Ref.set(evidence.screenRefused, true)
        const shown = (yield* store.get(first.id)).state
        expect(ComputerState.guards.Failed(shown) && shown.reason).toBe(
          'The Computer provider refused the operation.',
        )
        expect(yield* recorded).toEqual([['running', null]])
        expect((yield* store.run(first.id, request)).stdout).toBe('hello')
        expect(yield* Ref.get(evidence.ensures)).toHaveLength(1)
        yield* Ref.set(evidence.screenRefused, false)
        expect((yield* store.get(first.id)).state._tag).toBe('Running')
      }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )

    it.effect('counts a machine’s idle time from when it is first seen running', () =>
      Effect.gen(function* () {
        const { first } = yield* fixture()
        const store = yield* ComputerStore
        const evidence = yield* ProviderEvidence
        const key = computerMachineKey(first.id)
        yield* start(first)
        yield* store.stop(first.id)
        yield* Queue.clear(evidence.stopped)
        // Hours later someone else starts the machine: another caller over SSH, or the provider.
        yield* TestClock.adjust('3 hours')
        yield* Ref.update(evidence.states, (states) =>
          new Map(states).set(
            key,
            ComputerState.cases.Running.make({
              since: 300,
              screen: ComputerState.cases.Running.fields.screen.cases.Relay.make({
                address: computerScreenAddress,
              }),
            }),
          ),
        )
        // Vivid notices it. Counted from the record's old activity the idle period ended hours ago
        // and the machine would be stopped at once, under whoever started it.
        expect((yield* store.get(first.id)).state._tag).toBe('Running')
        yield* TestClock.adjust('19 minutes')
        expect(Option.isNone(yield* Queue.poll(evidence.stopped))).toBe(true)
        // Only the read that first saw it run starts the idle period. A later read moves nothing:
        // were it to, a Person looking at the Computer would keep it running for good.
        expect((yield* store.get(first.id)).state._tag).toBe('Running')
        yield* TestClock.adjust('1 minute')
        expect(yield* Queue.take(evidence.stopped)).toBe(key)
      }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )

    it.effect('blocked actions leave an absent Computer asleep', () =>
      Effect.gen(function* () {
        const { first } = yield* fixture()
        const evidence = yield* ProviderEvidence
        yield* Ref.set(evidence.decisions, GateDecision.cases.Blocked.make({ rule: 'Never' }))
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
        expect(
          (yield* computerHandlers
            .UseDesktop({ action: DesktopAction.cases.Look.make({}), summary: 'Look' })
            .pipe(asVivid(first)))._tag,
        ).toBe('ApprovalRequired')
        expect((yield* (yield* ComputerStore).get(first.id)).state._tag).toBe('Absent')
        expect(yield* Ref.get(evidence.ensures)).toEqual([])
      }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )

    it.effect(
      'activity replaces the owned idle deadline, then stops after twenty quiet minutes',
      () =>
        Effect.gen(function* () {
          const { first } = yield* fixture()
          const store = yield* ComputerStore
          const evidence = yield* ProviderEvidence
          yield* store.run(first.id, request)
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
        }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )

    it.effect(
      'watching and keyboard ownership suppress idle stop until the last watcher leaves',
      () =>
        Effect.gen(function* () {
          const { first } = yield* fixture()
          const store = yield* ComputerStore
          const evidence = yield* ProviderEvidence
          yield* store.run(first.id, request)
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
        }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )

    it.effect('restores an idle deadline from stored activity when the server layer restarts', () =>
      Effect.gen(function* () {
        const { first } = yield* fixture()
        const evidence = yield* ProviderEvidence
        const id = yield* Effect.scoped(
          Effect.gen(function* () {
            const store = yield* ComputerStore
            yield* store.run(first.id, request)
            return (yield* store.get(first.id)).id
          }).pipe((program) => scopedCase(computerStores, program, 'inherited')),
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
          }).pipe((program) => scopedCase(computerStores, program, 'inherited')),
        )
        expect(yield* Ref.get(evidence.ensures)).toHaveLength(1)
      }).pipe(Effect.scoped, (program) => scopedCase(dependencies, program, 'fresh')),
    )

    it.effect(
      'an executing command suppresses idle stop and completion starts a fresh deadline',
      () =>
        Effect.gen(function* () {
          const { first } = yield* fixture()
          const store = yield* ComputerStore
          const evidence = yield* ProviderEvidence
          yield* store.run(first.id, request)
          yield* Queue.take(evidence.executing)
          yield* TestClock.adjust('19 minutes')
          const gate = yield* Deferred.make<void>()
          yield* Ref.set(evidence.executionGate, Option.some(gate))
          const action = yield* store.run(first.id, request).pipe(Effect.forkScoped)
          yield* Queue.take(evidence.executing)
          yield* TestClock.adjust('40 minutes')
          expect((yield* store.get(first.id)).state._tag).toBe('Running')
          expect(yield* Queue.size(evidence.stopped)).toBe(0)
          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(action)
          yield* TestClock.adjust('20 minutes')
          expect(yield* Queue.take(evidence.stopped)).toBe(computerMachineKey(first.id))
          expect((yield* store.get(first.id)).state._tag).toBe('Stopped')
        }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )

    it.effect('the last of two watching subscriptions starts the idle deadline', () =>
      Effect.gen(function* () {
        const { first } = yield* fixture()
        const store = yield* ComputerStore
        const evidence = yield* ProviderEvidence
        yield* store.run(first.id, request)
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
      }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
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
          const action = yield* (yield* ComputerStore)
            .run(first.id, request)
            .pipe(Effect.forkScoped)
          expect(yield* Queue.take(evidence.started)).toBe(key)
          expect(yield* Ref.get(evidence.calls)).toEqual([])
          yield* Deferred.succeed(gate, undefined)
          expect((yield* Fiber.join(action)).stdout).toBe('hello')
          expect(yield* Ref.get(evidence.ensures)).toEqual([key])
        }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )

    it.effect(
      'an open handoff holds the Computer against Vivid and a Hand back until it ends',
      () =>
        Effect.gen(function* () {
          const { first } = yield* fixture()
          const database = yield* Database
          yield* start(first)
          const threadId = ThreadId.make(NodeCrypto.randomUUID())
          yield* database.run(
            database.insert(threads).values({
              id: threadId,
              title: 'Handoff',
              titleSource: 'Person',
              personId: first.id,
              companyId: null,
              audience: 'private',
              updatedAt: 0,
            }),
          )
          // A handoff is handed over from a Run, which its row references.
          const runId = RunId.make(NodeCrypto.randomUUID())
          yield* database.run(
            database.insert(runs).values({
              id: runId,
              threadId,
              personId: first.id,
              turn: 1,
              state: 'working',
              origin: encodeRunOrigin(StoredRunOrigin.cases.Message.make({})),
              startedAt: 0,
              admittedAt: 0,
            }),
          )
          const id = NodeCrypto.randomUUID()
          yield* database.run(
            database.insert(handoffs).values({
              id,
              threadId,
              runId,
              personId: first.id,
              summary: 'Sign in',
              request: Definition.cases.Screen.make({ kind: 'Captcha' }),
              page: { origin: 'https://example.test', address: 'https://example.test/' },
              binding: { target: 'window', tab: 'tab', digest: 'digest' },
              status: 'waiting',
              createdAt: 0,
            }),
          )
          const store = yield* ComputerStore
          const refused = ComputerShellOutcome.cases.Unavailable.make({
            reason: 'the Person is using the Computer',
          })
          expect((yield* store.get(first.id)).heldByPerson).toBe(true)
          expect(yield* computerHandlers.ComputerShell(request).pipe(asVivid(first))).toEqual(
            refused,
          )
          // The Computer panel's Hand back is not the handoff's to give: it stays held.
          yield* computerHandlers.HoldComputer({ held: false }).pipe(asPerson(first))
          expect((yield* store.get(first.id)).heldByPerson).toBe(true)
          expect(yield* computerHandlers.ComputerShell(request).pipe(asVivid(first))).toEqual(
            refused,
          )
          yield* database.run(
            database.update(handoffs).set({ status: 'completed' }).where(eq(handoffs.id, id)),
          )
          expect((yield* store.get(first.id)).heldByPerson).toBe(false)
          expect((yield* computerHandlers.ComputerShell(request).pipe(asVivid(first)))._tag).toBe(
            'Completed',
          )
        }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
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
          expect((yield* computerHandlers.ComputerShell(request).pipe(asVivid(second)))._tag).toBe(
            'Completed',
          )
          expect(yield* Ref.get(evidence.calls)).toEqual([computerMachineKey(second.id)])
          yield* computerHandlers.HoldComputer({ held: true }).pipe(asPerson(first))
          expect(yield* computerHandlers.ComputerShell(request).pipe(asVivid(first))).toEqual(
            ComputerShellOutcome.cases.Unavailable.make({
              reason: 'the Person is using the Computer',
            }),
          )
          expect(
            yield* computerRunner({
              origin: ActionOrigin.cases.RuntimeThread.make({
                threadId: ThreadId.make('cloud-thread'),
              }),
              person: first,
              target: ActionTarget.cases.Desktop.make({
                action: DesktopAction.cases.Type.make({ text: 'notes' }),
              }),
            }),
          ).toEqual(ActionOutcome.cases.Failed.make({ reason: 'the Person is using the Computer' }))
          yield* computerHandlers.HoldComputer({ held: false }).pipe(asPerson(first))
          expect((yield* computerHandlers.ComputerShell(request).pipe(asVivid(first)))._tag).toBe(
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
        }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
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
          const listening = yield* registry.watch({
            ability: { pages: true, apps: false, egress: false, signins: false },
            personId: first.id,
            sessionId: SessionId.make(NodeCrypto.randomUUID()),
            device: device.id,
            installation,
          })
          void listening
          const response = yield* computerHandlers.Browse(personRequest).pipe(asVivid(first))
          expect(response._tag).toBe('RunRequired')
          expect(yield* Ref.get(evidence.calls)).toEqual([])
          expect(yield* Ref.get(evidence.actions)).toEqual([])
          expect(
            yield* computerRunner({
              origin: ActionOrigin.cases.RuntimeThread.make({
                threadId: ThreadId.make('cloud-thread'),
              }),
              person: first,
              target: ActionTarget.cases.Browser.make({
                action: personRequest.action,
                target: personRequest.target,
              }),
            }),
          ).toEqual(
            ActionOutcome.cases.Failed.make({
              reason: 'This action was not sent because its proposing work is no longer active.',
            }),
          )
        }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
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
            'read',
            'write',
          ])
          yield* Ref.set(evidence.decisions, GateDecision.cases.Allowed.make({ basis: 'Read' }))
          yield* Ref.set(evidence.lost, true)
          // An approved action whose receipt was lost is unknown, so it is never run a second time.
          expect(
            (yield* computerRunner({
              origin: ActionOrigin.cases.RuntimeThread.make({
                threadId: ThreadId.make('cloud-thread'),
              }),
              person: first,
              target: ActionTarget.cases.Desktop.make({
                action: DesktopAction.cases.Type.make({ text: 'notes' }),
              }),
            }))._tag,
          ).toBe('Unknown')
          expect((yield* computerHandlers.ComputerShell(request).pipe(asVivid(first)))._tag).toBe(
            'OutcomeUnknown',
          )
          expect(
            (yield* computerHandlers.ComputerShell(request).pipe(asPerson(first), Effect.flip))
              ._tag,
          ).toBe('Forbidden')
          expect(
            (yield* computerHandlers.StartComputer().pipe(asVivid(first), Effect.flip))._tag,
          ).toBe('Forbidden')
          expect(
            (yield* computerHandlers
              .HoldComputer({ held: false })
              .pipe(asVivid(first), Effect.flip))._tag,
          ).toBe('Forbidden')
        }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
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
          yield* Ref.set(evidence.decisions, GateDecision.cases.Allowed.make({ basis: 'Read' }))
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
        }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )

    it.effect('Vivid readiness and permitted actions never request Person viewer authority', () =>
      Effect.gen(function* () {
        const { first } = yield* fixture()
        const store = yield* ComputerStore
        const evidence = yield* ProviderEvidence
        expect((yield* computerHandlers.ComputerShell(request).pipe(asVivid(first)))._tag).toBe(
          'Completed',
        )
        expect(yield* Ref.get(evidence.viewerReads)).toBe(0)
        expect(
          (yield* computerHandlers.GetComputer().pipe(asPerson(first))).computer.state._tag,
        ).toBe('Running')
        const before = yield* Ref.get(evidence.viewerReads)
        yield* store.access(first.id)
        yield* computerHandlers.ComputerShell(request).pipe(asVivid(first))
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
      }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )

    it.effect(
      'public Computer outcomes distinguish lost dispatch receipts from refused calls',
      () =>
        Effect.gen(function* () {
          const { first } = yield* fixture()
          yield* start(first)
          const evidence = yield* ProviderEvidence
          yield* Ref.set(evidence.lost, true)
          const outcomes = [
            yield* computerHandlers.ComputerShell(request).pipe(asVivid(first)),
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
          expect((yield* computerHandlers.ComputerShell(request).pipe(asVivid(first)))._tag).toBe(
            'Unavailable',
          )
          expect(yield* Ref.get(evidence.calls)).toHaveLength(3)
        }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
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
          const command = yield* store.run(first.id, request).pipe(Effect.forkScoped)
          yield* Queue.take(evidence.executing)
          expect(
            (yield* computerHandlers.HoldComputer({ held: true }).pipe(asPerson(first))).computer
              .heldByPerson,
          ).toBe(true)
          expect((yield* store.get(first.id)).heldByPerson).toBe(true)
          yield* Deferred.succeed(finish, undefined)
          expect((yield* Fiber.join(command)).stdout).toBe('hello')
          expect((yield* computerHandlers.ComputerShell(request).pipe(asVivid(first)))._tag).toBe(
            'Unavailable',
          )
          expect(yield* Ref.get(evidence.calls)).toHaveLength(1)
        }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )

    it.effect('a running state learned by a status read always arms its idle deadline', () =>
      Effect.gen(function* () {
        const { first } = yield* fixture()
        const store = yield* ComputerStore
        const evidence = yield* ProviderEvidence
        const key = computerMachineKey(first.id)
        yield* Ref.set(evidence.bootFailed, true)
        yield* store.run(first.id, request).pipe(Effect.flip)
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
      }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
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
          const moved = yield* changes.subscribe([Topic.person(first.id)], everyPart)
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
              database.run(
                database.select().from(computers).where(eq(computers.personId, first.id)),
              ),
            ),
            Stream.filter((rows) => rows.some((row) => row.status === 'failed')),
            Stream.runHead,
          )
          expect(Option.isSome(failed)).toBe(true)
          if (Option.isSome(failed))
            expect(failed.value.map((row) => row.reason)).toEqual([
              'The Computer provider could not finish the operation.',
            ])
        }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )
    it.effect(
      'tells a provider outage on the call, records nothing, and works again once the provider answers',
      () =>
        Effect.gen(function* () {
          const { first } = yield* fixture()
          const database = yield* Database
          const store = yield* ComputerStore
          const evidence = yield* ProviderEvidence
          const recorded = database
            .run(database.select().from(computers).where(eq(computers.personId, first.id)))
            .pipe(Effect.map((rows) => rows.map((row) => [row.status, row.reason])))
          const notAnswering = 'Vivid’s computer is not answering right now. Try again in a moment.'
          expect((yield* store.run(first.id, request)).exitCode).toBe(0)
          expect(yield* recorded).toEqual([['running', null]])

          // The provider stops answering while the Computer is running.
          yield* Ref.set(evidence.outage, true)
          expect((yield* store.get(first.id)).state).toEqual(
            ComputerState.cases.Failed.make({ since: 100, reason: notAnswering }),
          )
          expect(yield* store.access(first.id)).toEqual(
            ComputerAccess.cases.Unavailable.make({ reason: notAnswering }),
          )
          // An action is refused with the provider's own failure, before anything is dispatched.
          const calls = yield* Ref.get(evidence.calls)
          expect((yield* store.run(first.id, request).pipe(Effect.flip))._tag).toBe(
            'MachineUnreachable',
          )
          expect(yield* Ref.get(evidence.calls)).toEqual(calls)
          // Stopping could not be asked either: nothing is claimed and nothing is written.
          const unstopped = (yield* store.stop(first.id)).state
          expect(ComputerState.guards.Failed(unstopped) && unstopped.reason).toBe(notAnswering)
          expect(yield* recorded).toEqual([['running', null]])

          // The provider answers again. Nobody pressed Start and nothing was restarted.
          yield* Ref.set(evidence.outage, false)
          expect((yield* store.get(first.id)).state._tag).toBe('Running')
          expect((yield* store.run(first.id, request)).exitCode).toBe(0)
        }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )
    it.effect('an idle stop that met an outage records nothing and is tried again', () =>
      Effect.gen(function* () {
        const { first } = yield* fixture()
        const database = yield* Database
        const store = yield* ComputerStore
        const evidence = yield* ProviderEvidence
        const key = computerMachineKey(first.id)
        const status = database
          .run(database.select().from(computers).where(eq(computers.personId, first.id)))
          .pipe(Effect.map((rows) => rows.map((row) => [row.status, row.reason])))
        expect((yield* store.run(first.id, request)).exitCode).toBe(0)
        // The provider is down at the moment the idle deadline passes.
        yield* Ref.set(evidence.outage, true)
        yield* TestClock.adjust('20 minutes')
        // The stop was asked for and the provider could not answer: nothing is written.
        expect(yield* Queue.take(evidence.stopAttempts)).toBe(key)
        expect(yield* status).toEqual([['running', null]])
        // The provider answers again, and the stop is tried a minute later without anyone
        // touching the Computer.
        yield* Ref.set(evidence.outage, false)
        yield* TestClock.adjust('1 minute')
        expect(yield* Queue.take(evidence.stopped)).toBe(key)
        expect((yield* store.get(first.id)).state._tag).toBe('Stopped')
      }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )
    it.effect(
      'a start that met an outage leaves the Computer stopped, so the next action wakes it',
      () =>
        Effect.gen(function* () {
          const { first } = yield* fixture()
          const database = yield* Database
          const store = yield* ComputerStore
          const evidence = yield* ProviderEvidence
          yield* Ref.set(evidence.outage, true)
          expect((yield* store.run(first.id, request).pipe(Effect.flip))._tag).toBe(
            'MachineUnreachable',
          )
          // Not a failed start: a failed start would refuse every action until a Person pressed Start.
          expect(
            (yield* database.run(
              database.select().from(computers).where(eq(computers.personId, first.id)),
            )).map((row) => [row.status, row.reason]),
          ).toEqual([['stopped', null]])
          yield* Ref.set(evidence.outage, false)
          expect((yield* store.run(first.id, request)).exitCode).toBe(0)
          expect((yield* store.get(first.id)).state._tag).toBe('Running')
        }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
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
          const key = computerMachineKey(first.id)
          expect(yield* Queue.take(evidence.started)).toBe(key)
          expect(
            (yield* computerHandlers.StopComputer().pipe(asPerson(first))).computer.state._tag,
          ).toBe('Stopped')
          expect(yield* Queue.poll(evidence.bootExited)).toEqual(
            Option.some({ key, interrupted: true }),
          )
          yield* Deferred.succeed(latch, undefined)
          const store = yield* ComputerStore
          expect((yield* store.get(first.id)).state._tag).toBe('Stopped')
          const physical = Option.fromUndefinedOr(
            (yield* Ref.get(evidence.states)).get(computerMachineKey(first.id)),
          )
          expect(
            Option.match(physical, { onNone: () => false, onSome: ComputerState.guards.Running }),
          ).toBe(false)
        }).pipe(Effect.scoped, (program) => scopedCase(testLayer, program, 'fresh')),
    )
  })
})
