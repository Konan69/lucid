import * as NodeCrypto from 'node:crypto'
import * as Array from 'effect/Array'
import * as Result from 'effect/Result'
import { and, asc, eq, gt, lt, lte, sql } from 'drizzle-orm'
import { createSelectSchema } from 'drizzle-orm/effect-schema'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import {
  Approval,
  ApprovalBinding,
  ApprovalChanged,
  ApprovalDecided,
  ApprovalDecision,
  ApprovalExpired,
  ApprovalId,
  ApprovalInvalidation,
  ApprovalPrecondition,
  ApprovalState,
  AuditEvent,
  CompanyId,
  Conflict,
  DatabaseFailure,
  NotFound,
  InvalidRequest,
  ActionReceipt,
  ActionTarget,
  PersonId,
  ProposedAction,
  RunId,
  ThreadId,
  type DecideApprovalRequest,
  type PersonSummary,
} from '@vivid/contracts'
import { Refusal, recordRefusal } from '../observability/refusal.ts'
import { companyColumnOf, loadSummaries, ownedHere, type Actor } from '../auth/access.ts'
import { Audit, AuditAttribution, recordAudit } from '../audit/record.ts'
import {
  Database,
  decodeStored,
  encodeStored,
  returned,
  type DatabaseInfrastructureError,
} from '../database/client.ts'
import { changed, Topic, Changes } from '../live/changes.ts'
import { announceFeed } from '../feed/changes.ts'
import { Notifier } from '../notifications/notifier.ts'
import { RuleStore } from '../rules/store.ts'
import { readableBy, requireThread } from '../threads/access.ts'
import { threads } from '../threads/tables.ts'
import { Conversation } from '../threads/conversation.ts'
import { artifacts } from '../artifacts/tables.ts'
import { connections } from '../connections/tables.ts'
import {
  usesPersonalBrowser,
  ActionOrigin,
  actionOrigin,
  ActionOutcome,
  ActionRunner,
} from './gate.ts'
import { actionDigest, auditAction, canonical, editedAction } from './action.ts'
import {
  Claim,
  claim as claimOperation,
  operationOf,
  requireNotDeclined,
  release,
  resultDigest,
  settle,
} from '../actions/journal.ts'
import { approvals } from './tables.ts'
import { Conclusion, Signal, approvalKey, encodeSignal, owed } from './signal.ts'
import { invalidatePending } from './stale.ts'
import { replaySignals, type SignalWriter } from './replay.ts'

/** Replay supplies the selection and fences; this domain owns both complete signal writes. */
const signalWriter: SignalWriter = {
  table: approvals,
  /** Claim and return the same bounded row set in one statement under the replay lease. */
  claim: Effect.fn('Approvals.claimSignals')(function* (
    database: Database['Service'],
    update: Parameters<SignalWriter['claim']>[1],
  ) {
    return yield* database.run(
      database
        .update(approvals)
        .set({ signalDueAt: update.leaseUntil, signalClaim: update.token })
        .where(update.where)
        .returning({
          id: approvals.id,
          threadId: approvals.threadId,
          personId: approvals.personId,
          signal: approvals.signal,
        }),
    )
  }),
  /** The row id and lease token prevent an expired claimant from acknowledging. */
  settle: Effect.fn('Approvals.settleSignal')(function* (
    database: Database['Service'],
    update: Parameters<SignalWriter['settle']>[1],
  ) {
    yield* database.run(
      database
        .update(approvals)
        .set({ signal: update.signal, signalDueAt: update.dueAt, signalClaim: null })
        .where(and(eq(approvals.id, update.id), eq(approvals.signalClaim, update.token))),
    )
  }),
}

const fields = createSelectSchema(approvals, {
  id: ApprovalId,
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  personId: PersonId,
  companyId: Schema.NullOr(CompanyId),
  action: ProposedAction,
  binding: Schema.NullOr(ApprovalBinding),
  invalidation: Schema.NullOr(ApprovalInvalidation),
  signal: Signal,
}).fields
const undecided = { decidedBy: Schema.Null, decidedAt: Schema.Null }
const decided = { decidedBy: PersonId, decidedAt: Schema.Finite }
const unfinished = { finishedAt: Schema.Null, outcome: Schema.Null }
const finished = { finishedAt: Schema.Finite, outcome: Schema.String }
const ended = { finishedAt: Schema.Finite, outcome: Schema.Null }
/** Only an invalidated row says why; every other row has no invalidation. */
const valid = { ...fields, invalidation: Schema.Null }

