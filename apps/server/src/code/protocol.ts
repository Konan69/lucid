import { CodeCallKind, CodeFailure, CodeLogs } from '@vivid/contracts/code'
import * as Schema from 'effect/Schema'

/** IPC contains data and correlation only; Person/Thread/Connection authority stays in the parent. */
export const ParentMessage = Schema.TaggedUnion({
  Start: { code: Schema.String },
  Cancel: {},
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
  Done: { result: Schema.Json, ...CodeLogs.fields },
  Failed: { failure: CodeFailure, ...CodeLogs.fields },
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

export const decodeWorker = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkerMessage))
export const encodeParent = Schema.encodeEffect(Schema.fromJsonString(ParentMessage))
