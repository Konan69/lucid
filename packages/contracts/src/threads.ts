import { Schema } from 'effect'
import { Approval } from './approvals.js'
import { PersonId, PersonSummary, ProjectId, RunId, ThreadId } from './identity.js'
import { InputRequest } from './inputs.js'
import { WatchId, WatchInstruction, WatchName } from './watches.js'

/** The image formats accepted by the conversation gateway and served inline to every client. */
export const PictureMediaType = Schema.Literals([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const)
export type PictureMediaType = typeof PictureMediaType.Type

/** The image wire shape. The gateway also checks decoded size and the bytes' signature. */
export const MessageAttachment = Schema.Struct({
  type: Schema.Literal('image'),
  data: Schema.String,
  mimeType: PictureMediaType,
  filename: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(255))),
})
export interface MessageAttachment extends Schema.Schema.Type<typeof MessageAttachment> {}

/** A Person's words or pictures. The gateway rejects messages with neither. */
export const SendMessageRequest = Schema.Struct({
  kind: Schema.Literal('user'),
  body: Schema.String.check(Schema.isMaxLength(100_000)),
  attachments: Schema.optionalKey(Schema.Array(MessageAttachment)),
  idempotencyKey: Schema.optionalKey(
    Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
  ),
})
export interface SendMessageRequest extends Schema.Schema.Type<typeof SendMessageRequest> {}

/**
 * One send from a Person's client, whichever runtime holds the Thread. `key` is made once per
 * send by the client and comes back on the message in the conversation, so the client that drew
 * the words at once recognises them when they arrive. Words, pictures or both; never neither.
 */
export const SendToThreadRequest = Schema.Struct({
  threadId: ThreadId,
  text: SendMessageRequest.fields.body,
  pictures: Schema.Array(MessageAttachment),
  key: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
}).check(
  Schema.makeFilter((request) => request.text.trim().length > 0 || request.pictures.length > 0, {
    message: 'A send carries words, pictures or both',
  }),
)
export interface SendToThreadRequest extends Schema.Schema.Type<typeof SendToThreadRequest> {}

/** A card resumes Vivid without presenting its nudge as words the Person said. */
export const CarryOnRequest = Schema.Struct({
  threadId: ThreadId,
  body: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(2000)),
  key: SendToThreadRequest.fields.key,
})
export interface CarryOnRequest extends Schema.Schema.Type<typeof CarryOnRequest> {}

/** A conversation whose whole state is larger than the relay sends cannot open on any device. */
export class ConversationTooLarge extends Schema.TaggedError<ConversationTooLarge>()(
  'ConversationTooLarge',
  { threadId: ThreadId, limit: Schema.Int },
  { title: 'Thread conversation exceeds the relay limit' },
) {}

/** Invalid formats and mismatched signatures need the Person to choose another image. */
export class UnsupportedAttachment extends Schema.TaggedError<UnsupportedAttachment>()(
  'UnsupportedAttachment',
  { message: Schema.String },
  { title: 'Unsupported picture' },
) {}

/** Invalid base64 or attachment fields cannot become a durable conversation input. */
export class InvalidAttachment extends Schema.TaggedError<InvalidAttachment>()(
  'InvalidAttachment',
  { message: Schema.String },
  { title: 'Invalid picture' },
) {}

/** The size limit applies to decoded bytes, separately for each picture. */
export class AttachmentTooLarge extends Schema.TaggedError<AttachmentTooLarge>()(
  'AttachmentTooLarge',
  { message: Schema.String },
  { title: 'Picture too large' },
) {}

/** A message accepts at most four pictures, including repeated pictures. */
export class TooManyAttachments extends Schema.TaggedError<TooManyAttachments>()(
  'TooManyAttachments',
  { message: Schema.String },
  { title: 'Too many pictures' },
) {}

/** Shared Threads accept text-only attributed signals. */
export class PicturesRequirePrivateThread extends Schema.TaggedError<PicturesRequirePrivateThread>()(
  'PicturesRequirePrivateThread',
  { threadId: ThreadId, message: Schema.String },
  { title: 'Pictures require a private Thread' },
) {}

