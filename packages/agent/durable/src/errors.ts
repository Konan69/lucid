import type { ConversationId as PiConversationId } from '@earendil-works/pi-durable'
import { Effect, Predicate, Schema } from 'effect'

/** Pi's types.ts Id is an erased numeric brand; retain that identity in the shared error contract. */
const ConversationId = Schema.declare<PiConversationId>((value): value is PiConversationId =>
  Predicate.isNumber(value),
)

/** Opaque durable tool-task identity; callers obtain it from Waiting or an approval request. */
export const HoldId = Schema.String.check(Schema.isPattern(/^hold:[1-9][0-9]*$/u)).pipe(
  Schema.brand('Durable.HoldId'),
)
export type HoldId = typeof HoldId.Type

/** The harness owns conversation identity; errors retain the requested identifier verbatim. */
export class ConversationMissing extends Schema.TaggedError<ConversationMissing>()(
  'ConversationMissing',
  { conversationId: ConversationId },
  { title: 'ConversationMissing' },
) {
  /** Keep the missing identity visible to Promise callers and Pi diagnostics. */
  override get message() {
    return `Conversation ${this.conversationId} is missing`
  }
}

/** One rejected Pi call, distinguished by the public operation rather than its error text. */
export class PiFailed extends Schema.TaggedError<PiFailed>()(
  'PiFailed',
  {
    operation: Schema.Literals([
      'conversation',
      'snapshot',
      'commit',
      'submit',
      'watch',
      'agent',
      'context',
      'doc',
      'abort',
      'entries',
      'submission',
      'status',
    ]),
    cause: Schema.Defect(),
  },
  { title: 'PiFailed' },
) {
  /** Pi uses this diagnostic as the block reason when an adapter rejects. */
  override get message() {
    const text = Predicate.isError(this.cause) ? this.cause.message : String(this.cause)
    return `Pi ${this.operation} failed: ${text}`
  }
}

/** The latest chat message cannot start or resume a run. */
export class TurnInvalid extends Schema.TaggedError<TurnInvalid>()(
  'TurnInvalid',
  {
    reason: Schema.Literals(['Malformed', 'Regeneration']).pipe(
      Schema.withConstructorDefault(Effect.succeed('Malformed')),
    ),
  },
  { title: 'TurnInvalid' },
) {
  /** Match the HTTP ingress diagnostic for a malformed turn. */
  override get message() {
    return this.reason === 'Regeneration'
      ? 'Regeneration is not supported'
      : 'Expected a user message or a message with tool calls'
  }
}

/** A reconnect pair is incomplete, malformed, or names a step beyond the captured run. */
export class RejoinInvalid extends Schema.TaggedError<RejoinInvalid>()(
  'RejoinInvalid',
  {},
  { title: 'RejoinInvalid' },
) {
  /** Keep query diagnostics short without echoing client-supplied identifiers. */
  override get message() {
    return 'Invalid reconnect state'
  }
}

/** A user file has no Pi input representation; its URL is never fetched or echoed in diagnostics. */
export class PartUnsupported extends Schema.TaggedError<PartUnsupported>()(
  'PartUnsupported',
  { mediaType: Schema.String },
  { title: 'PartUnsupported' },
) {
  /** Hosts can explain the unsupported media without disclosing a supplied URL or payload. */
  override get message() {
    return `Unsupported file part (${this.mediaType}); use an inline base64 image`
  }
}

/** A decoded image exceeds the host's explicit per-part byte budget; no default is imposed. */
export class PartTooLarge extends Schema.TaggedError<PartTooLarge>()(
  'PartTooLarge',
  { bytes: Schema.Number, limit: Schema.Number },
  { title: 'PartTooLarge' },
) {
  /** Report byte units, never the submitted image or URL. */
  override get message() {
    return `File part is ${this.bytes} bytes; limit is ${this.limit} bytes`
  }
}

/** A host byte budget must be a finite nonnegative whole number, before request reading/admission. */
export class LimitInvalid extends Schema.TaggedError<LimitInvalid>()(
  'LimitInvalid',
  { value: Schema.UndefinedOr(Schema.Number) },
  { title: 'LimitInvalid' },
) {
  /** This is a host configuration fault, not a client's unsupported part. */
  override get message() {
    return 'Part byte limit must be a finite nonnegative integer'
  }
}

/** None of the stored assistant messages made the tool calls named by a resume. */
export class RunMissing extends Schema.TaggedError<RunMissing>()(
  'RunMissing',
  {
    conversationId: ConversationId,
  },
  { title: 'RunMissing' },
) {
  /** Retain the conversation for callers resolving a stale resume. */
  override get message() {
    return `No run in conversation ${this.conversationId} made these tool calls`
  }
}

/** The AI SDK could not derive the JSON Schema Pi needs to register this tool. */
export class ToolSchemaFailed extends Schema.TaggedError<ToolSchemaFailed>()(
  'ToolSchemaFailed',
  {
    toolName: Schema.String,
    cause: Schema.Defect(),
  },
  { title: 'ToolSchemaFailed' },
) {
  /** Expose schema-generation failures without discarding the tool identity. */
  override get message() {
    const text = Predicate.isError(this.cause) ? this.cause.message : String(this.cause)
    return `Tool ${this.toolName} schema failed: ${text}`
  }
}

/** An AI SDK execution/validation operation rejected; Pi reports this as a failed tool call. */
export class ToolFailed extends Schema.TaggedError<ToolFailed>()(
  'ToolFailed',
  {
    toolName: Schema.String,
    cause: Schema.Defect(),
  },
  { title: 'ToolFailed' },
) {
  /** Keep the provider's diagnostic visible to Pi's tool-result error formatting. */
  override get message() {
    return Predicate.isError(this.cause) ? this.cause.message : String(this.cause)
  }
}

