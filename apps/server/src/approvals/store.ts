import * as NodeCrypto from 'node:crypto'
import * as Array from 'effect/Array'
import * as Result from 'effect/Result'
import { and, asc, eq, gt, lt, lte, sql } from 'drizzle-orm'
import { createSelectSchema } from 'drizzle-orm/effect-schema'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Struct from 'effect/Struct'
import {
  Approval,
  ApprovalDecision,
  ApprovalId,
  ApprovalState,
  AuditEvent,
  CompanyId,
  Conflict,
  DatabaseFailure,
  NotFound,
  InvalidRequest,
  ActionTarget,
  PersonId,
  ProposedAction,
  RunId,
  ThreadId,
  type DecideApprovalRequest,
  type PersonSummary,
} from '@vivid/contracts'
import { companyColumnOf, loadSummaries, ownedHere, type Actor } from '../auth/access.ts'
import { Audit, AuditAttribution, recordAudit } from '../audit/record.ts'
import {
  Database,
  decodeStored,
  returned,
  type DatabaseInfrastructureError,
} from '../database/client.ts'
import { changed, Topic, Changes } from '../live/changes.ts'
import { Notifier } from '../notifications/notifier.ts'
import { RuleStore } from '../rules/store.ts'
import { requireThread } from '../threads/access.ts'
import { threads } from '../threads/tables.ts'
import { Conversation, DeliveryMessage } from '../threads/conversation.ts'
import { ActionOutcome, ActionRunner } from './gate.ts'
import { actionDigest, auditAction } from './action.ts'
import { approvals } from './tables.ts'
import { Signal, encodeSignal } from './signal.ts'
import { replaySignals } from './replay.ts'

const fields = createSelectSchema(approvals, {
  id: ApprovalId,
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  personId: PersonId,
  companyId: Schema.NullOr(CompanyId),
  action: ProposedAction,
  signal: Signal,
}).fields
const undecided = { decidedBy: Schema.Null, decidedAt: Schema.Null }
const decided = { decidedBy: PersonId, decidedAt: Schema.Number }
const unfinished = { finishedAt: Schema.Null, outcome: Schema.Null }
const finished = { finishedAt: Schema.Number, outcome: Schema.String }

/** Each stored status declares its exact columns; inconsistent historical rows fail at ingress. */
const Row = Schema.Union([
  Schema.Struct({ ...fields, status: Schema.Literal('pending'), ...undecided, ...unfinished }),
  Schema.Struct({ ...fields, status: Schema.Literal('executing'), ...decided, ...unfinished }),
  Schema.Struct({ ...fields, status: Schema.Literal('succeeded'), ...decided, ...finished }),
  Schema.Struct({ ...fields, status: Schema.Literal('failed'), ...decided, ...finished }),
  Schema.Struct({
    ...fields,
    status: Schema.Literal('unknown'),
    ...decided,
    finishedAt: Schema.Number,
    outcome: Schema.Null,
  }),
  Schema.Struct({ ...fields, status: Schema.Literal('denied'), ...decided, ...unfinished }),
  Schema.Struct({
    ...fields,
    status: Schema.Literal('expired'),
    ...undecided,
    finishedAt: Schema.Number,
    outcome: Schema.Null,
  }),
  Schema.Struct({ ...fields, status: Schema.Literal('withdrawn'), ...undecided, ...finished }),
]).pipe(Schema.toTaggedUnion('status'))
const decodeRow = decodeStored(Row, 'Approval')
const encodeAction = Schema.encodeEffect(ProposedAction)

/** A missing Person is corrupt persistence, never an invented identity on an Approval. */
const personSummary = (
  people: ReadonlyMap<PersonId, PersonSummary>,
  id: PersonId,
): Effect.Effect<PersonSummary, DatabaseFailure> => {
  const person = people.get(id)
  return person === undefined
    ? Effect.fail(new DatabaseFailure({ message: 'Approval Person is missing' }))
    : Effect.succeed(person)
}