/**
 * Who can see a Thread and send into it.
 *
 * - `Private`: its creator only. Every Thread in a personal space is private.
 * - `People`: its creator and the Members they added.
 * - `Company`: every Member of the Company it lives in.
 *
 * Nothing wider than the audience ever reads a Thread; a Company role is not a way in.
 */
export const ThreadAudience = Schema.TaggedUnion({
  Private: {},
  People: { participants: Schema.Array(PersonSummary) },
  Company: {},
})
export type ThreadAudience = typeof ThreadAudience.Type

/**
 * What a Thread needs from the Person looking at it, computed from its Runs and never set by hand.
 *
 * - `Working`: a Run is in progress, even with a question open: Vivid keeps working after it asks.
 * - `NeedsYou`: nothing is running and a question or an Approval addressed to this Person waits.
 * - `Unread`: something happened since this Person last opened it.
 * - `Quiet`: nothing to do.
 */
export const ThreadAttention = Schema.Literals(['NeedsYou', 'Working', 'Unread', 'Quiet'] as const)
export type ThreadAttention = typeof ThreadAttention.Type

/** Thread summary exchanged by web, mobile, and the conversation runtime. */
export const Thread = Schema.Struct({
  id: ThreadId,
  title: Schema.String,
  preview: Schema.String,
  updatedAt: Schema.Finite,
  archived: Schema.Boolean,
  createdBy: PersonSummary,
  audience: ThreadAudience,
  projectId: Schema.NullOr(ProjectId),
  attention: ThreadAttention,
}).annotate({ identifier: 'Thread', title: 'Thread' })
/** Decoded Thread summary. */
export interface Thread extends Schema.Schema.Type<typeof Thread> {}

/** Input for creating a Thread. The id is the client's, so it can render the Thread before the server answers. */
export const CreateThreadRequest = Schema.Struct({
  id: ThreadId,
  title: Schema.String,
  projectId: Schema.NullOr(ProjectId),
}).annotate({ identifier: 'CreateThreadRequest', title: 'Create Thread request' })
export interface CreateThreadRequest extends Schema.Schema.Type<typeof CreateThreadRequest> {}

/** Person-level first arrival: only the call that opens the Thread starts its first Run. */
export const OpenFirstThreadResult = Schema.TaggedUnion({
  Opened: { thread: ThreadId },
  Existing: { thread: ThreadId },
  NotFirst: {},
})
export type OpenFirstThreadResult = typeof OpenFirstThreadResult.Type

/** Partial Thread fields a participant may change. */
export const PatchThreadRequest = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  archived: Schema.optionalKey(Schema.Boolean),
  projectId: Schema.optionalKey(Schema.NullOr(ProjectId)),
}).annotate({ identifier: 'PatchThreadRequest', title: 'Patch Thread request' })
/** Decoded Thread patch input. */
export interface PatchThreadRequest extends Schema.Schema.Type<typeof PatchThreadRequest> {}

/**
 * Changing who a Thread is shared with. Only its creator may, and only inside a Company: a
 * personal space has nobody to share with.
 */
export const ShareThreadRequest = Schema.TaggedUnion({
  Private: {},
  People: { participants: Schema.Array(PersonId) },
  Company: {},
})
export type ShareThreadRequest = typeof ShareThreadRequest.Type

/** List response for Threads. */
export const ThreadListResponse = Schema.Struct({ threads: Schema.Array(Thread) })
/** Decoded Thread list response. */
export interface ThreadListResponse extends Schema.Schema.Type<typeof ThreadListResponse> {}
/** Single Thread response. */
export const ThreadResponse = Schema.Struct({ thread: Thread })
/** Decoded single Thread response. */
export interface ThreadResponse extends Schema.Schema.Type<typeof ThreadResponse> {}

/**
 * What started a Run. A Person's Message, an Integration event, or a returning decision.
 * Each names the Person on whose behalf Vivid acts for the length of the Run.
 */
