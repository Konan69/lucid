import * as NodeCrypto from 'node:crypto'
import { expect } from '@effect/vitest'
import { eq, inArray } from 'drizzle-orm'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Deferred from 'effect/Deferred'
import * as Queue from 'effect/Queue'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Ref from 'effect/Ref'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import {
  ActionTarget,
  ConnectionId,
  Company,
  CompanyId,
  Person,
  PersonId,
  PersonSummary,
  ProposedAction,
  Run,
  RunId,
  RunOrigin,
  RunState,
  ThreadId,
  Workspace,
  RuleScope,
  type Rule,
  RuntimeUnavailable,
  Conflict,
  DatabaseFailure,
} from '@vivid/contracts'
import { type Actor, summaryOf } from '../auth/access.ts'
import { Review } from './policy.ts'
import { Reviewer } from './review.ts'
import { personTable } from '../auth/tables.ts'
import { auditLayer } from '../audit/record.ts'
import { companyTable, membershipTable } from '../companies/tables.ts'
import { Database } from '../database/client.ts'
import { testDatabaseLayer } from '../database/testdb.ts'
import { inputStoreLayer } from '../inputs/store.ts'
import { Changes, type Topic } from '../live/changes.ts'
import { Notifier, type Notice } from '../notifications/notifier.ts'
import { RuleJudge, RulesNotJudged } from '../rules/judge.ts'
import { ruleStoreLayer } from '../rules/store.ts'
import { Conversation, type Delivery } from '../threads/conversation.ts'
import { threads } from '../threads/tables.ts'
import { ActionOrigin, ActionOutcome, ActionRunner, gateLayer, type ProposalActor } from './gate.ts'
import { approvalStoreLayer } from './store.ts'

const Judgment = Schema.TaggedUnion({
  All: {},
  None: {},
  Failed: {},
  Hostile: {},
  PersonalFailure: {},
})
type Judgment = typeof Judgment.Type

interface ObservationService {
  readonly actions: Ref.Ref<ReadonlyArray<ProposedAction>>
  readonly deliveries: Ref.Ref<ReadonlyArray<Delivery>>
  readonly notices: Ref.Ref<ReadonlyArray<Notice>>
  readonly topics: Ref.Ref<ReadonlyArray<Topic>>
  readonly judgment: Ref.Ref<Judgment>
  /** What the reviewer port answers next; the default is an unasked action that reaches others. */
  readonly review: Ref.Ref<Review>
  readonly reviewCalls: Ref.Ref<ReadonlyArray<ProposedAction>>
  readonly outcome: Ref.Ref<ActionOutcome>
  readonly judgeCalls: Ref.Ref<ReadonlyArray<ReadonlyArray<Rule>>>
  readonly runnerDefect: Ref.Ref<boolean>
  readonly changesDefect: Ref.Ref<boolean>
  readonly deliveryGate: Ref.Ref<Option.Option<Deferred.Deferred<void>>>
  readonly admissionStarted: Queue.Queue<void>
  readonly deliveryDefect: Ref.Ref<boolean>
  readonly deliveryFailure: Ref.Ref<Option.Option<RuntimeUnavailable | Conflict | DatabaseFailure>>
}
export class Observation extends Context.Service<Observation, ObservationService>()(
  'vivid/TrustTestObservation',
) {}

