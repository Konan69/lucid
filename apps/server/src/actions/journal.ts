import { Message } from '../observability/messages.ts'
import * as NodeCrypto from 'node:crypto'
import { and, eq, inArray, isNull, not, or, sql } from 'drizzle-orm'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import {
  ActionAbsence,
  ActionApplied,
  ActionOperation,
  ActionOperationId,
  ActionPhase,
  ActionReceipt,
  ActionReconciliation,
  ActionReconciliationRequired,
  ActionTarget,
  NotFound,
  InvalidRequest,
  ProposedAction,
  type ApprovalId,
  type PersonId,
  type ReconcileActionResponse,
  type RunId,
  type ThreadId,
  type ToolCallId,
} from '@vivid/contracts'
import { canonical } from '../approvals/action.ts'
import {
  Database,
  decodeStored,
  encodeStored,
  returned,
  type DatabaseInfrastructureError,
} from '../database/client.ts'
import { requireThread } from '../threads/access.ts'
import { actions } from './tables.ts'
import { approvals } from '../approvals/tables.ts'
import { inputRequests } from '../inputs/tables.ts'

type Transaction = Parameters<Parameters<Database['Service']['transaction']>[0]>[0]
type Row = typeof actions.$inferSelect

const encodeTarget = encodeStored(ActionTarget, 'Action target')
const decodeTarget = decodeStored(ActionTarget, 'Action target')
const encodeReceipt = encodeStored(ActionReceipt, 'Action receipt')
const decodeReceipt = decodeStored(ActionReceipt, 'Action receipt')
/** The retry deadline is private journal metadata; public reconciliation keeps its existing shape. */
const PendingAbsence = ActionReconciliation.cases.Inconclusive.pipe(
  Schema.fieldsAssign({ decidableAt: Schema.Finite }),
)
const StoredReconciliation = Schema.Union([PendingAbsence, ActionReconciliation])
const encodeReconciliation = encodeStored(StoredReconciliation, 'Action reconciliation')

/**
 * Executor's hosted call has no deadline of its own. The provider APIs Vivid calls end their
 * requests within minutes, so a write not visible ten minutes after its claim will not land.
 * This is the product's landing-window assumption, not an Executor cancellation guarantee.
 */
const LANDING_WINDOW_MS = 10 * 60 * 1000
const decodeReconciliation = decodeStored(ActionReconciliation, 'Action reconciliation')
const isApplied = Schema.is(ActionApplied)

/**
 * The trusted keys an operation is named by. A direct call is named by the runtime's own call
 * identity inside its Thread, so the runtime retrying the call finds the same row. An Approval's
 * action is named by the Approval, which runs once. A call from a program has no identity that
 * survives a retry (programs are never replayed), so it gets a fresh one.
 */
export const operationOf = {
  call: (threadId: ThreadId, call: ToolCallId) =>
    ActionOperationId.make(`call-${threadId}-${call}`),
  approval: (id: ApprovalId) => ActionOperationId.make(`approval-${id}`),
  program: () => ActionOperationId.make(`program-${NodeCrypto.randomUUID()}`),
}

/**
 * What makes two sends the same act: the Integration, tool and exact input, or the exact Computer
 * action. The account's label is left out: renaming "Gmail (Work)" does not make a send new.
 */
const fingerprintOf = Effect.fn('Actions.fingerprint')(function* (target: ActionTarget) {
  const encoded = yield* encodeTarget(target)
  const essential = ActionTarget.match<Schema.Json>(target, {
    Connection: ({ connectionId, tool, input }) => ({
      kind: 'Connection',
      connectionId,
      tool,
      input,
    }),
    Browser: () => encoded,
    Desktop: () => encoded,
  })
  return NodeCrypto.createHash('sha256').update(canonical(essential)).digest('hex')
})

/**
 * A decline holds for the proposing Run regardless of call id, summary or route. Reuse the
 * journal's fingerprint over the stored target; a later Run may ask for a fresh Approval.
 */
