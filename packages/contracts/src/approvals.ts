import { Schema } from 'effect'
import { BrowserAction, DefaultBrowseTarget, DesktopAction } from './computers.js'
import { ApprovalId, ConnectionId, PersonSummary, RunId, ThreadId } from './identity.js'

/**
 * How much an action can change. `read` changes nothing outside Vivid; `write` creates or edits
 * something a Person could undo; `destructive` deletes, sends, pays or publishes. Connection
 * tools take this from their source (an HTTP method, a declared hint), never from model text.
 */
export const ActionEffect = Schema.Literals(['read', 'write', 'destructive'] as const)
export type ActionEffect = typeof ActionEffect.Type

/**
 * What the action is done to. A Connection tool runs under one named account; a
 * browser step and a desktop action run on the acting Person's Computer.
 */
export const ActionTarget = Schema.TaggedUnion({
  Connection: {
    connectionId: ConnectionId,
    /** The account the action will use, as the Person labelled it: "Gmail (Work)". */
    account: Schema.String,
    tool: Schema.String,
    input: Schema.Json,
  },
  Browser: { action: BrowserAction, target: DefaultBrowseTarget },
  /** One pointer or keyboard action on the Computer's desktop. */
  Desktop: { action: DesktopAction },
})
export type ActionTarget = typeof ActionTarget.Type

/**
 * The exact thing Vivid proposes to do. What is stored here is what runs after approval; the model
 * is not asked again, so the card a Person approved cannot drift from the action that executes.
 */
export const ProposedAction = Schema.Struct({
  /** One plain sentence in Vivid's voice: "Send the signed NDA to Dami". */
  summary: Schema.String,
  /** Why Vivid wants to, in the Person's terms. */
  rationale: Schema.String,
  effect: ActionEffect,
  target: ActionTarget,
}).annotate({ identifier: 'ProposedAction', title: 'Proposed action' })
export interface ProposedAction extends Schema.Schema.Type<typeof ProposedAction> {}

/**
 * Where an Approval stands. Each state carries only what that state has.
 *
 * `OutcomeUnknown` exists because a write can be sent and its answer lost. Vivid says so and never
 * retries on its own; the Person checks the service and decides.
 */
export const ApprovalState = Schema.TaggedUnion({
  Pending: { expiresAt: Schema.Number },
  Executing: { decidedBy: PersonSummary, decidedAt: Schema.Number },
  Succeeded: { decidedBy: PersonSummary, finishedAt: Schema.Number, result: Schema.String },
  Failed: { decidedBy: PersonSummary, finishedAt: Schema.Number, reason: Schema.String },
  OutcomeUnknown: { decidedBy: PersonSummary, finishedAt: Schema.Number },
  Denied: { decidedBy: PersonSummary, decidedAt: Schema.Number },
  Expired: { expiredAt: Schema.Number },
  /** The Run that asked was stopped, or the Connection it named changed, before a decision. */
  Withdrawn: { withdrawnAt: Schema.Number, reason: Schema.String },
})
export type ApprovalState = typeof ApprovalState.Type

/** Authorization for one consequential action, addressed to the one Person who may decide it. */
export const Approval = Schema.Struct({
  id: ApprovalId,
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  action: ProposedAction,
  /**
   * A digest of the action and the account it will use. A decision must echo it, so a Person
   * approves exactly what they were shown.
   */
  digest: Schema.String,
  /** The Person who must decide: the owner of the Connection the action uses. */
  askedOf: PersonSummary,
  state: ApprovalState,
  createdAt: Schema.Number,
}).annotate({ identifier: 'Approval', title: 'Approval' })
export interface Approval extends Schema.Schema.Type<typeof Approval> {}

/**
 * A Person's answer. `AlwaysAllow` approves this action and writes a rule so the same kind of
 * action does not ask again; the rule is theirs and they can remove it.
 */
export const ApprovalDecision = Schema.TaggedUnion({
  AllowOnce: {},
  AlwaysAllow: {},
  Deny: {},
})
export type ApprovalDecision = typeof ApprovalDecision.Type

export const DecideApprovalRequest = Schema.Struct({
  id: ApprovalId,
  digest: Schema.String,
  decision: ApprovalDecision,
})
export interface DecideApprovalRequest extends Schema.Schema.Type<typeof DecideApprovalRequest> {}

export const ApprovalResponse = Schema.Struct({ approval: Approval })
export const ApprovalListResponse = Schema.Struct({ approvals: Schema.Array(Approval) })

/** What a Thread shows in place of a tool result while an Approval is open. */
export const ApprovalRequestMessage = Schema.Struct({
  kind: Schema.Literal('approval-request'),
  approvalId: ApprovalId,
  summary: Schema.String,
}).annotate({ identifier: 'ApprovalRequestMessage', title: 'Approval request message' })
export interface ApprovalRequestMessage extends Schema.Schema.Type<typeof ApprovalRequestMessage> {}
