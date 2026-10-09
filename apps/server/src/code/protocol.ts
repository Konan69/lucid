import { CodeCallKind, CodeFailure, CodeLogs } from '@vivid/contracts/code'
import * as Schema from 'effect/Schema'

/** Messages to the program's thread carry data and correlation only; Person, Thread and Connection authority stay with the supervisor. */
export const ParentMessage = Schema.TaggedUnion({
  Start: { code: Schema.String },
  Cancel: {},
  Reply: { id: Schema.Int, value: Schema.Json },
})
export type ParentMessage = typeof ParentMessage.Type

/** What the program's thread says is never a receipt: only the supervisor records dispatch and completion. */
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

/** A malformed or oversized message, or a thread that ended, each stop the program. */
export class PipeFailure extends Schema.TaggedError<PipeFailure>()(
  'CodePipeFailure',
  {
    reason: Schema.Literals(['size', 'invalid', 'closed'] as const),
  },
  { title: 'Program pipe failure' },
) {}

export const decodeParent = Schema.decodeUnknownEffect(Schema.fromJsonString(ParentMessage))
export const decodeWorker = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkerMessage))
export const encodeParent = Schema.encodeEffect(Schema.fromJsonString(ParentMessage))
export const encodeWorker = Schema.encodeEffect(Schema.fromJsonString(WorkerMessage))
/** A program's own data as JSON text, decoded to the value its call carries. */
export const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))