export const requireNotDeclined = Effect.fn('Actions.requireNotDeclined')(function* (input: {
  readonly threadId: ThreadId
  readonly runId: RunId | null
  readonly target: ActionTarget
}) {
  if (input.runId === null || !ActionTarget.guards.Connection(input.target))
    return yield* Effect.void
  const database = yield* Database
  const denied = yield* database.run(
    database
      .select({ action: approvals.action })
      .from(approvals)
      .where(
        and(
          eq(approvals.threadId, input.threadId),
          eq(approvals.runId, input.runId),
          eq(approvals.status, 'denied'),
        ),
      ),
  )
  const fingerprint = yield* fingerprintOf(input.target)
  for (const row of denied) {
    const action = yield* decodeStored(ProposedAction, 'Declined action')(row.action)
    if ((yield* fingerprintOf(action.target)) === fingerprint)
      return yield* new InvalidRequest({
        message:
          'The Person declined this action. Do not send it or ask again unless the Person asks for it in a later Run.',
      })
  }
  return yield* Effect.void
})

/** The digest a `Completed` receipt carries in place of the provider's answer. */
export const resultDigest = (result: Schema.Json) =>
  NodeCrypto.createHash('sha256').update(canonical(result)).digest('hex')

/** A row's phase: being sent until its one receipt is written. */
const phaseOf = Effect.fn('Actions.phase')(function* (row: Row) {
  if (row.receipt === null) return ActionPhase.cases.Dispatching.make({ claimedAt: row.claimedAt })
  return ActionPhase.cases.Settled.make({ receipt: yield* decodeReceipt(row.receipt) })
})

const viewOf = Effect.fn('Actions.view')(function* (row: Row) {
  return ActionOperation.make({
    id: row.id,
    threadId: row.threadId,
    runId: row.runId,
    approvalId: row.approvalId,
    target: yield* decodeTarget(row.target),
    phase: yield* phaseOf(row),
  })
})

/**
 * An operation whose effect is not known: still marked as being sent (in flight, or the server died
 * while sending) or settled `Unknown`, and not since shown either way by reconciliation.
 */
const unresolved = and(
  or(isNull(actions.receipt), sql`${actions.receipt}->>'_tag' = 'Unknown'`),
  sql`${actions.reconciliation}->>'_tag' not in ('Applied', 'NotApplied')`,
)

/**
 * What a send of `target` under `id` must answer instead of sending, if anything.
 *
 * - The same operation again (a retried call): its own receipt, or `Unknown` while it has none.
 * - An unresolved operation of the same fingerprint in this Thread: requests reconciliation.
 * - The newest same-fingerprint operation reconciled `Applied`: its receipt; it already happened.
 *
 * `retryOf` is the newest same-fingerprint operation proven `NotApplied`, which a fresh send names.
 */
const answerFor = Effect.fn('Actions.answerFor')(function* (
  tx: Transaction,
  input: {
    readonly id: ActionOperationId
    readonly threadId: ThreadId
    readonly fingerprint: string
  },
) {
  const now = yield* Clock.currentTimeMillis
  const [same] = yield* tx.select().from(actions).where(eq(actions.id, input.id))
  if (same !== undefined) {
    const phase = yield* phaseOf(same)
    const receipt = ActionPhase.match(phase, {
      Dispatching: () =>
        ActionReceipt.cases.Unknown.make({ operationId: same.id, observedAt: now }),
      Settled: ({ receipt: settled }) => settled,
    })
    return { answer: Option.some(receipt), retryOf: Option.none<ActionOperationId>() }
  }
  const scope = and(
    eq(actions.threadId, input.threadId),
    eq(actions.fingerprint, input.fingerprint),
  )
  const [open] = yield* tx.select({ id: actions.id }).from(actions).where(and(scope, unresolved))
  if (open !== undefined) return yield* new ActionReconciliationRequired({ operationId: open.id })
  const reconciled = yield* tx
    .select()
    .from(actions)
    .where(and(scope, sql`${actions.reconciliation}->>'_tag' in ('Applied', 'NotApplied')`))
    .orderBy(sql`${actions.claimedAt} desc`)
    .limit(1)
  const [newest] = reconciled
  if (newest === undefined)
    return { answer: Option.none<ActionReceipt>(), retryOf: Option.none<ActionOperationId>() }
  const reconciliation = yield* decodeReconciliation(newest.reconciliation)
  return ActionReconciliation.guards.Applied(reconciliation)
    ? { answer: Option.some<ActionReceipt>(reconciliation.receipt), retryOf: Option.none() }
    : { answer: Option.none<ActionReceipt>(), retryOf: Option.some(newest.id) }
})