/** These ports record real store orchestration; PostgreSQL, audit, policy and claims stay production. */
const ports = Layer.effectContext(
  Effect.gen(function* () {
    const state = Observation.of({
      actions: yield* Ref.make<ReadonlyArray<ProposedAction>>([]),
      deliveries: yield* Ref.make<ReadonlyArray<Delivery>>([]),
      notices: yield* Ref.make<ReadonlyArray<Notice>>([]),
      topics: yield* Ref.make<ReadonlyArray<Topic>>([]),
      judgeCalls: yield* Ref.make<ReadonlyArray<ReadonlyArray<Rule>>>([]),
      runnerDefect: yield* Ref.make(false),
      judgment: yield* Ref.make<Judgment>(Judgment.cases.All.make({})),
      review: yield* Ref.make<Review>(
        Review.cases.Reviewed.make({ asked: 0, beyond: 0.9, contained: 0.02 }),
      ),
      reviewCalls: yield* Ref.make<ReadonlyArray<ProposedAction>>([]),
      outcome: yield* Ref.make<ActionOutcome>(
        ActionOutcome.cases.Succeeded.make({ result: 'Done' }),
      ),
      changesDefect: yield* Ref.make(false),
      deliveryGate: yield* Ref.make<Option.Option<Deferred.Deferred<void>>>(Option.none()),
      admissionStarted: yield* Queue.unbounded<void>(),
      deliveryDefect: yield* Ref.make(false),
      deliveryFailure: yield* Ref.make<
        Option.Option<RuntimeUnavailable | Conflict | DatabaseFailure>
      >(Option.none()),
    })
    const judge = RuleJudge.of({
      /** Tests control only the applicability port; the gate's policy remains production code. */
      judge: Effect.fn('TrustTest.judge')(function* (_action, rules) {
        yield* Ref.update(state.judgeCalls, (calls) => calls.concat([rules]))
        if (rules.length === 0) return []
        const judgment = yield* Ref.get(state.judgment)
        if (
          Judgment.guards.PersonalFailure(judgment) &&
          rules.some((rule) => RuleScope.guards.Personal(rule.scope))
        )
          return yield* Effect.fail(new RulesNotJudged({}))
        if (
          Judgment.guards.Hostile(judgment) &&
          rules.some((rule) => RuleScope.guards.Personal(rule.scope))
        )
          return rules.filter((rule) => RuleScope.guards.Personal(rule.scope))
        if (Judgment.guards.Failed(judgment)) return yield* Effect.fail(new RulesNotJudged({}))
        return Judgment.guards.None(judgment) ? [] : rules
      }),
    })
    const reviewer = Reviewer.of({
      /** Tests set the two measurements; `policy.ts` and the gate's precedence stay production. */
      review: Effect.fn('TrustTest.review')(function* (_actor, action) {
        yield* Ref.update(state.reviewCalls, (calls) => calls.concat([action]))
        return yield* Ref.get(state.review)
      }),
    })
    const runner = ActionRunner.of({
      /** Every execution is observable, so races are checked against the actual claim boundary. */
      run: Effect.fn('TrustTest.run')(function* ({ action }) {
        yield* Ref.update(state.actions, (actions) => actions.concat([action]))
        if (yield* Ref.get(state.runnerDefect)) return yield* Effect.die('Injected runner defect')
        return yield* Ref.get(state.outcome)
      }),
    })
    const conversation = Conversation.of({
      /** The replay worker admits immediately; injected failures leave real SQL debt behind. */
      admit: Effect.fn('TrustTest.admit')(function* (delivery) {
        if (yield* Ref.get(state.deliveryDefect))
          return yield* Effect.die('Injected delivery crash')
        yield* Queue.offer(state.admissionStarted, undefined)
        const gate = yield* Ref.get(state.deliveryGate)
        if (Option.isSome(gate)) yield* Deferred.await(gate.value)
        yield* Ref.update(state.deliveries, (deliveries) => deliveries.concat([delivery]))
        const failure = yield* Ref.get(state.deliveryFailure)
        if (Option.isSome(failure)) return yield* Effect.fail(failure.value)
        return {
          runId: RunId.make(`test-${delivery.idempotencyKey}`),
          offset: '0',
          incarnation: 'test',
        }
      }),
      /** Delivery returns a test Run while recording the exact signal and idempotency key. */
      deliver: Effect.fn('TrustTest.deliver')(function* (delivery) {
        yield* Ref.update(state.deliveries, (deliveries) => deliveries.concat([delivery]))
        const failure = yield* Ref.get(state.deliveryFailure)
        if (Option.isSome(failure)) return yield* Effect.fail(failure.value)
        return Run.make({
          id: RunId.make(NodeCrypto.randomUUID()),
          threadId: delivery.threadId,
          // This receipt is never persisted; only stored Runs allocate a per-Thread turn.
          turn: 1,
          origin: RunOrigin.cases.Decision.make({
            person: PersonSummary.make({ id: delivery.personId, name: 'Test Person', image: null }),
          }),
          state: RunState.cases.Working.make({}),
          startedAt: yield* Clock.currentTimeMillis,
        })
      }),
    })
    const notifier = Notifier.of({
      /** Notifications expose addressing and workspace without faking notification persistence. */
      notify: Effect.fn('TrustTest.notify')(function* (notice) {
        yield* Ref.update(state.notices, (notices) => notices.concat([notice]))
      }),
    })
    const changes = Changes.of({
      publish: Effect.fn('TrustTest.publish')(function* (topics) {
        if (yield* Ref.get(state.changesDefect)) yield* Effect.die('Injected crash after recording')
        yield* Ref.update(state.topics, (previous) => previous.concat(topics))
      }),
      subscribe: () => Effect.succeed(Stream.never),
    })
    return Context.make(Observation, state).pipe(
      Context.add(RuleJudge, judge),
      Context.add(Reviewer, reviewer),
      Context.add(ActionRunner, runner),
      Context.add(Conversation, conversation),
      Context.add(Notifier, notifier),
      Context.add(Changes, changes),
    )
  }),
)

const foundation = auditLayer.pipe(Layer.provideMerge(testDatabaseLayer), Layer.provideMerge(ports))
const policy = ruleStoreLayer.pipe(Layer.provideMerge(foundation))
/** Production stores over the test ports, for a test that composes the gate with other production Layers. */
export const stores = Layer.merge(approvalStoreLayer, inputStoreLayer).pipe(
  Layer.provideMerge(policy),
)
export const trustTestLayer = gateLayer.pipe(Layer.provideMerge(stores))

