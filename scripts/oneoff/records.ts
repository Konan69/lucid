import { PersonId } from '../../packages/contracts/src/index.ts'
import { Result, Schema } from 'effect'

/**
 * The canonical records Flue 2.2.2 kept in `flue_conversation_stream_batches.data`, the ones a
 * Vivid Thread's stream holds. Each batch is the JSON text of a non-empty array of records, in the
 * order Flue folded them (`@flue/postgres` 2.2.2 `adapter.mjs`, `appendBatch`). The shapes are
 * Flue's own record union (`@flue/runtime` 2.2.2 `dist/attachment-store-*.d.mts`,
 * `ConversationRecord`), cut down to the fields the import carries; a field Flue wrote that is not
 * read here is ignored, never invented.
 *
 * Only the types production's streams contain are handled. A record of any other type (a child
 * conversation, a compaction, a state write) fails its Thread's import by name: this importer has
 * no rule for it, and dropping it would carry a Thread that is not the one Flue kept.
 */

/** What every record carries (`ConversationRecordEnvelope`); `timestamp` is ISO capture time. */
const envelope = {
  v: Schema.Literal(1),
  id: Schema.String,
  conversationId: Schema.String,
  timestamp: Schema.String.check(
    Schema.makeFilter((text) => Number.isFinite(Date.parse(text)), {
      message: 'Expected an ISO timestamp',
    }),
  ),
  submissionId: Schema.optionalKey(Schema.String),
  /**
   * The attempt that wrote the record. A delivery that joined a running response is written under
   * its own submission and the host's attempt (`buildSubmissionInputRecord`, `asJoinedDelivery`).
   */
  attemptId: Schema.optionalKey(Schema.String),
}

/** A file Flue kept in `flue_attachments`, named by id with its size and SHA-256 hex digest. */
const AttachmentRef = Schema.Struct({
  id: Schema.String,
  mimeType: Schema.String,
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  digest: Schema.String,
  filename: Schema.optionalKey(Schema.String),
})
export interface AttachmentRef extends Schema.Schema.Type<typeof AttachmentRef> {}

const TextBlock = Schema.Struct({
  type: Schema.Literal('text'),
  text: Schema.String,
  textSignature: Schema.optionalKey(Schema.String),
})
const AttachmentBlock = Schema.Struct({
  type: Schema.Literal('attachment'),
  attachment: AttachmentRef,
})

/** User and tool-result content: words, or a reference to a kept file (`CanonicalUserContent`). */
export const ContentBlock = Schema.Union([TextBlock, AttachmentBlock]).pipe(
  Schema.toTaggedUnion('type'),
)
export type ContentBlock = typeof ContentBlock.Type

/** pi-ai's `Usage`, as Flue copied it from the provider's answer. */
const Usage = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
  cacheWrite1h: Schema.optionalKey(Schema.Finite),
  reasoning: Schema.optionalKey(Schema.Finite),
  totalTokens: Schema.Finite,
  cost: Schema.Struct({
    input: Schema.Finite,
    output: Schema.Finite,
    cacheRead: Schema.Finite,
    cacheWrite: Schema.Finite,
    total: Schema.Finite,
  }),
})

/** The conversation's birth, with the Thread's creator as the server sent it (`initialData`). */
const ConversationCreated = Schema.Struct({
  ...envelope,
  type: Schema.Literal('conversation_created'),
  kind: Schema.Literal('root'),
  initialData: Schema.Struct({ creator: PersonId, creatorName: Schema.String }),
})

const UserMessage = Schema.Struct({
  ...envelope,
  type: Schema.Literal('user_message'),
  content: Schema.Array(ContentBlock),
})

const Signal = Schema.Struct({
  ...envelope,
  type: Schema.Literal('signal'),
  signalType: Schema.String,
  tagName: Schema.optionalKey(Schema.String),
  content: Schema.String,
  attributes: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
})

