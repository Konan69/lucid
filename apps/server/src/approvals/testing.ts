import * as NodeCrypto from 'node:crypto'
import { expect } from '@effect/vitest'
import { eq, inArray } from 'drizzle-orm'
import * as Arr from 'effect/Array'
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
import { HttpClientRequest, HttpClientResponse } from 'effect/http'
import {
  ActionTarget,
  ApprovalBinding,
  ConnectionId,
  Company,
  CompanyId,
  Person,
  PersonId,
  PersonSummary,
  DesktopAction,
  ProposedAction,
  Run,
  RunId,
  RuntimeSubmissionId,
  RunOrigin,
  RunState,
  ThreadId,
  Workspace,
  RuleScope,
  type Rule,
  RuntimeUnavailable,
  Conflict,
  DatabaseFailure,
  ServiceId,
} from '@vivid/contracts'
import { encodeReferences } from '../connections/records.ts'
import {
  ExecutorAppId,
  ExecutorAppOwnership,
  ExecutorBinding,
  ExecutorOwnerId,
  ExecutorReferences,
} from '../connections/executor.ts'
import { connections } from '../connections/tables.ts'
import { type Actor, summaryOf } from '../auth/access.ts'
import { Review } from './policy.ts'
import { Reviewer } from './review.ts'
import { personTable } from '../auth/tables.ts'
import { auditLayer } from '../audit/record.ts'
import { companyTable, membershipTable } from '../companies/tables.ts'
import { Database, encodeStored } from '../database/client.ts'
import { testDatabaseLayer } from '../database/testdb.ts'
import { inputStoreLayer } from '../inputs/store.ts'
import { Changes, type Topic } from '../live/changes.ts'
import { Notifier, type Notice } from '../notifications/notifier.ts'
import { RuleJudge, RulesNotJudged } from '../rules/judge.ts'
import { ruleStoreLayer } from '../rules/store.ts'
import { Conversation, StoredRunOrigin, type Delivery } from '../threads/conversation.ts'
import { runs, threads } from '../threads/tables.ts'
import { ActionOutcome, ActionRunner, gateLayer } from './gate.ts'
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
          return yield* new RulesNotJudged({})
        if (
          Judgment.guards.Hostile(judgment) &&
          rules.some((rule) => RuleScope.guards.Personal(rule.scope))
        )
          return rules.filter((rule) => RuleScope.guards.Personal(rule.scope))
        if (Judgment.guards.Failed(judgment)) return yield* new RulesNotJudged({})
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
        if (Option.isSome(failure)) return yield* failure.value
        return {
          runId: RunId.make(`test-${delivery.idempotencyKey}`),
          submissionId: RuntimeSubmissionId.make(1),
        }
      }),
      /** Delivery returns a test Run while recording the exact signal and idempotency key. */
      deliver: Effect.fn('TrustTest.deliver')(function* (delivery) {
        yield* Ref.update(state.deliveries, (deliveries) => deliveries.concat([delivery]))
        const failure = yield* Ref.get(state.deliveryFailure)
        if (Option.isSome(failure)) return yield* failure.value
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
        if (yield* Ref.get(state.changesDefect))
          return yield* Effect.die('Injected crash after recording')
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

const foundation = auditLayer.pipe(Layer.provideMerge(ports))
const policy = ruleStoreLayer.pipe(Layer.provideMerge(foundation))
/** Production stores over the test ports, for a test that composes the gate with other production Layers. */
export const storeServices = Layer.merge(approvalStoreLayer, inputStoreLayer).pipe(
  Layer.provideMerge(policy),
)
/** Stateful observations and stores are acquired per case over the suite's shared database. */
export const trustTestServices = gateLayer.pipe(Layer.provideMerge(storeServices))
/** Complete fixtures remain available to suites that compose their own dependency graph. */
export const stores = storeServices.pipe(Layer.provideMerge(testDatabaseLayer))
export const trustTestLayer = trustTestServices.pipe(Layer.provideMerge(testDatabaseLayer))

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
  // Ada's Integration: removed with her by the cleanup above, through its Person cascade.
  const connectionId = ConnectionId.make(NodeCrypto.randomUUID())
  const app = ExecutorAppId.make(`app-${connectionId}`)
  const references = ExecutorReferences.cases.Public.make({
    service: ServiceId.make('projects'),
    app,
    owner: ExecutorOwnerId.make(`p-${first.id}`),
    binding: ExecutorBinding.cases.Public.make({}),
    appOwnership: ExecutorAppOwnership.cases.Dedicated.make({}),
  })
  yield* database.run(
    database.insert(connections).values({
      id: connectionId,
      personId: first.id,
      companyId: null,
      service: references.service,
      serviceName: 'Projects',
      name: 'Work account',
      executorApp: app,
      references: yield* encodeReferences(references),
      status: 'ready',
      createdAt: now,
      updatedAt: now,
    }),
  )
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
    /** A write through Ada's own Integration, which exists for as long as this case does. */
    connectionAction: actionThrough(connectionId),
    /** What that action was prepared against: the Integration as it is signed in now. */
    bound: ApprovalBinding.make({ connectionGeneration: 0, preconditions: [] }),
    connectionId,
    companyVivid: { ...member, by: 'vivid', threadId: Option.some(companyId) } satisfies Actor,
    summary: summaryOf(first),
  }
})

