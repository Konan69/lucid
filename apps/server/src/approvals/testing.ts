import * as NodeCrypto from 'node:crypto'
import { expect } from '@effect/vitest'
import { eq, inArray } from 'drizzle-orm'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
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
  RuntimeUnavailable,
} from '@vivid/contracts'
import { type Actor, summaryOf } from '../auth/access.ts'
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
import { ActionOutcome, ActionRunner, gateLayer } from './gate.ts'
import { approvalStoreLayer } from './store.ts'

const Judgment = Schema.TaggedUnion({ All: {}, None: {}, Failed: {} })
type Judgment = typeof Judgment.Type

interface ObservationService {
  readonly actions: Ref.Ref<ReadonlyArray<ProposedAction>>
  readonly deliveries: Ref.Ref<ReadonlyArray<Delivery>>
  readonly notices: Ref.Ref<ReadonlyArray<Notice>>
  readonly topics: Ref.Ref<ReadonlyArray<Topic>>
  readonly judgment: Ref.Ref<Judgment>
  readonly outcome: Ref.Ref<ActionOutcome>
  readonly deliveryFailure: Ref.Ref<Option.Option<RuntimeUnavailable>>
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
      judgment: yield* Ref.make<Judgment>(Judgment.cases.All.make({})),
      outcome: yield* Ref.make<ActionOutcome>(
        ActionOutcome.cases.Succeeded.make({ result: 'Done' }),
      ),
      deliveryFailure: yield* Ref.make<Option.Option<RuntimeUnavailable>>(Option.none()),
    })
    const judge = RuleJudge.of({
      /** Tests control only the applicability port; the gate's policy remains production code. */
      judge: Effect.fn('TrustTest.judge')(function* (_action, rules) {
        const judgment = yield* Ref.get(state.judgment)
        if (Judgment.guards.Failed(judgment)) return yield* Effect.fail(new RulesNotJudged({}))
        return Judgment.guards.None(judgment) ? [] : rules
      }),
    })
    const runner = ActionRunner.of({
      /** Every execution is observable, so races are checked against the actual claim boundary. */
      run: Effect.fn('TrustTest.run')(function* ({ action }) {
        yield* Ref.update(state.actions, (actions) => actions.concat([action]))
        return yield* Ref.get(state.outcome)
      }),
    })
    const conversation = Conversation.of({
      /** Gateway admission is outside this lane; refuse accidental use by a trust test. */
      admit: () =>
        Effect.fail(
          new RuntimeUnavailable({ message: 'Gateway admission is outside trust tests' }),
        ),
      /** Delivery returns a test Run while recording the exact signal and idempotency key. */
      deliver: Effect.fn('TrustTest.deliver')(function* (delivery) {
        yield* Ref.update(state.deliveries, (deliveries) => deliveries.concat([delivery]))
        const failure = yield* Ref.get(state.deliveryFailure)
        if (Option.isSome(failure)) return yield* Effect.fail(failure.value)
        return Run.make({
          id: RunId.make(NodeCrypto.randomUUID()),
          threadId: delivery.threadId,
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
        yield* Ref.update(state.topics, (previous) => previous.concat(topics))
      }),
      subscribe: () => Effect.succeed(Stream.never),
    })
    return Context.make(Observation, state).pipe(
      Context.add(RuleJudge, judge),
      Context.add(ActionRunner, runner),
      Context.add(Conversation, conversation),
      Context.add(Notifier, notifier),
      Context.add(Changes, changes),
    )
  }),
)

const foundation = auditLayer.pipe(Layer.provideMerge(testDatabaseLayer), Layer.provideMerge(ports))
const policy = ruleStoreLayer.pipe(Layer.provideMerge(foundation))
const stores = Layer.merge(approvalStoreLayer, inputStoreLayer).pipe(Layer.provideMerge(policy))
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
        personId: first.id,
        companyId: null,
        audience: 'private',
        updatedAt: now,
      },
      {
        id: companyId,
        title: 'Company work',
        personId: first.id,
        companyId: company.id,
        audience: 'private',
        updatedAt: now,
      },
      {
        id: otherId,
        title: 'Other personal',
        personId: second.id,
        companyId: null,
        audience: 'private',
        updatedAt: now,
      },
    ]),
  )
  const personal: Actor = {
    person: first,
    workspace: Workspace.cases.Personal.make({}),
    by: 'person',
    threadId: Option.none(),
  }
  const member: Actor = {
    person: first,
    workspace: Workspace.cases.Company.make({ company, role: 'member' }),
    by: 'person',
    threadId: Option.none(),
  }
  const owner: Actor = {
    person: second,
    workspace: Workspace.cases.Company.make({ company, role: 'owner' }),
    by: 'person',
    threadId: Option.none(),
  }
  const other: Actor = {
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
