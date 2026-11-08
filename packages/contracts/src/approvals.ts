import { Schema } from 'effect'
import { BrowserAction, DefaultBrowseTarget, DesktopAction } from './computers.js'
import {
  ActionOperationId,
  ApprovalId,
  ArtifactId,
  ConnectionId,
  MembershipId,
  PersonSummary,
  RunId,
  ThreadId,
} from './identity.js'

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

/** A version of something, counted from 1 and never repeated. */
const Version = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

/**
 * Why an Approval stopped being answerable before anyone answered it: what it approved changed
 * under it. Each case names what changed and, where it has one, the version it changed to, so the
 * Person and Vivid can tell which change it was. Nothing a provider said is ever carried here.
 *
 * - `ContentChanged`: a Thread document the action sends was revised (`version` is the newest
 *   one) or removed (`version` is null).
 * - `ConnectionChanged`: the Integration the action uses was signed in again, lost its sign-in,
 *   failed or was removed. `generation` is its authorization generation now; null once removed.
 * - `AuthorityChanged`: the Person it was asked of left the Company the Thread belongs to.
 * - `RunStopped`: the Person stopped the Run that asked.
 * - `Superseded`: asked before Approvals were bound to what they approve (29 October 2026), so
 *   nothing says what it was asked against; it is asked again rather than trusted.
 */
export const ApprovalInvalidation = Schema.TaggedUnion({
  ContentChanged: { artifactId: ArtifactId, version: Schema.NullOr(Version) },
  ConnectionChanged: { connectionId: ConnectionId, generation: Schema.NullOr(Schema.Int) },
  AuthorityChanged: { membershipId: MembershipId },
  RunStopped: { runId: RunId },
  Superseded: {},
})
export type ApprovalInvalidation = typeof ApprovalInvalidation.Type

/**
 * One fact outside the action that the action depends on, as it was when the server prepared it.
 * `ArtifactVersion` is a Thread document whose text the action carries: the text was copied into
 * the action at that version, and `contentDigest` is the SHA-256 of that text.
 */
export const ApprovalPrecondition = Schema.TaggedUnion({
  ArtifactVersion: { artifactId: ArtifactId, version: Version, contentDigest: Schema.String },
})
export type ApprovalPrecondition = typeof ApprovalPrecondition.Type

/**
 * What the server bound an Approval to when it raised it, besides the action itself. If any of it
 * is no longer true when a Person answers, the Approval is `Invalidated` and nothing runs.
 *
 * `connectionGeneration` is the authorization generation of the Integration a Connection action
 * uses; null for an action on a Computer, which has no Integration.
 */
export const ApprovalBinding = Schema.Struct({
  connectionGeneration: Schema.NullOr(Schema.Int),
  preconditions: Schema.Array(ApprovalPrecondition),
}).annotate({ identifier: 'ApprovalBinding', title: 'Approval binding' })
export interface ApprovalBinding extends Schema.Schema.Type<typeof ApprovalBinding> {}

/**
 * Where an Approval stands. Each state carries only what that state has.
 *
 * `OutcomeUnknown` exists because a write can be sent and its answer lost. Vivid says so and never
 * retries on its own; the Person checks the service and decides.
 *
 * `Invalidated` is an Approval nobody may answer any more because what it approved changed before
 * it ran. Vivid prepares a fresh one when the work is still wanted; the old one is never revived.
 */
export const ApprovalState = Schema.TaggedUnion({
  Pending: { expiresAt: Schema.Finite },
  Executing: { decidedBy: PersonSummary, decidedAt: Schema.Finite },
  Succeeded: { decidedBy: PersonSummary, finishedAt: Schema.Finite, result: Schema.String },
  Failed: { decidedBy: PersonSummary, finishedAt: Schema.Finite, reason: Schema.String },
  /** `operationId` names the sent operation, so it can be reconciled before anything is sent again. */
  OutcomeUnknown: {
    decidedBy: PersonSummary,
    finishedAt: Schema.Finite,
    operationId: ActionOperationId,
  },
  Denied: { decidedBy: PersonSummary, decidedAt: Schema.Finite },
  Expired: { expiredAt: Schema.Finite },
  /** The Person it was asked of took it back. */
  Withdrawn: { withdrawnAt: Schema.Finite, reason: Schema.String },
  Invalidated: { invalidatedAt: Schema.Finite, reason: ApprovalInvalidation },
})
export type ApprovalState = typeof ApprovalState.Type

/** Authorization for one consequential action, addressed to the one Person who may decide it. */
export const Approval = Schema.Struct({
  id: ApprovalId,
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  action: ProposedAction,
  /**
   * A digest of the action, its binding, the Thread and the Person. A decision must echo it, so a
   * Person approves exactly what they were shown.
   */
  digest: Schema.String,
  /** Null only on an Approval raised before bindings existed; none of those is still Pending. */
  binding: Schema.NullOr(ApprovalBinding),
  /** The Person who must decide: the owner of the Connection the action uses. */
  askedOf: PersonSummary,
  state: ApprovalState,
  createdAt: Schema.Finite,
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

/**
 * What the Approval approved changed before it could run, so it was not run. The Approval now reads
 * `Invalidated`; a fresh one is needed.
 */
export class ApprovalChanged extends Schema.TaggedError<ApprovalChanged>()(
  'ApprovalChanged',
  { id: ApprovalId },
  { title: 'What this approval was for has changed' },
) {}

/** The Approval ran out before it was answered. Nothing was run. */
export class ApprovalExpired extends Schema.TaggedError<ApprovalExpired>()(
  'ApprovalExpired',
  { id: ApprovalId },
  { title: 'This approval ran out' },
) {}

export const ApprovalResponse = Schema.Struct({ approval: Approval })
export const ApprovalListResponse = Schema.Struct({ approvals: Schema.Array(Approval) })

/** What a Thread shows in place of a tool result while an Approval is open. */
export const ApprovalRequestMessage = Schema.Struct({
  kind: Schema.Literal('approval-request'),
  approvalId: ApprovalId,
  summary: Schema.String,
}).annotate({ identifier: 'ApprovalRequestMessage', title: 'Approval request message' })
export interface ApprovalRequestMessage extends Schema.Schema.Type<typeof ApprovalRequestMessage> {}
