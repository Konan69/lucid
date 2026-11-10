import { Array as Arr, Effect, Option, Schema } from 'effect'
import { IntegrationAnswerOutcome, noIntegrationContinuation } from './asks.js'
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
  continuation: noIntegrationContinuation,
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
 * - `ExternalStateChanged`: the browser page, Gmail MIME envelope or incoming thread changed.
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
  ExternalStateChanged: { source: Schema.Literals(['BrowserPage', 'MailEnvelope']) },
})
export type ApprovalInvalidation = typeof ApprovalInvalidation.Type

/** Digests bind external content without retaining private page or mail bytes in the binding. */
export const ApprovalContentDigest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)).pipe(
  Schema.brand('ApprovalContentDigest'),
)
export const GmailThreadId = Schema.NonEmptyString.pipe(Schema.brand('GmailThreadId'))
export const GmailMessageId = Schema.NonEmptyString.pipe(Schema.brand('GmailMessageId'))
export const ApprovalPageAddress = Schema.NonEmptyString.pipe(Schema.brand('ApprovalPageAddress'))

/**
 * One fact outside the action that the action depends on, as it was when the server prepared it.
 * `ArtifactVersion` is a Thread document whose text the action carries: the text was copied into
 * the action at that version, and `contentDigest` is the SHA-256 of that text.
 */
export const ApprovalPrecondition = Schema.TaggedUnion({
  ArtifactVersion: { artifactId: ArtifactId, version: Version, contentDigest: Schema.String },
  BrowserPage: { address: ApprovalPageAddress, outlineDigest: ApprovalContentDigest },
  /** The entire RFC 2822 MIME binds To/Cc/Bcc, reply headers, subject and every attachment byte. */
  MailEnvelope: {
    mimeDigest: ApprovalContentDigest,
    thread: Schema.NullOr(
      Schema.Struct({
        id: GmailThreadId,
        latestMessageId: GmailMessageId,
        sourceDigest: ApprovalContentDigest,
      }),
    ),
  },
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
  integrationOutcome: Schema.NullOr(IntegrationAnswerOutcome).pipe(
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  /** What Vivid asked to do; once a Person sent it edited (`AllowEdited`), what was sent. */
  action: ProposedAction,
  /**
   * A digest of the action as it was asked, its binding, the Thread and the Person. A decision must echo it, so a
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
 *
 * `AllowEdited` is a draft the Person changed before sending it: the Integration action once,
 * with `input` in place of what Vivid wrote. The owner, 27 October 2026: "wants to send, needs a
 * draft to send". `input` keeps every field Vivid wrote and changes only words (text, or a list
 * of texts such as recipients); anything else is refused, so an edit can rewrite the message and
 * who it goes to but never turn the action into a different one. The decision still quotes the
 * digest of what was asked, and once it is taken the Approval's `action` is what was sent.
 */
export const ApprovalDecision = Schema.TaggedUnion({
  AllowOnce: {},
  AlwaysAllow: {},
  AllowEdited: { input: Schema.JsonObject },
  Deny: {},
  Cancel: {},
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

/**
 * Another decision got there first: the Approval is no longer pending, so this one was not taken.
 * A Person answering from a notification after deciding elsewhere meets it, and is told so.
 */
export class ApprovalDecided extends Schema.TaggedError<ApprovalDecided>()(
  'ApprovalDecided',
  { id: ApprovalId },
  { title: 'This approval was already answered' },
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

const isText = Schema.is(Schema.String)
const isTexts = Schema.is(Schema.Array(Schema.String))
const isFields = Schema.is(Schema.JsonObject)

/**
 * Which fields of an Integration action are which part of a message, by the names services give
 * them, compared case-blind. The first name an action uses wins. A message needs a recipient and
 * words; the subject and the attachments are read when there are any. `channel` is a recipient:
 * a post to a channel is sent to people as much as an email is.
 */
const NAMES = {
  to: ['to', 'recipient', 'recipients', 'recipient_email', 'to_email', 'to_address', 'channel'],
  subject: ['subject'],
  body: ['body', 'message', 'text', 'content', 'message_body', 'body_text', 'plain_text', 'html'],
  attachments: ['attachments', 'attachment', 'attachment_name', 'files', 'file', 'filename'],
} as const

/** One field of a draft: the key it is sent under, and its words as the Person edits them. */
export interface SendDraftField {
  readonly key: string
  readonly text: string
}

/**
 * A send read as the message it is: who it goes to, the subject, what is attached and the words.
 * `list` says the recipients were sent as a list, so edited text goes back as one; `input` is the
 * whole action input as asked, every other field of which is sent unchanged.
 */
export interface SendDraft {
  readonly account: string
  readonly to: SendDraftField & { readonly list: boolean }
  readonly subject: Option.Option<SendDraftField>
  readonly body: SendDraftField
  /** What is attached, by name; read only, as it was asked. */
  readonly attachments: ReadonlyArray<string>
  readonly input: Schema.JsonObject
}

/** The first field of `input` whose name is one of `names`, with its key as it was sent. */
const fieldNamed = (input: Schema.JsonObject, names: ReadonlyArray<string>) =>
  Arr.findFirst(Object.entries(input), ([key]) => names.includes(key.toLowerCase()))

/** The names of what is attached: words, a list of words, or files that say their own name. */
const attachedNames = (value: Schema.Json): ReadonlyArray<string> =>
  (Array.isArray(value) ? value : [value]).flatMap((each) => {
    if (isText(each)) return each === '' ? [] : [each]
    if (isFields(each)) {
      const name = Object.entries(each).find(([key]) => key === 'name' || key === 'filename')
      return name !== undefined && isText(name[1]) ? [name[1]] : []
    }
    return []
  })

/**
 * The action as a draft to send, when it is an Integration action that sends words to someone: a recipient as words or a list of words, and words to send. Anything else is decided
 * as the action it is. The owner, 27 October 2026: "wants to send, needs a draft to send".
 */
export const draftOf = (action: ProposedAction): Option.Option<SendDraft> => {
  const target = action.target
  if (!ActionTarget.guards.Connection(target)) return Option.none()
  const input = target.input
  if (!isFields(input)) return Option.none()
  const to = fieldNamed(input, NAMES.to)
  const body = fieldNamed(input, NAMES.body)
  if (Option.isNone(to) || Option.isNone(body)) return Option.none()
  const [toKey, toValue] = to.value
  const [bodyKey, bodyValue] = body.value
  const list = isTexts(toValue)
  if (!(list || isText(toValue)) || !isText(bodyValue)) return Option.none()
  return Option.some({
    account: target.account,
    to: { key: toKey, list, text: list ? toValue.join(', ') : toValue },
    subject: Option.flatMap(fieldNamed(input, NAMES.subject), ([key, value]) =>
      isText(value) ? Option.some({ key, text: value }) : Option.none(),
    ),
    body: { key: bodyKey, text: bodyValue },
    attachments: Option.match(fieldNamed(input, NAMES.attachments), {
      onNone: () => [],
      onSome: ([, value]) => attachedNames(value),
    }),
    input,
  })
}
