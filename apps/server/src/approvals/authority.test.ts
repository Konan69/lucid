import { describe, expect, layer } from '@effect/vitest'
import {
  ActionTarget,
  ApprovalDecision,
  BrowseTarget,
  BrowserAction,
  Conflict,
  InvalidRequest,
  NotFound,
  ProposedAction,
  RunId,
  ShareThreadRequest,
  type Approval,
} from '@vivid/contracts'
import { eq } from 'drizzle-orm'
import { Array as Arr, Clock, Effect, Layer, Option, Order, Ref, Result, Schema } from 'effect'
import * as fc from 'fast-check'
import { scopedCase } from '../../tests/case.ts'
import { twoPeople } from '../../tests/people.ts'
import { checkSequences } from '../../tests/property.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { DeliverySpeaker, StoredRunOrigin } from '../threads/conversation.ts'
import { ThreadStore, threadStoreLayer } from '../threads/store.ts'
import { runs } from '../threads/tables.ts'
import { ActionOrigin, type ActionRunner } from './gate.ts'
import { ApprovalStore } from './store.ts'
import { connectionAction, Observation, trustTestServices } from './testing.ts'

const Person = Schema.Literals(['first', 'second'])
const Target = Schema.Literals(['browser', 'connection'])
const Decision = Schema.Literals(['allow', 'deny'])
const Command = Schema.TaggedUnion({
  Propose: { person: Person, target: Target },
  Decide: { person: Person, decision: Decision, card: Schema.Int, changedDigest: Schema.Boolean },
  Withdraw: { person: Person, card: Schema.Int },
  Share: { shared: Schema.Boolean },
  Run: { person: Person, admitted: Schema.Boolean },
  Replay: {},
})
type Command = typeof Command.Type
type People = Effect.Success<ReturnType<typeof twoPeople>>
type Execution = Parameters<ActionRunner['Service']['run']>[0]

const browser = ProposedAction.make({
  summary: 'Send the draft',
  rationale: 'The signed-in browser belongs to the addressed Person',
  effect: 'write',
  target: ActionTarget.cases.Browser.make({
    target: BrowseTarget.cases.Person.make({}),
    action: BrowserAction.cases.Click.make({ target: 'Send' }),
  }),
})
const actions = { browser, connection: connectionAction }
const people = fc.constantFrom(...Person.literals)
const card = fc.nat({ max: 3 })
/** Short command streams shrink to a single authority violation while keeping real SQL affordable. */
const command: fc.Arbitrary<Command> = fc.oneof(
  fc
    .record({ person: people, target: fc.constantFrom(...Target.literals) })
    .map((value) => Command.cases.Propose.make(value)),
  fc
    .record({
      person: people,
      decision: fc.constantFrom(...Decision.literals),
      card,
      changedDigest: fc.boolean(),
    })
    .map((value) => Command.cases.Decide.make(value)),
  fc.record({ person: people, card }).map((value) => Command.cases.Withdraw.make(value)),
  fc.record({ shared: fc.boolean() }).map((value) => Command.cases.Share.make(value)),
  fc
    .record({ person: people, admitted: fc.boolean() })
    .map((value) => Command.cases.Run.make(value)),
  fc.constant(Command.cases.Replay.make({})),
)
const sequences = fc.array(command, { minLength: 1, maxLength: 8 })

interface Card {
  readonly approval: Approval
  readonly person: typeof Person.Type
  readonly target: typeof Target.Type
  readonly origin: ActionOrigin
  readonly state: 'Pending' | 'Succeeded' | 'Denied' | 'Withdrawn'
}
interface Model {
  readonly shared: boolean
  readonly run: {
    readonly person: typeof Person.Type
    readonly admitted: boolean
    readonly id: RunId
  }
  readonly turn: number
  readonly cards: Arr.NonEmptyReadonlyArray<Card>
  readonly executions: ReadonlyArray<Execution>
  readonly deliveries: ReadonlyArray<{ readonly card: Card; readonly person: typeof Person.Type }>
}

const services = Layer.merge(trustTestServices, threadStoreLayer)
const origin = Schema.encodeSync(StoredRunOrigin)(StoredRunOrigin.cases.Message.make({}))

/** Only admitted working Runs authorize proposals; completed Runs remain to test frozen origins. */
const moveRun = Effect.fn('AuthorityTest.moveRun')(function* (
  test: People,
  turn: number,
  event: typeof Command.cases.Run.Type,
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.run(
    database
      .update(runs)
      .set({ state: 'completed', finishedAt: now })
      .where(eq(runs.threadId, test.threadId)),
  )
  const id = RunId.make(`${test.threadId}-${turn}`)
  yield* database.run(
    database.insert(runs).values({
      id,
      threadId: test.threadId,
      personId: test[event.person].person.id,
      turn,
      origin,
      state: 'working',
      startedAt: now,
      admittedAt: event.admitted ? now : null,
    }),
  )
  return { person: event.person, admitted: event.admitted, id }
})

