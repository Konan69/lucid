import { Schema } from 'effect'
import { ActionTarget } from './approvals.js'
import { ActionOperationId, ApprovalId, RunId, ThreadId } from './identity.js'

/**
 * The runtime's own name for one tool call, taken from the call and never from its arguments. A
 * retried call keeps it, which is what lets the server answer the retry with the first answer.
 */
export const ToolCallId = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)).pipe(
  Schema.brand('ToolCallId'),
)
export type ToolCallId = typeof ToolCallId.Type

/**
 * What a provider confirmed about where the effect arrived, beyond completing the call. No
 * Integration Vivid has today returns one; the case exists so an adapter that can is not forced to
 * call its confirmation Completed.
 */
export const ActionDeliveryReceipt = Schema.TaggedUnion({
  Provider: { confirmedAt: Schema.Finite },
})
export type ActionDeliveryReceipt = typeof ActionDeliveryReceipt.Type

/**
 * What one outward operation is known to have done, chosen by the adapter that sent it and never
 * by the model.
 *
 * - `Accepted`: the provider took the request and will act later; it has not happened yet.
 * - `Completed`: the provider answered that it did it. `resultDigest` is the SHA-256 of the answer,
 *   so the receipt names a result without carrying private provider data.
 * - `Delivered`: the provider also confirmed where it arrived.
 * - `Unknown`: the request may have been sent and its answer was lost. It may or may not have
 *   happened, and nothing is sent again on its account until it is reconciled.
 */
export const ActionReceipt = Schema.TaggedUnion({
  Accepted: { operationId: ActionOperationId, acceptedAt: Schema.Finite },
  Completed: { operationId: ActionOperationId, completedAt: Schema.Finite, resultDigest: Schema.String },
  Delivered: {
    operationId: ActionOperationId,
    completedAt: Schema.Finite,
    delivery: ActionDeliveryReceipt,
  },
  Unknown: { operationId: ActionOperationId, observedAt: Schema.Finite },
})
export type ActionReceipt = typeof ActionReceipt.Type

/** A receipt that says the operation took effect: every case but `Unknown`. */
export const ActionApplied = Schema.Union([
  ActionReceipt.cases.Accepted,
  ActionReceipt.cases.Completed,
  ActionReceipt.cases.Delivered,
])
export type ActionApplied = typeof ActionApplied.Type

/**
 * Why the server holds that an uncertain operation did not take effect. Only the provider's own
 * lookup can say so; a Person or a client cannot submit it.
 */
export const ActionAbsence = Schema.TaggedUnion({
  /** The provider was asked about this exact operation and has no record of it. */
  ProviderLookup: {},
})
export type ActionAbsence = typeof ActionAbsence.Type

/**
 * What a read-only check found about an operation whose receipt is `Unknown`. `Unchecked` until
 * someone asks. A provider with no way to look an operation up answers `Inconclusive`, never
 * `NotApplied`, and the operation stays blocked from being sent again.
 */
export const ActionReconciliation = Schema.TaggedUnion({
  Unchecked: {},
  Applied: { receipt: ActionApplied },
  NotApplied: { checkedAt: Schema.Finite, evidence: ActionAbsence },
  Inconclusive: { checkedAt: Schema.Finite },
})
export type ActionReconciliation = typeof ActionReconciliation.Type

/**
 * Where one operation's sending stands. `Dispatching` from the moment the server claimed it until
 * an answer is recorded; a crash in between leaves it here, which reads as uncertain.
 */
export const ActionPhase = Schema.TaggedUnion({
  Dispatching: { claimedAt: Schema.Finite },
  Settled: { receipt: ActionReceipt },
})
export type ActionPhase = typeof ActionPhase.Type

/**
 * One outward operation as the server's journal holds it: the exact thing sent and what is known
 * of it. An operation Vivid did without asking has no Approval.
 */
export const ActionOperation = Schema.Struct({
  id: ActionOperationId,
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  approvalId: Schema.NullOr(ApprovalId),
  target: ActionTarget,
  phase: ActionPhase,
}).annotate({ identifier: 'ActionOperation', title: 'Action operation' })
export interface ActionOperation extends Schema.Schema.Type<typeof ActionOperation> {}

/** Asks the server to check, read-only, whether an uncertain operation took effect. Nothing is retried. */
export const ReconcileActionRequest = Schema.Struct({ operationId: ActionOperationId })
export interface ReconcileActionRequest extends Schema.Schema.Type<typeof ReconcileActionRequest> {}

export const ReconcileActionResponse = Schema.Struct({
  action: ActionOperation,
  reconciliation: ActionReconciliation,
})
export interface ReconcileActionResponse extends Schema.Schema.Type<
  typeof ReconcileActionResponse
> {}

/**
 * The exact same action in this Thread was sent before and its result is not known. It is not sent
 * again until that operation is reconciled; other work in the Thread is not held.
 */
export class ActionReconciliationRequired extends Schema.TaggedError<ActionReconciliationRequired>()(
  'ActionReconciliationRequired',
  { operationId: ActionOperationId },
  { title: 'The result of the same earlier action is not known yet' },
) {}