/** Serializes every send of one act in one Thread; unrelated work in the Thread does not wait. */
const lockAct = (tx: Transaction, threadId: ThreadId, fingerprint: string) =>
  tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${threadId}:${fingerprint}`}, 0))`,
  )

/**
 * Checks before the Gate and reconciles an unresolved act before raising another Approval.
 * No dispatch is claimed here; `claim` decides again under the act lock.
 */
export const answerBefore = Effect.fn('Actions.answerBefore')(function* (input: {
  readonly personId: PersonId
  readonly id: ActionOperationId
  readonly threadId: ThreadId
  readonly target: ActionTarget
}) {
  const database = yield* Database
  const fingerprint = yield* fingerprintOf(input.target)
  const found = yield* afterReconciliation(
    input.personId,
    database.transaction((tx) =>
      answerFor(tx, { id: input.id, threadId: input.threadId, fingerprint }),
    ),
  )
  return found.answer
})

/** Whether the caller may send now, or must answer with what was already recorded. */
export const Claim = Schema.TaggedUnion({
  Fresh: {},
  Answered: { receipt: ActionReceipt },
})
export type Claim = typeof Claim.Type

/**
 * The conditional dispatch claim: one row per operation, written before anything is sent. Under the
 * act's lock, a repeat or an unresolved same act is answered or refused instead (`answerFor`). A
 * crash after this leaves the row `Dispatching`, which every later reader takes as uncertain.
 */
export const claim = Effect.fn('Actions.claim')(function* (input: {
  readonly personId: PersonId
  readonly id: ActionOperationId
  readonly threadId: ThreadId
  readonly runId: RunId | null
  readonly approvalId: ApprovalId | null
  readonly target: ActionTarget
}) {
  const database = yield* Database
  const fingerprint = yield* fingerprintOf(input.target)
  const target = yield* encodeTarget(input.target)
  const unchecked = yield* encodeReconciliation(ActionReconciliation.cases.Unchecked.make({}))
  const now = yield* Clock.currentTimeMillis
  return yield* afterReconciliation(
    input.personId,
    database.transaction((tx) =>
      Effect.gen(function* () {
        yield* lockAct(tx, input.threadId, fingerprint)
        const found = yield* answerFor(tx, { id: input.id, threadId: input.threadId, fingerprint })
        if (Option.isSome(found.answer))
          return Claim.cases.Answered.make({ receipt: found.answer.value })
        yield* tx.insert(actions).values({
          id: input.id,
          threadId: input.threadId,
          runId: input.runId,
          approvalId: input.approvalId,
          target,
          fingerprint,
          retryOf: Option.getOrNull(found.retryOf),
          claimedAt: now,
          receipt: null,
          reconciliation: unchecked,
        })
        return Claim.cases.Fresh.make({})
      }),
    ),
  )
})

/** Keep the actual marked request before dispatch, preserving the original act's fingerprint. */
export const retainTarget = Effect.fn('Actions.retainTarget')(function* (
  id: ActionOperationId,
  target: ActionTarget,
) {
  const database = yield* Database
  const rows = yield* database.run(
    database
      .update(actions)
      .set({ target: yield* encodeTarget(target) })
      .where(and(eq(actions.id, id), isNull(actions.receipt)))
      .returning({ id: actions.id }),
  )
  yield* returned(rows, 'Dispatching action')
})

/** A paused approved call recovers its Thread from the operation that was claimed before dispatch. */
export const originOf = Effect.fn('Actions.originOf')(function* (id: ActionOperationId) {
  const database = yield* Database
  const rows = yield* database.run(
    database
      .select({ threadId: actions.threadId, approvalId: actions.approvalId })
      .from(actions)
      .where(eq(actions.id, id))
      .limit(1),
  )
  return yield* returned(rows, 'Integration operation')
})

/** Keep the one-receipt guard inside an owning write, including an Approval invalidation transaction. */
export const settleIn = Effect.fn('Actions.settleIn')(function* (
  tx: Pick<Transaction, 'update'>,
  receipt: ActionReceipt,
) {
  yield* tx
    .update(actions)
    .set({ receipt: yield* encodeReceipt(receipt) })
    .where(and(eq(actions.id, receipt.operationId), isNull(actions.receipt)))
})

