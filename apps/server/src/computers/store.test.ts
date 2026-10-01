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
  Redacted,
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
import { computers } from './tables.ts'

/** Test authority records actual seam calls and can lose machines or command receipts deliberately. */
interface EvidenceService {
  readonly states: Ref.Ref<ReadonlyMap<MachineKey, ComputerState>>
  readonly calls: Ref.Ref<ReadonlyArray<MachineKey>>
  readonly decisions: Ref.Ref<GateDecision>
  readonly actions: Ref.Ref<ReadonlyArray<ProposedAction>>
  readonly lost: Ref.Ref<boolean>
  readonly boot: Ref.Ref<Option.Option<Deferred.Deferred<void>>>
  readonly bootFailed: Ref.Ref<boolean>
}
class ProviderEvidence extends Context.Service<ProviderEvidence, EvidenceService>()(
  'vivid/ComputerTestEvidence',
) {}

const evidenceLayer = Layer.effect(
  ProviderEvidence,
  Effect.gen(function* () {
    return ProviderEvidence.of({
      states: yield* Ref.make<ReadonlyMap<MachineKey, ComputerState>>(new Map()),
      calls: yield* Ref.make<ReadonlyArray<MachineKey>>([]),
      decisions: yield* Ref.make<GateDecision>(GateDecision.cases.Allowed.make({})),
      actions: yield* Ref.make<ReadonlyArray<ProposedAction>>([]),
      lost: yield* Ref.make(false),
      bootFailed: yield* Ref.make(false),
      boot: yield* Ref.make<Option.Option<Deferred.Deferred<void>>>(Option.none()),
    })
  }),
)

/** This provider Layer is the test dependency; the persisted Computer service and handlers are real. */
const providerLayer = Layer.effect(
  Machine,
  Effect.gen(function* () {
    const evidence = yield* ProviderEvidence
    const status = Effect.fn('Computer.test.status')(function* (key: MachineKey) {
      const states = yield* Ref.get(evidence.states)
      const state = states.get(key)
      return state === undefined ? ComputerState.cases.Absent.make({}) : state
    })
    const ensure = Effect.fn('Computer.test.ensure')(function* (key: MachineKey) {
      const wait = yield* Ref.get(evidence.boot)
      if (Option.isSome(wait)) yield* Deferred.await(wait.value)
      if (yield* Ref.get(evidence.bootFailed))
        return yield* Effect.fail(new MachineOperationFailed({ operation: 'startup' }))
      const state = ComputerState.cases.Running.make({
        since: 100,
        screenAddress: 'http://127.0.0.1:62001/vnc.html',
      })
      yield* Ref.update(evidence.states, (states) => new Map(states).set(key, state))
      return state
    })
    const stop = Effect.fn('Computer.test.stop')(function* (key: MachineKey) {
      yield* Ref.update(evidence.states, (states) =>
        new Map(states).set(key, ComputerState.cases.Stopped.make({ since: 200 })),
      )
    })
    const exec = Effect.fn('Computer.test.exec')(function* ({
      key,
    }: Parameters<typeof Machine.Service.exec>[0]) {
      yield* Ref.update(evidence.calls, (calls) => [...calls, key])
      if (yield* Ref.get(evidence.lost))
        return yield* Effect.fail(new MachineExecutionUnknown({ key }))
      return { exitCode: 0, output: 'hello', truncated: false }
    })
    const browse = Effect.fn('Computer.test.browse')(function* ({
      key,
    }: Parameters<typeof Machine.Service.browse>[0]) {
      yield* Ref.update(evidence.calls, (calls) => [...calls, key])
      return {
        address: 'https://example.com',
        title: 'Example',
        outline: 'Example outline',
        truncated: false,
      }
    })
    const screen = Effect.fn('Computer.test.screen')(function* (key: MachineKey) {
      const state = yield* status(key)
      if (!ComputerState.guards.Running(state))
        return yield* Effect.fail(new MachineNotRunning({ key }))
      return {
        address: state.screenAddress,
        authorization: Redacted.make('test-only-screen-authority'),
      }
    })
    return Machine.of({ status, ensure, stop, exec, browse, screen })
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
const testLayer = computerStoreLayer.pipe(Layer.provideMerge(dependencies))
const request = { command: 'echo hello', summary: 'Read a greeting', timeoutSeconds: 10 }

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
          ComputerState.cases.Running.make({ since: 100, screenAddress: computerScreenAddress }),
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
          'Unavailable',
        )
        expect(yield* Ref.get(evidence.calls)).toHaveLength(0)
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
        expect(yield* Ref.get(evidence.calls)).toEqual([computerMachineKey(first.id)])
        yield* start(second)
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
            .Browse({ action: BrowserAction.cases.Read.make({}), summary: 'Read the page' })
            .pipe(asVivid(first)))._tag,
        ).toBe('Blocked')
        const action = ProposedAction.make({
          summary: request.summary,
          rationale: '',
          effect: 'write',
          target: ActionTarget.cases.Command.make({ command: request.command }),
        })
        const approval = Approval.make({
          id: ApprovalId.make(NodeCrypto.randomUUID()),
          threadId: ThreadId.make(NodeCrypto.randomUUID()),
          runId: null,
          action,
          digest: 'stored-action',
          askedOf: {
            id: first.id,
            name: first.name,
            image: Option.getOrNull(Option.fromNullishOr(first.image)),
          },
          state: ApprovalState.cases.Pending.make({ expiresAt: 1000 }),
          createdAt: 0,
        })
        yield* Ref.set(evidence.decisions, GateDecision.cases.ApprovalRequired.make({ approval }))
        expect((yield* computerHandlers.RunCommand(request).pipe(asVivid(first)))._tag).toBe(
          'ApprovalRequired',
        )
        expect(
          (yield* computerHandlers
            .Browse({
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
          'Unavailable',
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