/** Teardown uses the same live adapter while its Layer is still scoped, and cleanup faults fail tests. */
const cleanup = Effect.fn('TrustTest.cleanup')(function* (
  database: Database['Service'],
  people: ReadonlyArray<PersonId>,
  companyId: CompanyId,
) {
  const result = yield* Effect.result(
    Effect.gen(function* () {
      yield* database.run(database.delete(companyTable).where(eq(companyTable.id, companyId)))
      yield* database.run(database.delete(personTable).where(inArray(personTable.id, people)))
    }),
  )
  expect(Result.isSuccess(result)).toBe(true)
})

/** Each case registers cleanup before its first write and owns unique Persons, Company and Threads. */
export const fixture = Effect.fn('TrustTest.fixture')(function* () {
  const database = yield* Database
  const first = new Person({
    id: PersonId.make(NodeCrypto.randomUUID()),
    name: 'Ada',
    email: `${NodeCrypto.randomUUID()}@example.test`,
    image: null,
  })
  const second = new Person({
    id: PersonId.make(NodeCrypto.randomUUID()),
    name: 'Bayo',
    email: `${NodeCrypto.randomUUID()}@example.test`,
    image: null,
  })
  const company = new Company({
    id: CompanyId.make(NodeCrypto.randomUUID()),
    name: 'Studio',
    slug: NodeCrypto.randomUUID(),
  })
  const personalId = ThreadId.make(NodeCrypto.randomUUID())
  const companyId = ThreadId.make(NodeCrypto.randomUUID())
  const otherId = ThreadId.make(NodeCrypto.randomUUID())
  yield* Effect.addFinalizer(() => cleanup(database, [first.id, second.id], company.id))
  yield* database.run(
    database.insert(personTable).values([
      { id: first.id, name: first.name, email: first.email },
      { id: second.id, name: second.name, email: second.email },
    ]),
  )
  yield* database.run(
    database
      .insert(companyTable)
      .values({ id: company.id, name: company.name, slug: company.slug }),
  )
  yield* database.run(
    database.insert(membershipTable).values([
      { id: NodeCrypto.randomUUID(), companyId: company.id, userId: first.id, role: 'member' },
      { id: NodeCrypto.randomUUID(), companyId: company.id, userId: second.id, role: 'owner' },
    ]),
  )
  const now = yield* Clock.currentTimeMillis
  yield* database.run(
    database.insert(threads).values([
      {
        id: personalId,
        title: 'Personal',
        titleSource: 'Person',
        personId: first.id,
        companyId: null,
        audience: 'private',
        updatedAt: now,
      },
      {
        id: companyId,
        title: 'Company work',
        titleSource: 'Person',
        personId: first.id,
        companyId: company.id,
        audience: 'private',
        updatedAt: now,
      },
      {
        id: otherId,
        title: 'Other personal',
        titleSource: 'Person',
        personId: second.id,
        companyId: null,
        audience: 'private',
        updatedAt: now,
      },
    ]),
  )
  const personal: ProposalActor = {
    origin: ActionOrigin.cases.Thread.make({ threadId: personalId }),
    person: first,
    workspace: Workspace.cases.Personal.make({}),
    by: 'person',
    threadId: Option.none(),
  }
  const member: ProposalActor = {
    origin: ActionOrigin.cases.Thread.make({ threadId: companyId }),
    person: first,
    workspace: Workspace.cases.Company.make({ company, role: 'member' }),
    by: 'person',
    threadId: Option.none(),
  }
  const owner: ProposalActor = {
    origin: ActionOrigin.cases.Thread.make({ threadId: companyId }),
    person: second,
    workspace: Workspace.cases.Company.make({ company, role: 'owner' }),
    by: 'person',
    threadId: Option.none(),
  }
  const other: ProposalActor = {
    origin: ActionOrigin.cases.Thread.make({ threadId: otherId }),
    person: second,
    workspace: Workspace.cases.Personal.make({}),
    by: 'person',
    threadId: Option.none(),
  }
  return {
    personal,
    member,
    owner,
    other,
    personalId,
    companyId,
    otherId,
    vivid: { ...personal, by: 'vivid', threadId: Option.some(personalId) } satisfies Actor,
    companyVivid: { ...member, by: 'vivid', threadId: Option.some(companyId) } satisfies Actor,
    summary: summaryOf(first),
  }
})

export const connectionAction = ProposedAction.make({
  summary: 'Update a project',
  rationale: 'Keep work current',
  effect: 'write',
  target: ActionTarget.cases.Connection.make({
    connectionId: ConnectionId.make('test-connection'),
    account: 'Work account',
    tool: 'update_project',
    input: { project: 'private tool value' },
  }),
})
export const commandAction = ProposedAction.make({
  summary: 'List working files',
  rationale: 'Inspect work',
  effect: 'write',
  target: ActionTarget.cases.Command.make({ command: 'ls' }),
})
export const JudgmentMode = Judgment