/** This is the sole stored-status to wire-state mapping, shared by inbox, decisions and Threads. */
const stateOf = (
  row: typeof Row.Type,
  people: ReadonlyMap<PersonId, PersonSummary>,
): Effect.Effect<ApprovalState, DatabaseFailure> =>
  Row.match(row, {
    pending: (value) =>
      Effect.succeed(ApprovalState.cases.Pending.make({ expiresAt: value.expiresAt })),
    executing: (value) =>
      personSummary(people, value.decidedBy).pipe(
        Effect.map((decidedBy) =>
          ApprovalState.cases.Executing.make({ decidedBy, decidedAt: value.decidedAt }),
        ),
      ),
    succeeded: (value) =>
      personSummary(people, value.decidedBy).pipe(
        Effect.map((decidedBy) =>
          ApprovalState.cases.Succeeded.make({
            decidedBy,
            finishedAt: value.finishedAt,
            result: value.outcome,
          }),
        ),
      ),
    failed: (value) =>
      personSummary(people, value.decidedBy).pipe(
        Effect.map((decidedBy) =>
          ApprovalState.cases.Failed.make({
            decidedBy,
            finishedAt: value.finishedAt,
            reason: value.outcome,
          }),
        ),
      ),
    unknown: (value) =>
      personSummary(people, value.decidedBy).pipe(
        Effect.map((decidedBy) =>
          ApprovalState.cases.OutcomeUnknown.make({ decidedBy, finishedAt: value.finishedAt }),
        ),
      ),
    denied: (value) =>
      personSummary(people, value.decidedBy).pipe(
        Effect.map((decidedBy) =>
          ApprovalState.cases.Denied.make({ decidedBy, decidedAt: value.decidedAt }),
        ),
      ),
    expired: (value) =>
      Effect.succeed(ApprovalState.cases.Expired.make({ expiredAt: value.finishedAt })),
    withdrawn: (value) =>
      Effect.succeed(
        ApprovalState.cases.Withdrawn.make({
          withdrawnAt: value.finishedAt,
          reason: value.outcome,
        }),
      ),
  })

/** Decodes once at row ingress and batches identity lookup to avoid one query per Approval. */
const viewDecoded = Effect.fn('Approvals.viewDecoded')(function* (
  rows: ReadonlyArray<typeof Row.Type>,
) {
  const people = yield* loadSummaries(
    rows.flatMap((row) => [row.personId, ...Option.toArray(Option.fromNullishOr(row.decidedBy))]),
  )
  return yield* Effect.forEach(
    rows,
    Effect.fn('Approvals.viewOne')(function* (row) {
      return Approval.make({
        id: row.id,
        threadId: row.threadId,
        runId: row.runId,
        action: row.action,
        digest: row.digest,
        askedOf: yield* personSummary(people, row.personId),
        state: yield* stateOf(row, people),
        createdAt: row.createdAt,
      })
    }),
  )
})

/** Public reads decode storage once, then share the same state projection with background settlement. */
const view = Effect.fn('Approvals.view')(function* (
  values: ReadonlyArray<typeof approvals.$inferSelect>,
) {
  return yield* viewDecoded(yield* Effect.forEach(values, decodeRow))
})

export interface ApprovalStoreService {
  readonly inThread: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<Approval>, DatabaseInfrastructureError>
  readonly inbox: (
    actor: Actor,
  ) => Effect.Effect<ReadonlyArray<Approval>, DatabaseInfrastructureError>
  readonly raise: (
    actor: Actor,
    action: ProposedAction,
  ) => Effect.Effect<Approval, NotFound | DatabaseInfrastructureError>
  readonly decide: (
    actor: Actor,
    request: DecideApprovalRequest,
  ) => Effect.Effect<Approval, NotFound | Conflict | InvalidRequest | DatabaseInfrastructureError>
  readonly withdraw: (
    actor: Actor,
    id: ApprovalId,
  ) => Effect.Effect<ThreadId, NotFound | Conflict | DatabaseInfrastructureError>
  readonly replay: () => Effect.Effect<void, DatabaseInfrastructureError>
  readonly expire: () => Effect.Effect<void, DatabaseInfrastructureError>
}
export class ApprovalStore extends Context.Service<ApprovalStore, ApprovalStoreService>()(
  'vivid/ApprovalStore',
) {}