export const RunOrigin = Schema.TaggedUnion({
  Message: { person: PersonSummary },
  FirstConversation: { person: PersonSummary },
  /** A decision on an Approval or an answer to an Input request returning to the Thread. */
  Decision: { person: PersonSummary },
  /**
   * An Integration event a Watch subscribed to: which Watch, and which of its events. The Watch's
   * id and name are kept here because the Watch itself may be removed later.
   */
  Watch: {
    person: PersonSummary,
    watchId: WatchId,
    watchName: Schema.String,
    eventId: Schema.NonEmptyString,
    event: Schema.String,
    occurredAt: Schema.String,
  },
  /** A Watch Run started before 29 October 2026, which recorded only the Watch's name. */
  WatchUnrecorded: { person: PersonSummary, watchName: Schema.String },
})
export type RunOrigin = typeof RunOrigin.Type

/**
 * Why a Run failed, in the terms a Person would act on. Waiting helps with `RateLimited`; trying
 * again helps with `TimedOut` and `NoAnswer` (the model returned nothing at all); `ModelUnavailable`
 * needs whoever runs this Vivid. `Unexplained` is the honest remainder: the runtime reported a
 * failure Vivid has no name for, and it is never used to hide one of the others.
 */
export const RunFailure = Schema.Literals([
  'Delivery',
  'RateLimited',
  'ModelUnavailable',
  'NoAnswer',
  'TimedOut',
  'Unexplained',
])
export type RunFailure = typeof RunFailure.Type

/** The model-specific Run reasons shared by typed provider failures and telemetry's allowlist. */
export const ModelFailureReason = RunFailure.pick([
  'RateLimited',
  'ModelUnavailable',
  'NoAnswer',
  'TimedOut',
])

/**
 * Where a Run stands. `Unknown` is an honest state: the runtime stopped reporting and the outcome
 * cannot be told, so nothing is retried on its account.
 */
export const RunState = Schema.TaggedUnion({
  Working: {},
  Completed: { finishedAt: Schema.Finite },
  Failed: { finishedAt: Schema.Finite, reason: RunFailure },
  Stopped: { finishedAt: Schema.Finite },
  Unknown: { finishedAt: Schema.Finite },
})
export type RunState = typeof RunState.Type

/** One bounded attempt by Vivid to advance a Thread. */
export const Run = Schema.Struct({
  id: RunId,
  /**
   * The runtime's name for the delivery that started this Run, which is how the conversation
   * refers to it. Absent until the runtime admitted it. Pi Durable numbers deliveries per Person,
   * so the name means nothing outside its Thread's creator; product ids stay globally unique.
   */
  submissionId: Schema.optional(Schema.String),
  threadId: ThreadId,
  /**
   * The Run's place in its Thread, counted from one. It is what the delivery that started the Run
   * is called inside the conversation, where no identifier is ever written: the conversation says
   * "turn 7, from Ada", and the Run with that number says who Ada is and what she may do.
   */
  turn: Schema.Finite,
  origin: RunOrigin,
  state: RunState,
  startedAt: Schema.Finite,
}).annotate({ identifier: 'Run', title: 'Run' })
export interface Run extends Schema.Schema.Type<typeof Run> {}

/** A send answers once admitted, with the product Run it started or joined. */
export const SendToThreadResponse = Schema.Struct({ run: Run })
export interface SendToThreadResponse extends Schema.Schema.Type<typeof SendToThreadResponse> {}

/** Someone with a Thread open right now, and whether they are writing. */
export const Presence = Schema.Struct({
  person: PersonSummary,
  typing: Schema.Boolean,
}).annotate({ identifier: 'Presence', title: 'Presence' })
export interface Presence extends Schema.Schema.Type<typeof Presence> {}

/**
 * Everything beside the conversation itself that a client needs to draw one Thread: who is in it,
 * who sent what (Runs carry the attribution conversation history does not), and who is here now.
 */
export const ThreadDetail = Schema.Struct({
  thread: Thread,
  runs: Schema.Array(Run),
  present: Schema.Array(Presence),
  /** Every Approval raised in this Thread, open or settled, so its card keeps its outcome. */
  approvals: Schema.Array(Approval),
  /** Every Input request raised in this Thread. */
  requests: Schema.Array(InputRequest),
}).annotate({ identifier: 'ThreadDetail', title: 'Thread detail' })
export interface ThreadDetail extends Schema.Schema.Type<typeof ThreadDetail> {}