/** `responseMetadata` is what main's `useResponseStart` stamped on a response's first message. */
const AssistantStarted = Schema.Struct({
  ...envelope,
  type: Schema.Literal('assistant_message_started'),
  messageId: Schema.String,
  modelInfo: Schema.Struct({
    api: Schema.String,
    provider: Schema.String,
    model: Schema.String,
    responseModel: Schema.optionalKey(Schema.String),
    responseId: Schema.optionalKey(Schema.String),
  }),
  responseMetadata: Schema.optionalKey(
    Schema.Struct({ startedAt: Schema.optionalKey(Schema.Finite) }),
  ),
})

const blockStart = {
  ...envelope,
  messageId: Schema.String,
  blockId: Schema.String,
  blockIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}
const blockDelta = {
  ...envelope,
  messageId: Schema.String,
  blockId: Schema.String,
  sequence: Schema.Int,
  delta: Schema.String,
}
const blockEnd = {
  ...envelope,
  messageId: Schema.String,
  blockId: Schema.String,
  deltaCount: Schema.Int,
}

const TextStarted = Schema.Struct({ ...blockStart, type: Schema.Literal('assistant_text_started') })
const TextDelta = Schema.Struct({ ...blockDelta, type: Schema.Literal('assistant_text_delta') })
const TextCompleted = Schema.Struct({
  ...blockEnd,
  type: Schema.Literal('assistant_text_completed'),
  textSignature: Schema.optionalKey(Schema.String),
})
const ReasoningStarted = Schema.Struct({
  ...blockStart,
  type: Schema.Literal('assistant_reasoning_started'),
})
const ReasoningDelta = Schema.Struct({
  ...blockDelta,
  type: Schema.Literal('assistant_reasoning_delta'),
})
/** `encrypted` is the provider's opaque thinking signature (Flue gave it as `thinkingSignature`). */
const ReasoningCompleted = Schema.Struct({
  ...blockEnd,
  type: Schema.Literal('assistant_reasoning_completed'),
  encrypted: Schema.optionalKey(Schema.String),
  redacted: Schema.optionalKey(Schema.Boolean),
})
const ToolCall = Schema.Struct({
  ...blockStart,
  type: Schema.Literal('assistant_tool_call'),
  toolCallId: Schema.String,
  name: Schema.String,
  arguments: Schema.Record(Schema.String, Schema.Json),
  thoughtSignature: Schema.optionalKey(Schema.String),
})
const AssistantCompleted = Schema.Struct({
  ...envelope,
  type: Schema.Literal('assistant_message_completed'),
  messageId: Schema.String,
  stopReason: Schema.Literals([
    'pending',
    'stop',
    'length',
    'toolUse',
    'error',
    'aborted',
    'deferred',
  ]),
  usage: Usage,
  error: Schema.optionalKey(Schema.String),
})

/** One tool's result, held until a `tool_results_committed` names it by its record id. */
const ToolOutcome = Schema.Struct({
  ...envelope,
  type: Schema.Literal('tool_outcome'),
  assistantMessageId: Schema.String,
  toolCallId: Schema.String,
  toolName: Schema.String,
  isError: Schema.Boolean,
  content: Schema.Array(ContentBlock),
  output: Schema.optionalKey(Schema.Json),
  durationMs: Schema.optionalKey(Schema.Finite),
})
const ToolResultsCommitted = Schema.Struct({
  ...envelope,
  type: Schema.Literal('tool_results_committed'),
  assistantMessageId: Schema.String,
  outcomeIds: Schema.Array(Schema.String),
})

const SubmissionSettled = Schema.Struct({
  ...envelope,
  type: Schema.Literal('submission_settled'),
  submissionId: Schema.String,
  outcome: Schema.Literals(['completed', 'failed', 'aborted']),
})

/** What main's `useResponseFinish` recorded for a response (`finishedAt`, `toolCallCount`). */
const MessageMetadata = Schema.Struct({
  ...envelope,
  type: Schema.Literal('message_metadata'),
  metadata: Schema.Struct({
    finishedAt: Schema.optionalKey(Schema.Finite),
    toolCallCount: Schema.optionalKey(Schema.Int),
  }),
})