/** Writes the one receipt of a claimed operation; a second settlement changes nothing. */
export const settle = Effect.fn('Actions.settle')(function* (receipt: ActionReceipt) {
  const database = yield* Database
  yield* database.run(settleIn(database, receipt))
})

/**
 * Removes a claim whose send the provider definitely refused, or that never reached it. Nothing
 * outward happened, so there is no effect to keep a receipt of and no reason to hold a retry.
 */
export const release = Effect.fn('Actions.release')(function* (id: ActionOperationId) {
  const database = yield* Database
  yield* database.run(
    database.delete(actions).where(and(eq(actions.id, id), isNull(actions.receipt))),
  )
})

/** An operation of a Run whose effect is not known, and since when that is so. */
export interface Unresolved {
  readonly operationId: ActionOperationId
  readonly observedAt: number
}

/**
 * The unresolved operation of each listed Run, for the Run's outcome; one per Run is enough. A
 * settled `Unknown` dates from when its answer was lost; one still `Dispatching` from its claim.
 */
/**
 * An operation an Integration paused is not unheard: its Approval or question waits on the Person
 * and holds it, and the answer settles it (`connections/asks.ts`). Until that ask is settled the
 * Run says nothing about it; once it is, its real receipt applies.
 */
const heldByAsk = or(
  sql`exists (select 1 from ${approvals} where ${approvals.status} in ('pending', 'executing') and ${approvals.action}->'continuation'->>'operation' = ${actions.id})`,
  sql`exists (select 1 from ${inputRequests} where ${inputRequests.status} in ('waiting', 'answering') and ${inputRequests.integration}->'continuation'->>'operation' = ${actions.id})`,
)

export const unresolvedOf = Effect.fn('Actions.unresolvedOf')(function* (
  runIds: ReadonlyArray<RunId>,
) {
  const found = new Map<RunId, Unresolved>()
  if (runIds.length === 0) return found
  const database = yield* Database
  const rows = yield* database.run(
    database
      .select()
      .from(actions)
      .where(and(inArray(actions.runId, [...runIds]), unresolved, not(heldByAsk))),
  )
  for (const row of rows) {
    if (row.runId === null) continue
    const phase = yield* phaseOf(row)
    const observedAt = ActionPhase.match(phase, {
      Dispatching: ({ claimedAt }) => claimedAt,
      Settled: ({ receipt }) =>
        ActionReceipt.guards.Unknown(receipt) ? receipt.observedAt : row.claimedAt,
    })
    found.set(row.runId, { operationId: row.id, observedAt })
  }
  return found
})

/**
 * What a provider's own lookup says about one operation. `Unsupported` when the provider offers no
 * way to look this operation up; that can never prove absence.
 */
export const Lookup = Schema.TaggedUnion({
  Found: { receipt: ActionApplied },
  Absent: {},
  Unsupported: {},
})
export type Lookup = typeof Lookup.Type

/** The read-only provider check behind reconciliation. It must never send the operation. */
export interface ActionLookupService {
  readonly look: (operation: ActionOperation) => Effect.Effect<Lookup>
}

export class ActionLookup extends Context.Service<ActionLookup, ActionLookupService>()(
  'vivid/ActionLookup',
) {}

/** Settled with a receipt that says it happened: no provider needs asking. */
const appliedReceipt = (phase: ActionPhase) =>
  ActionPhase.match(phase, {
    Dispatching: () => Option.none<ActionApplied>(),
    Settled: ({ receipt }) => (isApplied(receipt) ? Option.some(receipt) : Option.none()),
  })

/**
 * A Person who can see the Thread asks whether an operation took effect. A definite earlier answer
 * stands; otherwise the provider's lookup is asked, read-only. Nothing is sent again here, and an
 * operation the lookup cannot place stays blocked from retry.
 */