/**
 * A client saying it has a Thread open and in front, and whether something is typed in it. It is
 * held open as `BePresent`, and a change of `typing` is a new hold in place of the old one.
 */
export const PresenceRequest = Schema.Struct({
  threadId: ThreadId,
  typing: Schema.Boolean,
})
export interface PresenceRequest extends Schema.Schema.Type<typeof PresenceRequest> {}

/** One signal vocabulary for the server, runtime history and every client that draws it. */
export const SignalType = Schema.Literals([
  'message',
  'approval',
  'answer',
  'first-conversation',
  // An Integration event a Watch subscribed to (`watches.ts`), delivered into a background Thread.
  'event',
  // A card telling Vivid to go on (`CarryOnRequest`); no client draws it.
  'carry-on',
] as const)
export type SignalType = typeof SignalType.Type

/** An Approval's outcome as the conversation names it (`approvals/signal.ts`, `owed`). */
export const ApprovalOutcome = Schema.Literals([
  'expired',
  'Denied',
  'Succeeded',
  'Failed',
  'OutcomeUnknown',
  'Invalidated',
] as const)
export type ApprovalOutcome = typeof ApprovalOutcome.Type

/**
 * What a server delivery says, one case per thing that puts Vivid to work, each with exactly the
 * fields that thing has. The runtime renders each case to its fixed tag and full text
 * (`packages/agent/runtime/src/delivery.ts`, `signalText`), so a case cannot arrive without the
 * name or outcome its tag needs.
 *
 * - `Message`: a Person's words in a shared Thread.
 * - `FirstConversation`: the opening instruction of a Person's first Thread.
 * - `Approval`: an Approval's outcome, with the summary and result in `body`.
 * - `Answer`: a Person's answer to an Input request, with its questions in `body`.
 * - `Watch`: one event a Watch received. `data` is the event as the Integration sent it, whole;
 *   `occurredAt` is the Integration's own timestamp text, kept as sent.
 * - `CarryOn`: a card telling Vivid to go on (`CarryOnRequest`); no client draws it.
 */
export const SignalCue = Schema.TaggedUnion({
  Message: { body: Schema.String },
  FirstConversation: { body: Schema.String },
  Approval: { body: Schema.String, outcome: ApprovalOutcome },
  Answer: { body: Schema.String },
  Watch: {
    name: WatchName,
    event: Schema.String,
    occurredAt: Schema.String,
    instruction: WatchInstruction,
    data: Schema.Json,
  },
  CarryOn: { body: Schema.String },
})
export type SignalCue = typeof SignalCue.Type

/** The tag each cue is rendered and drawn under, from the one signal vocabulary. */
export const signalTypes = {
  Message: 'message',
  FirstConversation: 'first-conversation',
  Approval: 'approval',
  Answer: 'answer',
  Watch: 'event',
  CarryOn: 'carry-on',
} as const satisfies Record<SignalCue['_tag'], SignalType>

/**
 * One attributed server delivery: who it is from and its turn, as the conversation names them
 * ("turn 7, from Ada"), and what it says. The turn is the Run's place in its Thread, the same as
 * the admission's `turn`.
 */
export const SignalEnvelope = Schema.Struct({
  from: Schema.String,
  turn: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0)),
  cue: SignalCue,
}).annotate({ identifier: 'SignalEnvelope', title: 'Signal envelope' })
export type SignalEnvelope = typeof SignalEnvelope.Type

/**
 * What one admission puts in front of Vivid: a Person's own words in a private Thread, a plain user
 * turn with any pictures, or an attributed server delivery.
 */
export const RuntimeDelivery = Schema.TaggedUnion({
  Words: { body: Schema.String, attachments: Schema.Array(MessageAttachment) },
  Signal: { envelope: SignalEnvelope },
})
export type RuntimeDelivery = typeof RuntimeDelivery.Type