/**
 * Each stored status declares its exact columns; inconsistent historical rows fail at ingress.
 * A pending row always has its binding: the migration that added bindings closed every pending
 * row raised before them, so a pending row without one is corrupt, never an older shape.
 */
const Row = Schema.Union([
  Schema.Struct({
    ...valid,
    status: Schema.Literal('pending'),
    binding: ApprovalBinding,
    ...undecided,
    ...unfinished,
  }),
  Schema.Struct({ ...valid, status: Schema.Literal('executing'), ...decided, ...unfinished }),
  Schema.Struct({ ...valid, status: Schema.Literal('succeeded'), ...decided, ...finished }),
  Schema.Struct({ ...valid, status: Schema.Literal('failed'), ...decided, ...finished }),
  Schema.Struct({ ...valid, status: Schema.Literal('unknown'), ...decided, ...ended }),
  Schema.Struct({ ...valid, status: Schema.Literal('denied'), ...decided, ...unfinished }),
  Schema.Struct({ ...valid, status: Schema.Literal('expired'), ...undecided, ...ended }),
  Schema.Struct({ ...valid, status: Schema.Literal('withdrawn'), ...undecided, ...finished }),
  Schema.Struct({
    ...fields,
    status: Schema.Literal('invalidated'),
    invalidation: ApprovalInvalidation,
    ...undecided,
    ...ended,
  }),
]).pipe(Schema.toTaggedUnion('status'))
const decodeRow = decodeStored(Row, 'Approval')
const encodeAction = Schema.encodeEffect(ProposedAction)
const encodeBinding = encodeStored(ApprovalBinding, 'Approval binding')

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
          ApprovalState.cases.OutcomeUnknown.make({
            decidedBy,
            finishedAt: value.finishedAt,
            // The decision journaled its action under the Approval's own operation (`decide`).
            operationId: operationOf.approval(value.id),
          }),
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
    invalidated: (value) =>
      Effect.succeed(
        ApprovalState.cases.Invalidated.make({
          invalidatedAt: value.finishedAt,
          reason: value.invalidation,
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
        binding: row.binding,
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

/** Read the Thread history without capturing the execution services used to settle it. */
export const inThread = Effect.fn('ApprovalStore.inThread')(function* (threadId: ThreadId) {
  const database = yield* Database
  const rows = yield* database.run(
    database
      .select()
      .from(approvals)
      .where(eq(approvals.threadId, threadId))
      .orderBy(asc(approvals.createdAt), asc(approvals.id)),
  )
  return yield* view(rows)
})

export interface ApprovalStoreService {
  readonly inThread: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<Approval>, DatabaseInfrastructureError>
  readonly inbox: (
    actor: Actor,
  ) => Effect.Effect<ReadonlyArray<Approval>, DatabaseInfrastructureError>
  /** Raises an Approval for `action`, bound to what it was prepared against (`binding`). */
  readonly raise: (
    actor: Actor,
    action: ProposedAction,
    binding: ApprovalBinding,
  ) => Effect.Effect<Approval, NotFound | InvalidRequest | DatabaseInfrastructureError>
  readonly decide: (
    actor: Actor,
    request: DecideApprovalRequest,
  ) => Effect.Effect<
    Approval,
    | NotFound
    | Conflict
    | InvalidRequest
    | ApprovalChanged
    | ApprovalExpired
    | ApprovalDecided
    | DatabaseInfrastructureError
  >
  readonly withdraw: (
    actor: Actor,
    id: ApprovalId,
  ) => Effect.Effect<ThreadId, NotFound | Conflict | DatabaseInfrastructureError>
  readonly replay: Effect.Effect<void, DatabaseInfrastructureError>
  readonly expire: Effect.Effect<void, DatabaseInfrastructureError>
}
export class ApprovalStore extends Context.Service<ApprovalStore, ApprovalStoreService>()(
  'vivid/ApprovalStore',
) {}

/**
 * Who may decide, and what may become standing permission.
 *
 * Seeing a Thread never grants authority over someone's computer: only the Person whose computer
 * it is may approve an action on it. "Always allow" is refused for a destructive action, and for
 * anything of the Person's own (their Integration or their browser) in a Thread others can see.
 * In a Thread only they can see, the Person's own browser takes "Always allow" exactly as their
 * own Integration does: the owner decided on 4 October 2026 that a write there follows the
 * Integration table (`policy.ts#reviewOutcome`), and it was the last place still treating the
 * browser as always asked.
 */
const requireDecisionAuthority = Effect.fn('Approvals.requireDecisionAuthority')(function* (
  actor: Actor,
  row: typeof Row.Type,
  request: DecideApprovalRequest,
  audience: string,
) {
  const personalBrowser = usesPersonalBrowser(row.action)
  if (
    !ApprovalDecision.guards.Deny(request.decision) &&
    personalBrowser &&
    row.personId !== actor.person.id
  )
    return yield* new InvalidRequest({
      message: 'Only the Person whose computer was requested can approve this action',
    })
  if (
    ApprovalDecision.guards.AlwaysAllow(request.decision) &&
    (row.action.effect === 'destructive' ||
      ((personalBrowser || ActionTarget.guards.Connection(row.action.target)) &&
        audience !== 'private'))
  )
    return yield* new InvalidRequest({ message: 'This kind of action is always asked about' })
})

/**
 * The action a decision would run, encoded for the Approval's record: the one asked, or the draft
 * as the Person edited it (`AllowEdited`). An edit that is more than a draft's words is refused
 * before anything is claimed (`editedAction`).
 */
const actionToRun = Effect.fn('Approvals.actionToRun')(function* (
  row: typeof Row.Type,
  decision: ApprovalDecision,
) {
  const action = ApprovalDecision.guards.AllowEdited(decision)
    ? editedAction(row.action, decision.input)
    : Option.some(row.action)
  if (Option.isNone(action))
    return yield* new InvalidRequest({ message: 'Only the words of this draft can be changed' })
  return yield* encodeAction(action.value).pipe(
    Effect.mapError(() => new DatabaseFailure({ message: 'Approval action could not be encoded' })),
  )
})

type Transaction = Parameters<Parameters<Database['Service']['transaction']>[0]>[0]
type PendingRow = typeof Row.cases.pending.Type

/**
 * What the binding depended on that is no longer true, if anything.
 *
 * The Integration and the documents are read under share locks, taken before the claim locks the
 * Approval's own row. Every write that changes one of them locks its own record first and the
 * Approvals second (`stale.ts`), so both sides take locks in the same order and a claim racing a
 * change waits for it instead of deadlocking with it.
 */
const drift = Effect.fn('Approvals.drift')(function* (tx: Transaction, row: PendingRow) {
  if (ActionTarget.guards.Connection(row.action.target)) {
    const connectionId = row.action.target.connectionId
    const [current] = yield* tx
      .select({ generation: connections.authorizationGeneration })
      .from(connections)
      .where(eq(connections.id, connectionId))
      .for('share')
    const generation = current === undefined ? null : current.generation
    if (generation !== row.binding.connectionGeneration)
      return Option.some(
        ApprovalInvalidation.cases.ConnectionChanged.make({ connectionId, generation }),
      )
  }
  for (const precondition of row.binding.preconditions) {
    if (!ApprovalPrecondition.guards.ArtifactVersion(precondition)) continue
    const [current] = yield* tx
      .select({ version: artifacts.version })
      .from(artifacts)
      .where(eq(artifacts.id, precondition.artifactId))
      .for('share')
    const version = current === undefined ? null : current.version
    if (version !== precondition.version)
      return Option.some(
        ApprovalInvalidation.cases.ContentChanged.make({
          artifactId: precondition.artifactId,
          version,
        }),
      )
  }
  return Option.none<ApprovalInvalidation>()
})

/** Provider reads stay outside SQL locks. Only their comparison is consumed by the existing
 * claim transaction, which invalidates and owes the same fresh-ask signal as document drift.
 * A disappeared or unreadable draft/page cannot keep its old permission. Database failures
 * leave the ask pending and send nothing. Denials never contact the outside service. */
const externalDrift = Effect.fn('Approvals.externalDrift')(function* (
  actor: Actor,
  row: PendingRow,
) {
  const external = row.binding.preconditions.filter(
    ApprovalPrecondition.isAnyOf(['BrowserPage', 'MailEnvelope']),
  )
  // Inspect even an older ask with no external baseline. Newly observed terms cannot inherit
  // permission from an approval that never captured them; ordinary targets still observe [].
  const invalidation = ApprovalInvalidation.cases.ExternalStateChanged.make({
    source: ActionTarget.guards.Browser(row.action.target) ? 'BrowserPage' : 'MailEnvelope',
  })
  const current = yield* (yield* ActionRunner)
    .inspect({
      person: actor.person,
      workspace: actor.workspace,
      action: row.action,
      phase: 'Deciding',
      origin:
        row.runId === null
          ? ActionOrigin.cases.RuntimeThread.make({ threadId: row.threadId })
          : ActionOrigin.cases.Run.make({ threadId: row.threadId, runId: row.runId }),
    })
    .pipe(
      Effect.asSome,
      Effect.catchTags({
        InvalidRequest: () => Effect.succeedNone,
        NotFound: () => Effect.succeedNone,
      }),
    )
  return Option.isSome(current) && canonical(current.value) === canonical(external)
    ? Option.none<ApprovalInvalidation>()
    : Option.some(invalidation)
})

/**
 * How a claim's transaction ended: it moved the Approval out of pending; what the Approval approved
 * had changed, so it is invalidated (now, or already by the write that changed it); or another
 * decision got there first.
 */
type ClaimEnd = Data.TaggedEnum<{
  Claimed: { readonly row: typeof approvals.$inferSelect }
  Changed: {}
  Taken: {}
}>
const ClaimEnd = Data.taggedEnum<ClaimEnd>()

/** The move out of pending, when the binding still holds. One conditional UPDATE: one winner. */
const move = Effect.fn('Approvals.move')(function* (
  tx: Transaction,
  row: typeof Row.Type,
  decision: {
    readonly actor: Actor
    readonly request: DecideApprovalRequest
    readonly now: number
    /** What runs once claimed (`actionToRun`): the record says what was sent, not only asked. */
    readonly action: typeof ProposedAction.Encoded
  },
) {
  const { actor, request, now, action } = decision
  const scope = eq(approvals.id, row.id)
  const written = yield* tx
    .update(approvals)
    .set({
      status: ApprovalDecision.guards.Deny(request.decision) ? 'denied' : 'executing',
      action,
      decidedBy: actor.person.id,
      decidedAt: now,
      signal: yield* encodeSignal(decisionSignal(row, request.decision, actor.person.id)),
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
    .returning()
  const claimed = written[0]
  if (claimed !== undefined) {
    yield* announceFeed(tx, [row.threadId])
    return ClaimEnd.Claimed({ row: claimed })
  }
  // A change that closed it since it was read is a changed Approval, not a decision that won.
  const [current] = yield* tx.select({ status: approvals.status }).from(approvals).where(scope)
  return current !== undefined && current.status === 'invalidated'
    ? ClaimEnd.Changed()
    : ClaimEnd.Taken()
})

/**
 * Thread access permits decisions; Person-browser permission additionally belongs to its owner.
 *
 * Before the move out of pending, the claim checks the binding again inside its transaction:
 * a change can commit after the Approval was drawn and before the Person pressed. If the binding
 * no longer holds, the Approval is invalidated in that same transaction and the claim answers
 * `ApprovalChanged`; the invalidation commits even though the decision is refused.
 */
const claim = Effect.fn('Approvals.claim')(function* (
  actor: Actor,
  request: DecideApprovalRequest,
) {
  const database = yield* Database
  const scope = eq(approvals.id, request.id)
  const values = yield* database.run(database.select().from(approvals).where(scope).limit(1))
  const value = values[0]
  if (value === undefined) return yield* new NotFound({ message: 'Approval not found' })
  const row = yield* decodeRow(value)
  const thread = yield* requireThread(row.threadId, actor.person.id)
  if (row.digest !== request.digest)
    return yield* new Conflict({ message: 'Approval digest differs' })
  if (Row.guards.invalidated(row)) return yield* new ApprovalChanged({ id: row.id })
  const now = yield* Clock.currentTimeMillis
  if (Row.guards.expired(row) || (Row.guards.pending(row) && row.expiresAt <= now))
    return yield* new ApprovalExpired({ id: row.id })
  yield* requireDecisionAuthority(actor, row, request, thread.audience)
  const action = yield* actionToRun(row, request.decision)
  const external =
    Row.guards.pending(row) && !ApprovalDecision.guards.Deny(request.decision)
      ? yield* externalDrift(actor, row)
      : Option.none<ApprovalInvalidation>()
  const end = yield* database.transaction((tx) =>
    Effect.gen(function* () {
      const local = Row.guards.pending(row) ? yield* drift(tx, row) : Option.none()
      const changedBy = Option.isNone(local) ? external : local
      if (Option.isNone(changedBy)) return yield* move(tx, row, { actor, request, now, action })
      yield* invalidatePending(tx, scope, changedBy.value)
      return ClaimEnd.Changed()
    }),
  )
  if (ClaimEnd.$is('Changed')(end)) {
    yield* changed(actor, Topic.thread(row.threadId))
    yield* deliver(row.id)
    return yield* new ApprovalChanged({ id: row.id })
  }
  if (ClaimEnd.$is('Taken')(end)) return yield* new ApprovalDecided({ id: row.id })
  const result = yield* decodeRow(end.row)
  if (Row.guards.denied(result)) {
    // Only the winning SQL claim decides Denied; reads, delivery and repeat decisions do not.
    yield* recordRefusal(
      Refusal.cases.ApprovalDenied.make({
        effect: result.action.effect,
        target: result.action.target._tag,
      }),
    )
  }
  return result
})

/** A refusal already knows its result; permission owes the result of the once-only action. */
const decisionSignal = (row: typeof Row.Type, decision: ApprovalDecision, deciderId: PersonId) =>
  ApprovalDecision.guards.Deny(decision)
    ? owed(row.id, row.action.summary, Conclusion.cases.Denied.make({}), deciderId)
    : Signal.cases.Awaiting.make({ idempotencyKey: approvalKey(row.id) })

/** Request delivery is only an optimization; all failures leave the SQL debt for the sweeper. */
const deliver = Effect.fn('Approvals.deliver')(function* (id: ApprovalId) {
  yield* replaySignals(signalWriter, Option.some([id])).pipe(
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
  const conclusion = ActionOutcome.match<Conclusion>(outcome, {
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
        signal: yield* encodeSignal(owed(row.id, row.action.summary, conclusion, row.decidedBy)),
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

/**
 * Runs the approved action under the action journal, named by the Approval. The claim is written
 * first, so the operation exists before anything is sent. The exact act whose earlier send is still
 * unresolved in this Thread is not sent: the Approval fails with that reason. The runner's ending is
 * the adapter's word: `Succeeded` is a `Completed` receipt, `Unknown` an `Unknown` one, and a
 * failure, which sent nothing that took effect, releases the claim.
 */
const runJournaled = Effect.fn('Approvals.runJournaled')(function* <E, R>(
  row: typeof Row.Type,
  run: Effect.Effect<ActionOutcome, E, R>,
) {
  const operationId = operationOf.approval(row.id)
  const claimed = yield* claimOperation({
    id: operationId,
    threadId: row.threadId,
    runId: row.runId,
    approvalId: row.id,
    target: row.action.target,
  }).pipe(
    Effect.asSome,
    Effect.catchTag('ActionReconciliationRequired', () => Effect.succeedNone),
  )
  if (Option.isNone(claimed))
    return ActionOutcome.cases.Failed.make({
      reason:
        'The same action was sent before in this Thread and its result is not known yet, so it was not sent again.',
    })
  if (Claim.guards.Answered(claimed.value))
    return ActionReceipt.guards.Unknown(claimed.value.receipt)
      ? ActionOutcome.cases.Unknown.make({})
      : ActionOutcome.cases.Succeeded.make({ result: 'This exact action was already done.' })
  const outcome = yield* run
  const now = yield* Clock.currentTimeMillis
  yield* ActionOutcome.match(outcome, {
    Succeeded: ({ result }) =>
      settle(
        ActionReceipt.cases.Completed.make({
          operationId,
          completedAt: now,
          resultDigest: resultDigest(result),
        }),
      ),
    Failed: () => release(operationId),
    Unknown: () => settle(ActionReceipt.cases.Unknown.make({ operationId, observedAt: now })),
  })
  return outcome
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
  const outcome = yield* runJournaled(
    row,
    (yield* ActionRunner).run({
      operation: Option.some(operationOf.approval(row.id)),
      person: actor.person,
      workspace: actor.workspace,
      action: row.action,
      origin:
        row.runId === null
          ? ActionOrigin.cases.RuntimeThread.make({ threadId: row.threadId })
          : ActionOrigin.cases.Run.make({ threadId: row.threadId, runId: row.runId }),
    }),
  )
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
const raise = Effect.fn('Approvals.raise')(function* (
  actor: Actor,
  action: ProposedAction,
  bound: ApprovalBinding,
) {
  if (actor.by !== 'vivid' || Option.isNone(actor.threadId))
    return yield* new NotFound({ message: 'Approval needs a Vivid Thread' })
  const origin = yield* actionOrigin(actor)
  const threadId = actor.threadId.value
  const runId = ActionOrigin.guards.Run(origin) ? origin.runId : null
  const thread = yield* requireThread(threadId, actor.person.id)
  if (thread.companyId !== companyColumnOf(actor.workspace))
    return yield* new NotFound({ message: 'Thread not found in workspace' })
  if (action.effect !== 'read')
    yield* requireNotDeclined({ threadId, runId, target: action.target })
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const encoded = yield* encodeAction(action).pipe(
    Effect.mapError(() => new DatabaseFailure({ message: 'Approval action could not be encoded' })),
  )
  const binding = yield* encodeBinding(bound)
  const digest = actionDigest({ action: encoded, binding, threadId, personId: actor.person.id })
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
          runId,
          personId: actor.person.id,
          companyId: companyColumnOf(actor.workspace),
          action: encoded,
          digest,
          binding,
          status: 'pending',
          expiresAt: now + 24 * 60 * 60 * 1000,
          createdAt: now,
        })
        .returning()
      yield* announceFeed(tx, [threadId])
      return { row: yield* returned(rows, 'Approval'), inserted: true }
    }),
  )
  const approval = yield* returned(yield* view([result.row]), 'Approval')
  if (!result.inserted) return approval
  yield* changed(actor, Topic.thread(threadId))
  // An Approval waits on the Person wherever it was raised. One raised in a Background Thread is
  // shown on the Feed, and its notice opens the Feed (`opensAt`, `threads/place.ts`).
  yield* (yield* Notifier).notify({
    personId: actor.person.id,
    companyId: companyColumnOf(actor.workspace),
    kind: 'needs-you',
    title: 'Approval needed',
    body: action.summary,
    threadId,
    // Its push carries Allow and Decline for this Approval (`push/delivery.ts`).
    approvalId: approval.id,
  })
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
        signal: yield* encodeSignal(owed(row.id, row.action.summary, conclusion, row.decidedBy)),
        signalDueAt: now,
      })
      .where(eq(approvals.id, row.id))
      .returning()
    yield* announceFeed(tx, [row.threadId])
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
      if (Result.isFailure(audit)) return yield* audit.failure
    } else {
      yield* deliver(approval.id)
    }
  },
  (effect) =>
    effect.pipe(Effect.catch(() => Effect.logError('Approval recovery notification failed'))),
)

/** Withdraw only pending work addressed to the caller, preserving the reason and timestamp. */
const withdraw = Effect.fn('ApprovalStore.withdraw')(function* (actor: Actor, id: ApprovalId) {
  const database = yield* Database
  const scope = and(eq(approvals.id, id), ownedHere(approvals, actor))
  const found = yield* database.run(database.select().from(approvals).where(scope).limit(1))
  const value = found[0]
  if (value === undefined) return yield* new NotFound({ message: 'Approval not found' })
  const row = yield* decodeRow(value)
  yield* requireThread(row.threadId, actor.person.id).pipe(
    Effect.provideService(Database, database),
  )
  const rows = yield* database.transaction((tx) =>
    Effect.gen(function* () {
      const written = yield* tx
        .update(approvals)
        .set({
          status: 'withdrawn',
          finishedAt: yield* Clock.currentTimeMillis,
          outcome: 'Withdrawn by the addressed Person',
        })
        .where(and(scope, eq(approvals.status, 'pending')))
        .returning()
      if (written.length > 0) yield* announceFeed(tx, [row.threadId])
      return written
    }),
  )
  if (rows.length === 0) return yield* new Conflict({ message: 'Approval already decided' })
  return row.threadId
})

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
      inThread: (threadId) => run(inThread(threadId)),
      /**
       * Pending cards need a surviving Thread. Filter current reach before projection;
       * unreadable or corrupt Threads disclose nothing. Keep records for re-sharing.
       */
      inbox: Effect.fn('ApprovalStore.inbox')(function* (actor) {
        const rows = yield* database.run(
          database
            .select({ approval: approvals })
            .from(approvals)
            .innerJoin(threads, eq(threads.id, approvals.threadId))
            .where(
              and(
                ownedHere(approvals, actor),
                eq(approvals.status, 'pending'),
                readableBy(actor.person.id),
              ),
            )
            .orderBy(asc(approvals.createdAt), asc(approvals.id)),
        )
        return yield* run(view(rows.map((row) => row.approval)))
      }),
      raise: (actor, action, binding) => run(raise(actor, action, binding)),
      decide: (actor, request) => run(decide(actor, request)),
      withdraw: (actor, id) => run(withdraw(actor, id)),
      expire: run(expire()),
      replay: run(replaySignals(signalWriter, Option.none())),
    })
  }),
)
