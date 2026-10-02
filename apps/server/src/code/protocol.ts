import { CodeCallKind, CodeFailure } from '@vivid/contracts'
import { Schema } from 'effect'

/** IPC contains data and correlation only; Person/Thread/Connection authority stays in the parent. */
export const ParentMessage = Schema.TaggedUnion({
  Start: { code: Schema.String },
  Reply: { id: Schema.Int, value: Schema.Json },
})
export type ParentMessage = typeof ParentMessage.Type

/** Worker receipts are never trusted: only the parent records dispatch and completion. */
export const WorkerMessage = Schema.TaggedUnion({
  Call: {
    id: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    kind: CodeCallKind,
    input: Schema.Json,
  },
  Done: { result: Schema.Json },
  Failed: { failure: CodeFailure },
})
export type WorkerMessage = typeof WorkerMessage.Type

/** Malformed, oversized and broken pipe messages each stop the process; no untrusted text escapes. */
export class PipeFailure extends Schema.TaggedError<PipeFailure>()(
  'CodePipeFailure',
  {
    reason: Schema.Literals(['size', 'invalid', 'closed'] as const),
  },
  { title: 'Program pipe failure' },
) {}

export const decodeParent = Schema.decodeUnknownEffect(Schema.fromJsonString(ParentMessage))
export const decodeWorker = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkerMessage))
export const encodeParent = Schema.encodeSync(Schema.fromJsonString(ParentMessage))
export const encodeWorker = Schema.encodeSync(Schema.fromJsonString(WorkerMessage))