/** The Person Vivid acts for. Scope travels from server to runtime beside model-visible
 * text and reaches tools through a Layer. The model cannot read or alter this authority. */
export const DeliveryScope = Schema.Struct({
  acting: PersonId,
}).annotate({ identifier: 'DeliveryScope', title: 'Delivery scope' })
export interface DeliveryScope extends Schema.Schema.Type<typeof DeliveryScope> {}

/** Naming one delivery: its Thread and the turn it was given there. */
export const DeliveryScopeRequest = Schema.Struct({
  threadId: ThreadId,
  turn: Schema.Finite,
})
export interface DeliveryScopeRequest extends Schema.Schema.Type<typeof DeliveryScopeRequest> {}

/** A server-owned runtime admission request. The delivery holds model-visible words; scope
 * carries the authority the model never sees. Product state stays on the server. */
export const RuntimeRunRequest = Schema.Struct({
  threadId: ThreadId,
  idempotencyKey: Schema.String,
  delivery: RuntimeDelivery,
  turn: Schema.Finite,
  scope: DeliveryScope,
  /**
   * The key the sending client made (`SendToThreadRequest.key`), passed through so the
   * conversation gives it back on that message. It is not the idempotency key and is never shown
   * to the model. Absent on deliveries the server makes itself.
   */
  clientKey: Schema.optionalKey(SendToThreadRequest.fields.key),
})
export interface RuntimeRunRequest extends Schema.Schema.Type<typeof RuntimeRunRequest> {}

/** Durable runtime admission receipt for one accepted Run. */
export const RuntimeRunResponse = Schema.Struct({ submissionId: Schema.String })
export interface RuntimeRunResponse extends Schema.Schema.Type<typeof RuntimeRunResponse> {}

/** Thread location and creator supplied when its conversation is created.
 * Evolving facts travel with each delivery. */
export const ThreadOrigin = Schema.Struct({
  creator: PersonId,
  creatorName: Schema.String,
})
export interface ThreadOrigin extends Schema.Schema.Type<typeof ThreadOrigin> {}

/**
 * The one JSON body the server posts to the runtime to admit a Run, and the one the runtime
 * decodes: the Run request plus the Thread's `initialData`. Both sides use this schema, so a body
 * the server can encode is a body the runtime accepts.
 *
 * `turn` counts a Thread's Runs from one. The check lives here so the server refuses a turn the
 * runtime would reject before anything is sent, instead of learning it from a 400.
 */
export const RuntimeAdmissionBody = Schema.Struct({
  ...RuntimeRunRequest.fields,
  turn: RuntimeRunRequest.fields.turn.check(Schema.isInt(), Schema.isGreaterThan(0)),
  initialData: ThreadOrigin,
})
export interface RuntimeAdmissionBody extends Schema.Schema.Type<typeof RuntimeAdmissionBody> {}

/** Everything waiting on the signed-in Person across the Threads they can see. */
export const Inbox = Schema.Struct({
  approvals: Schema.Array(Approval),
  requests: Schema.Array(InputRequest),
}).annotate({ identifier: 'Inbox', title: 'Inbox' })
export interface Inbox extends Schema.Schema.Type<typeof Inbox> {}

/** Background naming may log these failures; explicit regeneration returns them without changing the title. */
export class ThreadTitleHistoryUnavailable extends Schema.TaggedError<ThreadTitleHistoryUnavailable>()(
  'ThreadTitleHistoryUnavailable',
  { thread: ThreadId },
  { title: 'Thread title history unavailable' },
) {}

/** Provider/configuration failure is distinct from a malformed title response. */
export class ThreadTitleModelUnavailable extends Schema.TaggedError<ThreadTitleModelUnavailable>()(
  'ThreadTitleModelUnavailable',
  { thread: ThreadId },
  { title: 'Thread title model unavailable' },
) {}

/** The model must return exactly one JSON string field named title. */
export class ThreadTitleOutputInvalid extends Schema.TaggedError<ThreadTitleOutputInvalid>()(
  'ThreadTitleOutputInvalid',
  { thread: ThreadId },
  { title: 'Thread title output invalid' },
) {}
