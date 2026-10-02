import { Schema } from 'effect'
import { Approval } from './approvals.js'
import { LibraryFolderId, PersonId, PersonSummary, ProjectId, RunId, ThreadId } from './identity.js'
import { InputRequest } from './inputs.js'

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
 * - `NeedsYou`: a question or an Approval addressed to this Person is waiting.
 * - `Working`: a Run is in progress.
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
  updatedAt: Schema.Number,
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
 * What started a Run. A Person's Message, a Routine that came due, or a follow-up Vivid scheduled.
 * Each names the Person on whose behalf Vivid acts for the length of the Run.
 */
export const RunOrigin = Schema.TaggedUnion({
  Message: { person: PersonSummary },
  Routine: { person: PersonSummary, routineName: Schema.String },
  FollowUp: { person: PersonSummary, taskTitle: Schema.String },
  /** A decision on an Approval or an answer to an Input request returning to the Thread. */
  Decision: { person: PersonSummary },
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

/**
 * Where a Run stands. `Unknown` is an honest state: the runtime stopped reporting and the outcome
 * cannot be told, so nothing is retried on its account.
 */
export const RunState = Schema.TaggedUnion({
  Working: {},
  Completed: { finishedAt: Schema.Number },
  Failed: { finishedAt: Schema.Number, reason: RunFailure },
  Stopped: { finishedAt: Schema.Number },
  Unknown: { finishedAt: Schema.Number },
})
export type RunState = typeof RunState.Type

/** One bounded attempt by Vivid to advance a Thread. */
export const Run = Schema.Struct({
  id: RunId,
  threadId: ThreadId,
  /**
   * The Run's place in its Thread, counted from one. It is what the delivery that started the Run
   * is called inside the conversation, where no identifier is ever written: the conversation says
   * "turn 7, from Ada", and the Run with that number says who Ada is and what she may do.
   */
  turn: Schema.Number,
  origin: RunOrigin,
  state: RunState,
  startedAt: Schema.Number,
}).annotate({ identifier: 'Run', title: 'Run' })
export interface Run extends Schema.Schema.Type<typeof Run> {}

/** Someone with a Thread open right now, and whether they are writing. */
export const Presence = Schema.Struct({
  person: PersonSummary,
  typing: Schema.Boolean,
}).annotate({ identifier: 'Presence', title: 'Presence' })
export interface Presence extends Schema.Schema.Type<typeof Presence> {}

/**
 * Everything beside the conversation itself that a client needs to draw one Thread: who is in it,
 * who sent what (Runs carry the attribution Flue's history does not), and who is here now.
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

/** A client saying it has a Thread open. Sent on a short interval; silence ends the presence. */
export const PresenceRequest = Schema.Struct({
  threadId: ThreadId,
  typing: Schema.Boolean,
})
export interface PresenceRequest extends Schema.Schema.Type<typeof PresenceRequest> {}

/**
 * The signal types the server delivers into a Thread. Flue keeps them in its own history, so the
 * vocabulary is fixed here once for the server, the runtime and every client that renders them.
 */
export const SignalType = Schema.Literals([
  'message',
  'schedule',
  'follow-up',
  'approval',
  'answer',
] as const)
export type SignalType = typeof SignalType.Type

/**
 * Who a delivery is for and what it may reach: the Person Vivid acts for, and the Library folder
 * the work is confined to when there is one (a Routine's own folder).
 *
 * This is never written into the conversation. Flue shows a delivery's attributes to the model as
 * text, so anything put there is something the model can read, repeat to the people in a shared
 * Thread, or be talked into changing. The scope travels beside the conversation instead, from the
 * server to the runtime, and reaches the tools through a Layer.
 */
export const DeliveryScope = Schema.Struct({
  acting: PersonId,
  libraryFolder: Schema.NullOr(LibraryFolderId),
}).annotate({ identifier: 'DeliveryScope', title: 'Delivery scope' })
export interface DeliveryScope extends Schema.Schema.Type<typeof DeliveryScope> {}

/** Naming one delivery: its Thread and the turn it was given there. */
export const DeliveryScopeRequest = Schema.Struct({
  threadId: ThreadId,
  turn: Schema.Number,
})
export interface DeliveryScopeRequest extends Schema.Schema.Type<typeof DeliveryScopeRequest> {}

/**
 * One server-owned request for Flue to accept a Run without owning product state.
 *
 * `body` and `attributes` are what the model reads, so they hold words only: who is speaking by
 * name, what woke Vivid, and the delivery's `turn`. `scope` is what the runtime acts with and the
 * model never sees.
 */
export const RuntimeRunRequest = Schema.Struct({
  threadId: ThreadId,
  idempotencyKey: Schema.String,
  type: SignalType,
  body: Schema.String,
  attributes: Schema.Record(Schema.String, Schema.String),
  turn: Schema.Number,
  scope: DeliveryScope,
})
export interface RuntimeRunRequest extends Schema.Schema.Type<typeof RuntimeRunRequest> {}

/** Flue's durable receipt for one accepted Run. */
export const RuntimeRunResponse = Schema.Struct({ submissionId: Schema.String })
export interface RuntimeRunResponse extends Schema.Schema.Type<typeof RuntimeRunResponse> {}

/**
 * What the runtime is told about a Thread when its Flue instance is created, and never again:
 * where it lives and who started it. Evolving facts come with each delivery instead.
 */
export const ThreadOrigin = Schema.Struct({
  creator: PersonId,
  creatorName: Schema.String,
})
export interface ThreadOrigin extends Schema.Schema.Type<typeof ThreadOrigin> {}

/** Everything waiting on the signed-in Person across the Threads they can see. */
export const Inbox = Schema.Struct({
  approvals: Schema.Array(Approval),
  requests: Schema.Array(InputRequest),
}).annotate({ identifier: 'Inbox', title: 'Inbox' })
export interface Inbox extends Schema.Schema.Type<typeof Inbox> {}