/** Re-proposals reuse only a pending card for the same Person and capability, retaining its origin. */
const propose = Effect.fn('AuthorityTest.propose')(function* (
  test: People,
  model: Model,
  event: typeof Command.cases.Propose.Type,
) {
  const actor = {
    ...test[event.person],
    by: 'vivid',
    threadId: Option.some(test.threadId),
  } as const
  const result = yield* Effect.result((yield* ApprovalStore).raise(actor, actions[event.target]))
  if (
    (!model.shared && event.person === 'second') ||
    (model.run.admitted && model.run.person !== event.person)
  ) {
    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(NotFound)
    return model
  }
  const approval = Result.getOrThrow(result)
  const previous = model.cards.find(
    (entry) =>
      entry.person === event.person && entry.target === event.target && entry.state === 'Pending',
  )
  if (previous !== undefined) {
    expect(approval).toEqual(previous.approval)
    return model
  }
  const expectedOrigin = model.run.admitted
    ? ActionOrigin.cases.Run.make({ threadId: test.threadId, runId: model.run.id })
    : ActionOrigin.cases.RuntimeThread.make({ threadId: test.threadId })
  expect(approval.runId).toBe(model.run.admitted ? model.run.id : null)
  const added: Card = {
    approval,
    person: event.person,
    target: event.target,
    origin: expectedOrigin,
    state: 'Pending',
  }
  return { ...model, cards: [added, ...model.cards] } satisfies Model
})

/** Access and resource authority precede the once-only claim, so refusals leave every card intact. */
const decide = Effect.fn('AuthorityTest.decide')(function* (
  test: People,
  model: Model,
  event: typeof Command.cases.Decide.Type,
) {
  const selected = Option.getOrThrow(Arr.get(model.cards, event.card % model.cards.length))
  const actor = test[event.person]
  const decision =
    event.decision === 'allow'
      ? ApprovalDecision.cases.AllowOnce.make({})
      : ApprovalDecision.cases.Deny.make({})
  const result = yield* Effect.result(
    (yield* ApprovalStore).decide(actor, {
      id: selected.approval.id,
      digest: event.changedDigest ? 'changed' : selected.approval.digest,
      decision,
    }),
  )
  if (!model.shared && event.person === 'second') {
    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(NotFound)
    return model
  }
  if (event.changedDigest) {
    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(Conflict)
    return model
  }
  if (
    selected.target === 'browser' &&
    event.decision === 'allow' &&
    selected.person !== event.person
  ) {
    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(InvalidRequest)
    return model
  }
  if (selected.state !== 'Pending') {
    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(Conflict)
    return model
  }
  const state = event.decision === 'allow' ? 'Succeeded' : 'Denied'
  expect(Result.getOrThrow(result).state._tag).toBe(state)
  return {
    ...model,
    cards: Arr.map(model.cards, (entry) => (entry === selected ? { ...entry, state } : entry)),
    executions:
      event.decision === 'deny'
        ? model.executions
        : model.executions.concat([
            {
              person: actor.person,
              workspace: actor.workspace,
              action: actions[selected.target],
              origin: selected.origin,
            },
          ]),
    // A valid decision still cannot resume a proposer who has since lost Thread reach.
    deliveries:
      !model.shared && selected.person === 'second'
        ? model.deliveries
        : model.deliveries.concat([{ card: selected, person: event.person }]),
  } satisfies Model
})

/** Withdrawal belongs to the addressed Person, even while another participant can decide shared work. */
const withdraw = Effect.fn('AuthorityTest.withdraw')(function* (
  test: People,
  model: Model,
  event: typeof Command.cases.Withdraw.Type,
) {
  const selected = Option.getOrThrow(Arr.get(model.cards, event.card % model.cards.length))
  const result = yield* Effect.result(
    (yield* ApprovalStore).withdraw(test[event.person], selected.approval.id),
  )
  if (selected.person !== event.person || (!model.shared && event.person === 'second')) {
    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(NotFound)
    return model
  }
  if (selected.state !== 'Pending') {
    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(Conflict)
    return model
  }
  expect(Result.getOrThrow(result)).toBe(test.threadId)
  return {
    ...model,
    cards: Arr.map(model.cards, (entry) =>
      entry === selected ? { ...entry, state: 'Withdrawn' as const } : entry,
    ),
  }
})