/** A claim lives in the requester's workspace and only its addressed Person can touch it. */
const claim = Effect.fn('Approvals.claim')(function* (
  actor: Actor,
  request: DecideApprovalRequest,
) {
  const database = yield* Database
  const scope = eq(approvals.id, request.id)
  const values = yield* database.run(database.select().from(approvals).where(scope).limit(1))
  const value = values[0]
  if (value === undefined)
    return yield* Effect.fail(new NotFound({ message: 'Approval not found' }))
  const row = yield* decodeRow(value)
  const thread = yield* requireThread(row.threadId, actor.person.id)
  if (row.digest !== request.digest)
    return yield* Effect.fail(new Conflict({ message: 'Approval digest differs' }))
  const now = yield* Clock.currentTimeMillis
  if (Row.guards.expired(row) || (Row.guards.pending(row) && row.expiresAt <= now))
    return yield* Effect.fail(new Conflict({ message: 'This request ran out' }))
  // Shared accounts only read, and ordinary reads never raise Approvals. A Connection Approval in
  // a shared Thread therefore uses personal authority. Re-check current reach if sharing changed.
  if (
    ApprovalDecision.guards.AlwaysAllow(request.decision) &&
    (row.action.effect === 'destructive' ||
      (ActionTarget.guards.Connection(row.action.target) && thread.audience !== 'private'))
  ) {
    return yield* Effect.fail(
      new InvalidRequest({ message: 'This kind of action is always asked about' }),
    )
  }
  const rows = yield* database.run(
    database
      .update(approvals)
      .set({
        status: ApprovalDecision.guards.Deny(request.decision) ? 'denied' : 'executing',
        decidedBy: actor.person.id,
        decidedAt: now,
        signal: encodeSignal(decisionSignal(row, request.decision, actor.person.id)),
        signalDueAt: now,
      })
      .where(
        and(
          scope,
          eq(approvals.digest, request.digest),
          eq(approvals.status, 'pending'),
          gt(approvals.expiresAt, now),
        ),
      )
      .returning(),
  )
  const claimed = rows[0]
  if (claimed === undefined)
    return yield* Effect.fail(new Conflict({ message: 'Approval already decided' }))
  return yield* decodeRow(claimed)
})

/** Only terminal outcomes have a signal body; execution first records an Awaiting debt. */
const Conclusion = Schema.Union([
  ApprovalState.cases.Denied.mapFields(Struct.pick(['_tag'])),
  ApprovalState.cases.Expired.mapFields(Struct.pick(['_tag'])),
  ApprovalState.cases.Succeeded.mapFields(Struct.pick(['_tag', 'result'])),
  ApprovalState.cases.Failed.mapFields(Struct.pick(['_tag', 'reason'])),
  ApprovalState.cases.OutcomeUnknown.mapFields(Struct.pick(['_tag'])),
]).pipe(Schema.toTaggedUnion('_tag'))

/** The decision and eventual settlement share one runtime delivery identity. */
const approvalKey = (id: ApprovalId) => `approval-${id}`

/** Freeze the outcome text in the settlement write so no later projection is needed for replay. */
const owed = (
  id: ApprovalId,
  summary: string,
  conclusion: typeof Conclusion.Type,
  deciderId: PersonId | null,
) => {
  const body = Conclusion.match(conclusion, {
    Expired: () => `Expired: ${summary}. This request ran out. The action was not run.`,
    Denied: () => `Denied: ${summary}. The action was not run.`,
    Succeeded: ({ result }) => `Approved: ${summary}. Result: ${result.slice(0, 4000)}`,
    Failed: ({ reason }) => `Approved: ${summary}. Failed: ${reason.slice(0, 4000)}`,
    OutcomeUnknown: () =>
      `Approved: ${summary}. The outcome is unknown. Check the service; never retry this action automatically.`,
  })
  return Signal.cases.Owed.make({
    idempotencyKey: approvalKey(id),
    deciderId,
    message: DeliveryMessage.cases.Signal.make({
      type: 'approval',
      body,
      attributes: {
        approval: id,
        outcome: Conclusion.guards.Expired(conclusion) ? 'expired' : conclusion._tag,
      },
    }),
  })
}

