import type { ConversationId as PiConversationId } from '@earendil-works/pi-durable'
import { Predicate, Schema } from 'effect'

/** Pi's types.ts Id is an erased numeric brand; retain that identity in the shared error contract. */
const ConversationId = Schema.declare<PiConversationId>((value): value is PiConversationId =>
  Predicate.isNumber(value),
)

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
  {},
  { title: 'TurnInvalid' },
) {
  /** Match the HTTP ingress diagnostic for a malformed turn. */
  override get message() {
    return 'Expected a user message or a message with tool calls'
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
  { conversationId: ConversationId, callId: Schema.String },
  { title: 'CallNotWaiting' },
) {
  /** Preserve the call and conversation that require a refreshed waiting view. */
  override get message() {
    return `Call ${this.callId} in conversation ${this.conversationId} is not waiting`
  }
}