export const reconcile = Effect.fn('Actions.reconcile')(
  function* (personId: PersonId, operationId: ActionOperationId) {
    yield* Effect.annotateCurrentSpan('vivid.operation.id', operationId)
    const database = yield* Database
    const [stored] = yield* database.run(
      database
        .select({ operation: actions, held: sql<boolean>`${heldByAsk}` })
        .from(actions)
        .where(eq(actions.id, operationId)),
    )
    if (stored === undefined) return yield* new NotFound({ message: 'Action not found' })
    const row = stored.operation
    yield* requireThread(row.threadId, personId)
    const action = yield* viewOf(row)
    const recorded = yield* decodeReconciliation(row.reconciliation)
    const settled = appliedReceipt(action.phase)
    if (Option.isSome(settled))
      return {
        action,
        reconciliation: ActionReconciliation.cases.Applied.make({ receipt: settled.value }),
      }
    if (ActionReconciliation.isAnyOf(['Applied', 'NotApplied'])(recorded))
      return { action, reconciliation: recorded }
    const checkedAt = yield* Clock.currentTimeMillis
    const decidableAt = row.claimedAt + LANDING_WINDOW_MS
    const found = yield* (yield* ActionLookup).look(action)
    // A live ask can resume later, so its age alone never proves absence.
    const reconciliation = Lookup.match<typeof StoredReconciliation.Type>(found, {
      Found: ({ receipt }) => ActionReconciliation.cases.Applied.make({ receipt }),
      Absent: () =>
        checkedAt < decidableAt || stored.held
          ? PendingAbsence.make({ checkedAt, decidableAt })
          : ActionReconciliation.cases.NotApplied.make({
              checkedAt,
              evidence: ActionAbsence.cases.ProviderLookup.make({}),
            }),
      Unsupported: () => ActionReconciliation.cases.Inconclusive.make({ checkedAt }),
    })
    const [written] = yield* database.run(
      database
        .update(actions)
        .set({ reconciliation: yield* encodeReconciliation(reconciliation) })
        .where(
          and(
            eq(actions.id, operationId),
            sql`${actions.reconciliation}->>'_tag' not in ('Applied', 'NotApplied')`,
          ),
        )
        .returning({ id: actions.id }),
    )
    if (written !== undefined) return { action, reconciliation } satisfies ReconcileActionResponse
    // A concurrent check reached a definite answer first; that stored answer stands.
    const [current] = yield* database.run(
      database
        .select({ reconciliation: actions.reconciliation })
        .from(actions)
        .where(eq(actions.id, operationId)),
    )
    if (current === undefined) return yield* new NotFound({ message: 'Action not found' })
    return {
      action,
      reconciliation: yield* decodeReconciliation(current.reconciliation),
    } satisfies ReconcileActionResponse
  },
  (effect) =>
    effect.pipe(
      Effect.tap(({ action, reconciliation }) =>
        Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan('vivid.reconciliation.outcome', reconciliation._tag)
          yield* Effect.logInfo(Message.reconciliation).pipe(
            Effect.annotateLogs({
              'vivid.operation.id': action.id,
              'vivid.reconciliation.outcome': reconciliation._tag,
            }),
          )
        }),
      ),
    ),
)

/**
 * Release the transaction before asking the Integration, then rerun the original check. The claim
 * reacquires its act lock, so a concurrent retry cannot bypass the journal. Inconclusive evidence
 * keeps the original refusal; a new unresolved claim encountered on recheck is refused too.
 */
const afterReconciliation = <A, R>(
  personId: PersonId,
  attempt: Effect.Effect<A, DatabaseInfrastructureError | ActionReconciliationRequired, R>,
) =>
  attempt.pipe(
    Effect.catchTag('ActionReconciliationRequired', (error) =>
      Effect.gen(function* () {
        const checked = yield* reconcile(personId, error.operationId)
        yield* Effect.annotateCurrentSpan('vivid.operation.id', error.operationId)
        yield* Effect.logInfo(Message.reconciliationRetry).pipe(
          Effect.annotateLogs({
            'vivid.operation.id': error.operationId,
            'vivid.reconciliation.outcome': checked.reconciliation._tag,
            'vivid.reconciliation.retry': ActionReconciliation.isAnyOf(['Applied', 'NotApplied'])(
              checked.reconciliation,
            )
              ? 'Unblocked'
              : 'Blocked',
          }),
        )
        if (!ActionReconciliation.isAnyOf(['Applied', 'NotApplied'])(checked.reconciliation))
          return yield* error
        return yield* attempt
      }).pipe(Effect.withSpan('Actions.retryAfterReconciliation')),
    ),
  )