/** A refusal already knows its result; permission owes the result of the once-only action. */
const decisionSignal = (row: typeof Row.Type, decision: ApprovalDecision, deciderId: PersonId) =>
  ApprovalDecision.guards.Deny(decision)
    ? owed(row.id, row.action.summary, Conclusion.cases.Denied.make({}), deciderId)
    : Signal.cases.Awaiting.make({ idempotencyKey: approvalKey(row.id) })

/** Request delivery is only an optimization; all failures leave the SQL debt for the sweeper. */
const deliver = Effect.fn('Approvals.deliver')(function* (id: ApprovalId) {
  yield* replaySignals(approvals, Option.some([id])).pipe(
    Effect.catch(() => Effect.logError('Approval outcome replay failed', { approvalId: id })),
  )
})

type StoredOutcome = Pick<typeof approvals.$inferSelect, 'status' | 'outcome'>

/** Once executing, only the recorded outcome may settle this Approval; there is no retry path. */
const finish = Effect.fn('Approvals.finish')(function* (
  actor: Actor,
  row: typeof Row.Type,
  outcome: ActionOutcome,
) {
  const database = yield* Database
  const ending = ActionOutcome.match(outcome, {
    Succeeded: ({ result }): StoredOutcome => ({ status: 'succeeded', outcome: result }),
    Failed: ({ reason }): StoredOutcome => ({ status: 'failed', outcome: reason }),
    Unknown: (): StoredOutcome => ({
      status: 'unknown',
      outcome: null,
    }),
  })
  const conclusion = ActionOutcome.match<typeof Conclusion.Type>(outcome, {
    Succeeded: ({ result }) => Conclusion.cases.Succeeded.make({ result }),
    Failed: ({ reason }) => Conclusion.cases.Failed.make({ reason }),
    Unknown: () => Conclusion.cases.OutcomeUnknown.make({}),
  })
  const now = yield* Clock.currentTimeMillis
  const rows = yield* database.run(
    database
      .update(approvals)
      .set({
        ...ending,
        finishedAt: now,
        signal: encodeSignal(owed(row.id, row.action.summary, conclusion, row.decidedBy)),
        signalDueAt: now,
      })
      .where(
        and(
          eq(approvals.decidedBy, actor.person.id),
          eq(approvals.id, row.id),
          eq(approvals.status, 'executing'),
        ),
      )
      .returning(),
  )
  return yield* returned(rows, 'Approval outcome')
})

/** Denials settle immediately; approvals execute the stored action exactly once after the SQL claim. */
const decide = Effect.fn('Approvals.decide')(function* (
  actor: Actor,
  request: DecideApprovalRequest,
) {
  const row = yield* claim(actor, request)
  yield* changed(actor, Topic.thread(row.threadId))
  const audit = yield* Audit
  const event = auditAction(row.action)
  const decisionActor: Actor = { ...actor, threadId: Option.some(row.threadId) }
  if (ApprovalDecision.guards.Deny(request.decision)) {
    yield* audit.record(decisionActor, AuditEvent.cases.ActionDenied.make(event))
    const approval = yield* returned(yield* view([row]), 'Approval')
    yield* deliver(approval.id)
    return approval
  }
  if (ApprovalDecision.guards.AlwaysAllow(request.decision)) {
    yield* (yield* RuleStore).allow(decisionActor, row.action.summary)
  }
  const outcome = yield* (yield* ActionRunner).run({
    person: actor.person,
    workspace: actor.workspace,
    action: row.action,
  })
  const settled = yield* finish(actor, row, outcome)
  yield* changed(actor, Topic.thread(row.threadId))
  yield* audit.record(
    decisionActor,
    ActionOutcome.match(outcome, {
      Succeeded: (): AuditEvent => AuditEvent.cases.ActionApproved.make(event),
      Failed: (): AuditEvent => AuditEvent.cases.ActionFailed.make(event),
      Unknown: (): AuditEvent => AuditEvent.cases.ActionOutcomeUnknown.make(event),
    }),
  )
  const approval = yield* returned(yield* view([settled]), 'Approval')
  yield* deliver(approval.id)
  return approval
}, Effect.uninterruptible)