/** A write through the named Integration; each fixture makes its own (`fixture().connectionAction`). */
export const actionThrough = (connectionId: ConnectionId) =>
  ProposedAction.make({
    summary: 'Update a project',
    rationale: 'Keep work current',
    effect: 'write',
    target: ActionTarget.cases.Connection.make({
      connectionId,
      account: 'Work account',
      tool: 'update_project',
      input: { project: 'private tool value' },
    }),
  })
export const desktopAction = ProposedAction.make({
  summary: 'Type the file name',
  rationale: 'Inspect work',
  effect: 'write',
  target: ActionTarget.cases.Desktop.make({
    action: DesktopAction.cases.Type.make({ text: 'notes' }),
  }),
})
export const JudgmentMode = Judgment

// Run records and conversation history for tests of what the reviewer sees as the Person's request.

const encodeOrigin = encodeStored(StoredRunOrigin, 'Run origin')

export interface RecordedRun {
  readonly id: string
  readonly personId: PersonId
  readonly origin: StoredRunOrigin
  readonly working: boolean
}

/** Run rows as admission leaves them: the record the reviewer's attribution rests on. */
export const recordRuns = Effect.fn('TrustTest.recordRuns')(function* (
  threadId: ThreadId,
  recorded: ReadonlyArray<RecordedRun>,
  after = 0,
) {
  const database = yield* Database
  const origins = yield* Effect.forEach(recorded, (run) => encodeOrigin(run.origin))
  yield* database.run(
    database.insert(runs).values(
      Arr.zip(recorded, origins).map(([run, origin], index) => ({
        id: testRunId(threadId, run.id),
        threadId,
        personId: run.personId,
        turn: after + index + 1,
        origin,
        state: run.working ? 'working' : 'completed',
        startedAt: index + 1,
        admittedAt: index + 1,
        receipt: {
          runId: testRunId(threadId, run.id),
          submissionId: String(testSubmissionId(testRunId(threadId, run.id))),
        },
      })),
    ),
  )
})

/** A test Run id, or the real derived id when the name is already one (an answer's Run). */
export const testRunId = (threadId: ThreadId, name: string) =>
  RunId.make(name.startsWith('run_') ? name : `${threadId}-${name}`)

/** Stable Person-local submission numbers let historical fixture messages join their saved receipts. */
export const testSubmissionId = (id: string) =>
  RuntimeSubmissionId.make(
    Number.parseInt(NodeCrypto.createHash('sha256').update(id).digest('hex').slice(0, 12), 16) + 1,
  )

const HistoryMessage = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  role: Schema.String,
  purpose: Schema.optionalKey(Schema.String),
  display: Schema.optionalKey(Schema.String),
  submissionId: Schema.optionalKey(Schema.String),
  signal: Schema.optionalKey(
    Schema.Struct({
      tagName: Schema.String,
      attributes: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    }),
  ),
  parts: Schema.Array(Schema.Json),
})

const decodeHistoryMessage = Schema.decodeUnknownResult(HistoryMessage)

/** Fixture wire messages use the canonical runtime projection, including its required display fields. */
export const historyMessage = (
  input: Schema.Json | typeof HistoryMessage.Encoded,
  index: number,
) => {
  // A malformed fixture cannot exercise the canonical history boundary.
  const message = Result.getOrThrow(decodeHistoryMessage(input))
  return {
    ...message,
    id: message.id === undefined ? `message-${index}` : message.id,
    purpose: message.purpose === undefined ? message.role : message.purpose,
    display: message.display === undefined ? 'visible' : message.display,
    submissionId:
      message.submissionId === undefined
        ? undefined
        : String(testSubmissionId(message.submissionId)),
    signal:
      message.signal === undefined
        ? undefined
        : {
            ...message.signal,
            attributes: message.signal.attributes === undefined ? {} : message.signal.attributes,
          },
  }
}

/** One finished text part of a message. */
export const textPart = (value: string) => [{ type: 'text', text: value, state: 'done' }]

/** A projected delivery. A signal carries its tag; a private turn carries none. */
export const delivery = (threadId: ThreadId, run: string, tagName: string | null, value: string) =>
  tagName === null
    ? {
        role: 'user',
        purpose: 'user',
        submissionId: testRunId(threadId, run),
        parts: textPart(value),
      }
    : {
        role: 'user',
        purpose: 'dispatch',
        submissionId: testRunId(threadId, run),
        signal: { tagName, attributes: { from: 'Somebody' } },
        parts: textPart(value),
      }

export const history = (
  messages: ReadonlyArray<Schema.Json | typeof HistoryMessage.Encoded>,
  settled: ReadonlyArray<string> = [],
  incarnation = 'test-runtime-incarnation',
) => ({
  read: () =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        HttpClientRequest.get('http://runtime.test/agents/vivid/thread?view=history'),
        new Response(
          JSON.stringify({
            v: 1,
            incarnation,
            messages: messages.map(historyMessage),
            working: false,
            queued: 0,
            settlements: settled.map((id) => ({
              submissionId: String(testSubmissionId(id)),
              outcome: 'completed',
            })),
          }),
          {
            headers: { 'content-type': 'application/json' },
          },
        ),
      ),
    ),
})