/** The oracle advances from commands and successful receipts, never from a stored status. */
const step = (test: People, model: Model, event: Command) =>
  Command.match<
    Effect.Effect<
      Model,
      Effect.Error<ReturnType<ThreadStore['Service']['share']>>,
      ApprovalStore | ThreadStore | Database
    >
  >(event, {
    Propose: (value) => propose(test, model, value),
    Decide: (value) => decide(test, model, value),
    Withdraw: (value) => withdraw(test, model, value),
    Share: ({ shared }) =>
      Effect.gen(function* () {
        yield* (yield* ThreadStore).share(
          test.first.person.id,
          test.threadId,
          shared
            ? ShareThreadRequest.cases.Company.make({})
            : ShareThreadRequest.cases.Private.make({}),
        )
        return { ...model, shared }
      }),
    Run: (value) =>
      moveRun(test, model.turn + 1, value).pipe(
        Effect.map((run) => ({ ...model, run, turn: model.turn + 1 })),
      ),
    Replay: () =>
      Effect.gen(function* () {
        yield* (yield* ApprovalStore).replay
        return model
      }),
  })

/** Check every observable invariant after every command, including refused and ignored commands. */
const verify = Effect.fn('AuthorityTest.verify')(function* (test: People, model: Model) {
  const store = yield* ApprovalStore
  const observed = yield* Observation
  // Commands have settled before these independent reads; parallel reads keep SQL latency bounded.
  const { records, inboxes, elsewhere, executions, deliveries } = yield* Effect.all(
    {
      records: store.inThread(test.threadId),
      inboxes: Effect.all(
        { first: store.inbox(test.first), second: store.inbox(test.second) },
        { concurrency: 'unbounded' },
      ),
      elsewhere: store.inbox(test.elsewhere),
      executions: Ref.get(observed.executions),
      deliveries: Ref.get(observed.deliveries),
    },
    { concurrency: 'unbounded' },
  )
  expect(records).toHaveLength(model.cards.length)
  for (const entry of model.cards) {
    expect(records).toContainEqual(
      expect.objectContaining({
        id: entry.approval.id,
        threadId: test.threadId,
        askedOf: expect.objectContaining({ id: test[entry.person].person.id }),
        runId: ActionOrigin.match(entry.origin, {
          Run: ({ runId }) => runId,
          RuntimeThread: () => null,
        }),
        state: expect.objectContaining({ _tag: entry.state }),
      }),
    )
  }
  for (const person of Person.literals) {
    const inbox = inboxes[person]
    const visible = model.cards.filter(
      (entry) =>
        entry.person === person &&
        entry.state === 'Pending' &&
        (person === 'first' || model.shared),
    )
    expect(
      Arr.sort(
        inbox.map((entry) => entry.id),
        Order.String,
      ),
    ).toEqual(
      Arr.sort(
        visible.map((entry) => entry.approval.id),
        Order.String,
      ),
    )
  }
  expect(elsewhere).toEqual([])
  expect(executions).toEqual(model.executions)
  expect(deliveries).toEqual(
    model.deliveries.map((entry) =>
      expect.objectContaining({
        threadId: test.threadId,
        personId: test[entry.card.person].person.id,
        speaker: DeliverySpeaker.cases.Decider.make({ personId: test[entry.person].person.id }),
        idempotencyKey: `approval-${entry.card.approval.id}`,
      }),
    ),
  )
})

/** A pending browser request makes the ownership boundary reachable even in a one-command shrink. */
const sequence = Effect.fn('AuthorityTest.sequence')(function* (events: ReadonlyArray<Command>) {
  const test = yield* twoPeople()
  const run = yield* moveRun(test, 1, Command.cases.Run.make({ person: 'first', admitted: true }))
  const approval = yield* (yield* ApprovalStore).raise(
    { ...test.first, by: 'vivid', threadId: Option.some(test.threadId) },
    browser,
  )
  let model: Model = {
    shared: true,
    run,
    turn: 1,
    cards: [
      {
        approval,
        person: 'first',
        target: 'browser',
        state: 'Pending',
        origin: ActionOrigin.cases.Run.make({ threadId: test.threadId, runId: run.id }),
      },
    ],
    executions: [],
    deliveries: [],
  }
  yield* verify(test, model)
  for (const event of events) {
    model = yield* step(test, model, event)
    yield* verify(test, model)
  }
  // Every generated Run replacement is followed by a decision on the original capability, so
  // passing streams prove its frozen authority even when they never generate their own decision.
  if (events.some(Command.guards.Run)) {
    model = yield* step(
      test,
      model,
      Command.cases.Decide.make({
        person: 'first',
        decision: 'allow',
        card: model.cards.length - 1,
        changedDigest: false,
      }),
    )
    yield* verify(test, model)
  }
})

layer(testDatabaseLayer, { excludeTestServices: true })((it) => {
  describe.skipIf(!testDatabaseConfigured)('Generated Approval authority lifecycle', () => {
    // 58475 includes a participant's valid denial; 20261022 exposes the historical browser-owner bug.
    for (const seed of [20261021, 31913, 58475, 20261022]) {
      it.effect(
        `preserves Thread, Run and Person authority after every command, seed ${seed}`,
        () =>
          checkSequences(sequences, (events) => scopedCase(services, sequence(events), 'fresh'), {
            seed,
            numRuns: 4,
          }),
      )
    }
  })
})