/** A digest-scoped transaction lock deduplicates simultaneous proposals across server processes. */
const raise = Effect.fn('Approvals.raise')(function* (actor: Actor, action: ProposedAction) {
  if (actor.by !== 'vivid' || Option.isNone(actor.threadId))
    return yield* Effect.fail(new NotFound({ message: 'Approval needs a Vivid Thread' }))
  const threadId = actor.threadId.value
  const thread = yield* requireThread(threadId, actor.person.id)
  if (thread.companyId !== companyColumnOf(actor.workspace))
    return yield* Effect.fail(new NotFound({ message: 'Thread not found in workspace' }))
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const encoded = yield* encodeAction(action).pipe(
    Effect.mapError(() => new DatabaseFailure({ message: 'Approval action could not be encoded' })),
  )
  const digest = actionDigest(encoded, threadId, actor.person.id)
  const result = yield* database.transaction((tx) =>
    Effect.gen(function* () {
      yield* tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${digest}, 0))`)
      const existing = yield* tx
        .select()
        .from(approvals)
        .where(
          and(
            ownedHere(approvals, actor),
            eq(approvals.threadId, threadId),
            eq(approvals.digest, digest),
            eq(approvals.status, 'pending'),
          ),
        )
        .limit(1)
      const previous = existing[0]
      if (previous !== undefined) return { row: previous, inserted: false }
      const rows = yield* tx
        .insert(approvals)
        .values({
          id: NodeCrypto.randomUUID(),
          threadId,
          runId: null,
          personId: actor.person.id,
          companyId: companyColumnOf(actor.workspace),
          action: encoded,
          digest,
          status: 'pending',
          expiresAt: now + 24 * 60 * 60 * 1000,
          createdAt: now,
        })
        .returning()
      return { row: yield* returned(rows, 'Approval'), inserted: true }
    }),
  )
  const approval = yield* returned(yield* view([result.row]), 'Approval')
  if (result.inserted) {
    yield* changed(actor, Topic.thread(threadId))
    yield* (yield* Notifier).notify({
      personId: actor.person.id,
      companyId: companyColumnOf(actor.workspace),
      kind: 'needs-you',
      title: 'Vivid needs your approval',
      body: action.summary,
      threadId,
      taskId: null,
    })
  }
  return approval
})

/** Recovery freezes a terminal signal under the row lock; executing actions are never re-run. */
const recover = (
  tx: Parameters<Parameters<Database['Service']['transaction']>[0]>[0],
  now: number,
) =>
  Effect.fn('Approvals.recover')(function* (value: typeof approvals.$inferSelect) {
    const row = yield* decodeRow(value)
    const ranOut = Row.guards.pending(row)
    const ending = ranOut
      ? { status: 'expired', finishedAt: now, outcome: null }
      : { status: 'unknown', finishedAt: now, outcome: null }
    const conclusion = ranOut
      ? Conclusion.cases.Expired.make({})
      : Conclusion.cases.OutcomeUnknown.make({})
    const updated = yield* tx
      .update(approvals)
      .set({
        ...ending,
        signal: encodeSignal(owed(row.id, row.action.summary, conclusion, row.decidedBy)),
        signalDueAt: now,
      })
      .where(eq(approvals.id, row.id))
      .returning()
    return yield* decodeRow(yield* returned(updated, 'Recovered Approval'))
  })

/** Conditional sweeps settle expired questions and abandoned executions; nothing is ever re-run. */
const expire = Effect.fn('Approvals.expire')(function* () {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const rows = yield* database.transaction((tx) =>
    Effect.gen(function* () {
      const expired = yield* tx
        .select()
        .from(approvals)
        .where(and(eq(approvals.status, 'pending'), lte(approvals.expiresAt, now)))
        .for('update', { skipLocked: true })
      const abandoned = yield* tx
        .select()
        .from(approvals)
        .where(
          and(eq(approvals.status, 'executing'), lt(approvals.decidedAt, now - 10 * 60 * 1000)),
        )
        .for('update', { skipLocked: true })
      return yield* Effect.forEach(expired.concat(abandoned), recover(tx, now))
    }),
  )
  yield* (yield* Changes).publish(
    rows.flatMap((row) =>
      [Topic.person(row.personId), Topic.thread(row.threadId)].concat(
        Option.toArray(Option.map(Option.fromNullishOr(row.companyId), Topic.company)),
      ),
    ),
  )
  const records = yield* viewDecoded(rows)
  // Projection preserves row order, so each outcome retains the exact persisted workspace.
  yield* Effect.forEach(
    Array.zip(records, rows),
    ([approval, row]) => settleRecovered(approval, row.companyId),
    { discard: true },
  )
})

/** Audit outages do not withhold the signal; stored attribution survives membership and workspace changes. */
const settleRecovered = Effect.fn('Approvals.settleRecovered')(
  function* (approval: Approval, companyId: CompanyId | null) {
    if (ApprovalState.guards.OutcomeUnknown(approval.state)) {
      const audit = yield* Effect.result(
        recordAudit(
          AuditAttribution.make({
            personId: approval.state.decidedBy.id,
            companyId,
            by: 'person',
            threadId: approval.threadId,
          }),
          AuditEvent.cases.ActionOutcomeUnknown.make(auditAction(approval.action)),
        ),
      )
      yield* deliver(approval.id)
      if (Result.isFailure(audit)) yield* Effect.fail(audit.failure)
    } else {
      yield* deliver(approval.id)
    }
  },
  (effect) =>
    effect.pipe(Effect.catch(() => Effect.logError('Approval recovery notification failed'))),
)

/** Acquires collaborators once; row decoding remains the sole vocabulary for every read surface. */
export const approvalStoreLayer = Layer.effect(
  ApprovalStore,
  Effect.gen(function* () {
    const database = yield* Database
    const context = yield* Effect.context<
      Database | Changes | Notifier | Audit | RuleStore | ActionRunner | Conversation
    >()
    const run = <A, E>(
      effect: Effect.Effect<
        A,
        E,
        Database | Changes | Notifier | Audit | RuleStore | ActionRunner | Conversation
      >,
    ) => Effect.provide(effect, context)
    return ApprovalStore.of({
      /** ThreadStore has already checked Thread access before requesting this complete history. */
      inThread: Effect.fn('ApprovalStore.inThread')(function* (threadId) {
        const rows = yield* database.run(
          database
            .select()
            .from(approvals)
            .where(eq(approvals.threadId, threadId))
            .orderBy(asc(approvals.createdAt), asc(approvals.id)),
        )
        return yield* run(view(rows))
      }),
      /** Pending cards need a surviving Thread; retained tombstones never appear in an inbox. */
      inbox: Effect.fn('ApprovalStore.inbox')(function* (actor) {
        const rows = yield* database.run(
          database
            .select({ approval: approvals })
            .from(approvals)
            .innerJoin(threads, eq(threads.id, approvals.threadId))
            .where(and(ownedHere(approvals, actor), eq(approvals.status, 'pending')))
            .orderBy(asc(approvals.createdAt), asc(approvals.id)),
        )
        return yield* run(view(rows.map((row) => row.approval)))
      }),
      raise: (actor, action) => run(raise(actor, action)),
      decide: (actor, request) => run(decide(actor, request)),
      /** Withdraw only pending work addressed to the caller, preserving the reason and timestamp. */
      withdraw: Effect.fn('ApprovalStore.withdraw')(function* (actor, id) {
        const scope = and(eq(approvals.id, id), ownedHere(approvals, actor))
        const found = yield* database.run(database.select().from(approvals).where(scope).limit(1))
        const value = found[0]
        if (value === undefined)
          return yield* Effect.fail(new NotFound({ message: 'Approval not found' }))
        const row = yield* decodeRow(value)
        yield* requireThread(row.threadId, actor.person.id).pipe(
          Effect.provideService(Database, database),
        )
        const rows = yield* database.run(
          database
            .update(approvals)
            .set({
              status: 'withdrawn',
              finishedAt: yield* Clock.currentTimeMillis,
              outcome: 'Withdrawn by the addressed Person',
            })
            .where(and(scope, eq(approvals.status, 'pending')))
            .returning(),
        )
        if (rows.length === 0)
          return yield* Effect.fail(new Conflict({ message: 'Approval already decided' }))
        return row.threadId
      }),
      expire: () => run(expire()),
      replay: () => run(replaySignals(approvals, Option.none())),
    })
  }),
)