/** Flue's model-resource bookkeeping and start-hook marker: nothing a transcript holds. */
const ResourceSnapshot = Schema.Struct({ ...envelope, type: Schema.Literal('resource_snapshot') })
const AgentStartRun = Schema.Struct({ ...envelope, type: Schema.Literal('agent_start_run') })

/** Every record type the import reads, by its `type`. */
export const FlueRecord = Schema.Union([
  ConversationCreated,
  UserMessage,
  Signal,
  AssistantStarted,
  TextStarted,
  TextDelta,
  TextCompleted,
  ReasoningStarted,
  ReasoningDelta,
  ReasoningCompleted,
  ToolCall,
  AssistantCompleted,
  ToolOutcome,
  ToolResultsCommitted,
  SubmissionSettled,
  MessageMetadata,
  ResourceSnapshot,
  AgentStartRun,
]).pipe(Schema.toTaggedUnion('type'))
export type FlueRecord = typeof FlueRecord.Type

/** A record of a type this import has no rule for. Its Thread is not carried. */
export class RecordUnknown extends Schema.TaggedError<RecordUnknown>()(
  'RecordUnknown',
  { recordType: Schema.String, recordId: Schema.String },
  { title: 'Flue record type is not handled' },
) {
  override get message() {
    return `Record ${this.recordId} has type ${this.recordType}, which the import does not handle`
  }
}

/**
 * A batch or a record that does not have Flue's shape. Schema's rendering of the value is not
 * kept: a record can quote a Person's words.
 */
export class RecordInvalid extends Schema.TaggedError<RecordInvalid>()(
  'RecordInvalid',
  { recordType: Schema.String, recordId: Schema.String },
  { title: 'Flue record is invalid' },
) {
  override get message() {
    return `Record ${this.recordId} of type ${this.recordType} does not have Flue's shape`
  }
}

/** The part of a record read before its type is known to be one this import handles. */
const Envelope = Schema.Struct({ id: Schema.String, type: Schema.String })
/** A batch is an array of JSON objects; each is decoded as a record on its own. */
const decodeBatch = Schema.decodeUnknownResult(
  Schema.fromJsonString(Schema.Array(Schema.Record(Schema.String, Schema.Json))),
)
const decodeEnvelope = Schema.decodeUnknownResult(Envelope)
const decodeRecord = Schema.decodeUnknownResult(FlueRecord)

/** One record: its type first, so an unknown type is told apart from a malformed known one. */
function decodeOne(
  raw: Schema.JsonObject,
): Result.Result<FlueRecord, RecordUnknown | RecordInvalid> {
  const head = decodeEnvelope(raw)
  if (Result.isFailure(head))
    return Result.fail(new RecordInvalid({ recordType: 'unreadable', recordId: 'unreadable' }))
  const { id, type } = head.success
  if (!Object.hasOwn(FlueRecord.cases, type))
    return Result.fail(new RecordUnknown({ recordType: type, recordId: id }))
  return Result.mapError(
    decodeRecord(raw),
    () => new RecordInvalid({ recordType: type, recordId: id }),
  )
}

/**
 * One batch's `data` text, decoded once at ingress into the records it holds, in their order.
 * The first record that is unknown or malformed fails the whole batch.
 */
export function decodeRecords(
  data: string,
): Result.Result<ReadonlyArray<FlueRecord>, RecordUnknown | RecordInvalid> {
  const batch = decodeBatch(data)
  if (Result.isFailure(batch))
    return Result.fail(new RecordInvalid({ recordType: 'batch', recordId: 'batch' }))
  const records: Array<FlueRecord> = []
  for (const raw of batch.success) {
    const record = decodeOne(raw)
    if (Result.isFailure(record)) return Result.fail(record.failure)
    records.push(record.success)
  }
  return Result.succeed(records)
}
