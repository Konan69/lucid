import { Schema } from 'effect'
import { ThreadId } from './identity.js'

/** Closed Thread lifecycle values encoded by the current HTTP protocol. */
export const ThreadStatus = Schema.Literals(['active', 'archived'] as const)

/** Thread summary exchanged by web, mobile, and the conversation runtime. */
export const Thread = Schema.Struct({
  id: ThreadId,
  title: Schema.String,
  preview: Schema.String,
  updatedAt: Schema.Number,
  archived: Schema.Boolean,
}).annotate({ identifier: 'Thread', title: 'Thread' })
/** Decoded Thread summary. */
export interface Thread extends Schema.Schema.Type<typeof Thread> {}

/** Complete replacement input for a Thread summary. */
export const PutThreadRequest = Schema.Struct({
  title: Schema.String,
  preview: Schema.String,
  updatedAt: Schema.optionalKey(Schema.Number),
  archived: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: 'PutThreadRequest', title: 'Put Thread request' })
/** Decoded Thread replacement input. */
export interface PutThreadRequest extends Schema.Schema.Type<typeof PutThreadRequest> {}

/** Partial Thread fields accepted by the current PATCH route. */
export const PatchThreadRequest = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  archived: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: 'PatchThreadRequest', title: 'Patch Thread request' })
/** Decoded Thread patch input. */
export interface PatchThreadRequest extends Schema.Schema.Type<typeof PatchThreadRequest> {}

/** Thread path parameters used by conversation routes. */
export const ThreadParams = Schema.Struct({ id: ThreadId })
/** List response for Threads. */
export const ThreadListResponse = Schema.Struct({ conversations: Schema.Array(Thread) })
/** Decoded Thread list response. */
export interface ThreadListResponse extends Schema.Schema.Type<typeof ThreadListResponse> {}
/** Single Thread response. */
export const ThreadResponse = Schema.Struct({ conversation: Thread })
/** Decoded single Thread response. */
export interface ThreadResponse extends Schema.Schema.Type<typeof ThreadResponse> {}

/** One server-owned request for Flue to accept a Run without owning product state. */
export const RuntimeRunRequest = Schema.Struct({
  threadId: ThreadId,
  idempotencyKey: Schema.String,
  type: Schema.Literals(['follow-up', 'schedule'] as const),
  body: Schema.String,
  attributes: Schema.Record(Schema.String, Schema.String),
})
export interface RuntimeRunRequest extends Schema.Schema.Type<typeof RuntimeRunRequest> {}

/** Flue's durable receipt for one accepted Run. */
export const RuntimeRunResponse = Schema.Struct({ submissionId: Schema.String })
export interface RuntimeRunResponse extends Schema.Schema.Type<typeof RuntimeRunResponse> {}