/** The SDK output could not be serialized into the durable JSON result representation. */
export class ToolOutputFailed extends Schema.TaggedError<ToolOutputFailed>()(
  'ToolOutputFailed',
  {
    toolName: Schema.String,
    cause: Schema.Defect(),
  },
  { title: 'ToolOutputFailed' },
) {
  /** Preserve the host serialization diagnostic in Pi's output-error chunk. */
  override get message() {
    return Predicate.isError(this.cause) ? this.cause.message : String(this.cause)
  }
}

/** Pi replaced incremental events with a snapshot; reconnect to rebuild rather than lose frames. */
export class WatchOverflowed extends Schema.TaggedError<WatchOverflowed>()(
  'WatchOverflowed',
  {
    conversationId: ConversationId,
  },
  { title: 'WatchOverflowed' },
) {
  /** A reconnect is required because the current stream no longer has a complete history. */
  override get message() {
    return `Watch for conversation ${this.conversationId} overflowed`
  }
}

/** Unexpected observation termination is distinct from a successfully completed run. */
export class WatchClosed extends Schema.TaggedError<WatchClosed>()(
  'WatchClosed',
  {
    conversationId: ConversationId,
    reason: Schema.Literals(['cancelled', 'session_closed']),
  },
  { title: 'WatchClosed' },
) {
  /** Preserve Pi's terminal reason for reconnect diagnostics. */
  override get message() {
    return `Watch for conversation ${this.conversationId} closed: ${this.reason}`
  }
}

/** An unsolicited or stale settlement cannot authorize a tool task. */
export class CallNotWaiting extends Schema.TaggedError<CallNotWaiting>()(
  'CallNotWaiting',
  { conversationId: ConversationId, holdId: HoldId },
  { title: 'CallNotWaiting' },
) {
  /** Preserve the call and conversation that require a refreshed waiting view. */
  override get message() {
    return `Hold ${this.holdId} in conversation ${this.conversationId} is not waiting`
  }
}

/** A wire value cannot identify a durable tool task. */
export class HoldIdInvalid extends Schema.TaggedError<HoldIdInvalid>()(
  'HoldIdInvalid',
  {},
  { title: 'HoldIdInvalid' },
) {
  /** Avoid echoing supplied wire input in diagnostics. */
  override get message() {
    return 'Invalid hold id'
  }
}

/** An opaque history cursor must name a whole message boundary in the authorized conversation. */
export class HistoryCursorInvalid extends Schema.TaggedError<HistoryCursorInvalid>()(
  'HistoryCursorInvalid',
  { conversationId: ConversationId },
  { title: 'HistoryCursorInvalid' },
) {
  override get message() {
    return 'Invalid history cursor'
  }
}

/** History page sizes are positive whole message counts, never entry counts. */
export class HistoryPageInvalid extends Schema.TaggedError<HistoryPageInvalid>()(
  'HistoryPageInvalid',
  { conversationId: ConversationId },
  { title: 'HistoryPageInvalid' },
) {
  override get message() {
    return 'History limit must be a positive integer'
  }
}

/** A resolver or SDK context validator failed before the tool acquired its scoped authority. */
export class ToolContextFailed extends Schema.TaggedError<ToolContextFailed>()(
  'ToolContextFailed',
  { toolName: Schema.String, cause: Schema.Defect() },
  { title: 'ToolContextFailed' },
) {
  /** Name the tool without discarding the resolver's diagnostic. */
  override get message() {
    const text = Predicate.isError(this.cause) ? this.cause.message : String(this.cause)
    return `Tool ${this.toolName} context failed: ${text}`
  }
}

/** A durable approval rule cannot suspend or produce a truthy value other than a boolean. */
export class ToolApprovalUnsupported extends Schema.TaggedError<ToolApprovalUnsupported>()(
  'ToolApprovalUnsupported',
  { toolName: Schema.String },
  { title: 'ToolApprovalUnsupported' },
) {
  /** Explain the unsupported asynchronous contract without awaiting an unsafe decision. */
  override get message() {
    return `Tool ${this.toolName}: an asynchronous approval function is not supported; needsApproval must return a synchronous boolean`
  }
}

/** Approval presentation has validated arguments but no execution authority or call options. */
export class ToolApprovalContextUnavailable extends Schema.TaggedError<ToolApprovalContextUnavailable>()(
  'ToolApprovalContextUnavailable',
  { toolName: Schema.String, field: Schema.Literals(['toolCallId', 'messages', 'context']) },
  { title: 'ToolApprovalContextUnavailable' },
) {
  /** Refuse missing context explicitly, so a predicate cannot approve against invented identity. */
  override get message() {
    return `Tool ${this.toolName} approval cannot access ${this.field}; only a pure synchronous predicate over validated input is supported`
  }
}

/** Hook ownership cannot disambiguate duplicate names across selected extensions in Pi 1.0.4. */
export class ToolNameDuplicated extends Schema.TaggedError<ToolNameDuplicated>()(
  'ToolNameDuplicated',
  { toolName: Schema.String },
  { title: 'ToolNameDuplicated' },
) {
  override get message() {
    return `Tool ${this.toolName}: tool names must be unique across extensions`
  }
}

/** A broken approval policy blocks one call without failing stream or history readers. */
export class ToolApprovalFailed extends Schema.TaggedError<ToolApprovalFailed>()(
  'ToolApprovalFailed',
  { toolName: Schema.String, cause: Schema.Defect() },
  { title: 'ToolApprovalFailed' },
) {
  override get message() {
    return `Tool ${this.toolName} approval failed: ${Predicate.isError(this.cause) ? this.cause.message : String(this.cause)}`
  }
}
