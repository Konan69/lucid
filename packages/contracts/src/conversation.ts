import { Schema } from 'effect'

/**
 * One Thread's conversation as a screen reads it, and how it travels to a screen.
 *
 * The runtime holds the conversation (Pi Durable: transcript entries and the live document of the
 * reply being written). It does not send that to a client: Pi's own view carries the system prompt
 * and internal documents, which no screen may read. The runtime projects it into the state below
 * and sends that state once whole and afterwards as changes, the way Pi sends its own view
 * (`@earendil-works/pi-durable` README, "Watching a Conversation": a snapshot, then the operations
 * of each commit; a client that joins late or reconnects starts from the current state and nothing
 * is replayed). The server checks the Person and the Thread and relays the frames.
 *
 * The message and part shapes are the ones the web Thread and the phone's Chat already draw.
 * They were Flue's client types (`FlueConversationMessage` of `@flue/sdk` 2.2.2); they are
 * Vivid's own from here.
 */

/** Whether a piece of a reply is still being written. */
export const PartProgress = Schema.Literals(['streaming', 'done'])
export type PartProgress = typeof PartProgress.Type

const ToolCall = {
  type: Schema.Literal('dynamic-tool'),
  toolName: Schema.String,
  toolCallId: Schema.String,
  /** What the model called the tool with. A screen decodes the fields it draws from. */
  input: Schema.Unknown,
}

/**
 * One part of a message. `dynamic-tool` has one case per standing of the call, so a call that is
 * still running cannot carry a result and a failed one cannot carry an output.
 */
export const ConversationPart = Schema.Union([
  Schema.Struct({ type: Schema.Literal('text'), text: Schema.String, state: PartProgress }),
  Schema.Struct({ type: Schema.Literal('reasoning'), text: Schema.String, state: PartProgress }),
  Schema.Struct({
    type: Schema.Literal('file'),
    mediaType: Schema.String,
    /** Where the bytes are read: a path under the server's gateway, never a runtime address. */
    url: Schema.optional(Schema.String),
    filename: Schema.optional(Schema.String),
  }),
  Schema.Struct({ ...ToolCall, state: Schema.Literal('input-available') }),
  Schema.Struct({
    ...ToolCall,
    state: Schema.Literal('output-available'),
    /** The tool's receipt. A screen decodes the fields it draws from. */
    output: Schema.Unknown,
    durationMs: Schema.optional(Schema.Finite),
  }),
  Schema.Struct({
    ...ToolCall,
    state: Schema.Literal('output-error'),
    errorText: Schema.String,
    durationMs: Schema.optional(Schema.Finite),
  }),
])
export type ConversationPart = typeof ConversationPart.Type

/**
 * One message of the conversation.
 *
 * `purpose` says what the message is: a Person's words, Vivid's reply, a `dispatch` the server
 * delivered (a routine coming due, an answer, an approval's outcome, a shared message), or an
 * `advisory` the runtime wrote about a reply that failed or was stopped. `display` says whether
 * a screen draws it. `signal` is present on a dispatch: its kind and the attributes the server
 * sent with it. `submissionId` is the runtime's name for the delivery the message belongs to; a screen joins it
 * to the product Run whose `submissionId` is the same.
 */
export const ConversationMessage = Schema.Struct({
  id: Schema.String,
  role: Schema.Literals(['user', 'assistant', 'system']),
  purpose: Schema.Literals(['user', 'assistant', 'dispatch', 'advisory']),
  display: Schema.Literals(['visible', 'hidden', 'diagnostic']),
  submissionId: Schema.optional(Schema.String),
  /**
   * The delivery key the sending client made for this message (the `key` of `SendToThread`).
   * Present on a message placed from a client's send, private or shared; absent on everything
   * else: Vivid's replies, advisories, and deliveries the server made itself (a routine coming
   * due, an approval's outcome, an answer). It is opaque and exists for one thing: the client
   * that sent a message drew it at once, and recognises it by this key when it arrives here. It
   * grants nothing and identifies nobody.
   */
  key: Schema.optional(Schema.String),
  signal: Schema.optional(
    Schema.Struct({
      tagName: Schema.String,
      attributes: Schema.Record(Schema.String, Schema.String),
    }),
  ),
  /** Present on an advisory: how the reply it speaks of ended. */
  settlement: Schema.optional(Schema.Struct({ outcome: Schema.Literals(['failed', 'aborted']) })),
  /** When the message was committed, as an ISO 8601 instant. */
  timestamp: Schema.optional(Schema.String),
  parts: Schema.Array(ConversationPart),
  /** A reply's timing, in epoch milliseconds: when Vivid began it and when it ended. */
  metadata: Schema.optional(
    Schema.Struct({
      startedAt: Schema.optional(Schema.Finite),
      finishedAt: Schema.optional(Schema.Finite),
    }),
  ),
})
export interface ConversationMessage extends Schema.Schema.Type<typeof ConversationMessage> {}

/** How a delivery to the conversation ended. Only ended deliveries are listed. */
export const ConversationSettlement = Schema.Struct({
  submissionId: Schema.String,
  outcome: Schema.Literals(['completed', 'failed', 'aborted']),
  /**
   * The submission whose reply answered this delivery, in the same form as `submissionId`. It is
   * the delivery's own when its own run answered it, and another's when it arrived during a reply
   * and joined it, which is how a reader pairs a joined delivery with the reply that answered
   * it. Absent when the delivery was not answered (it failed or was stopped).
   */
  answeredBy: Schema.optional(Schema.String),
})
export interface ConversationSettlement extends Schema.Schema.Type<typeof ConversationSettlement> {}

/**
 * The whole state a screen draws one Thread's conversation from.
 *
 * `working` is true exactly while a run is answering in the runtime, whichever device started
 * it. `queued` counts deliveries that arrived during a reply and have not been placed yet.
 */
export const ConversationState = Schema.Struct({
  messages: Schema.Array(ConversationMessage),
  settlements: Schema.Array(ConversationSettlement),
  working: Schema.Boolean,
  queued: Schema.Int,
})
export interface ConversationState extends Schema.Schema.Type<typeof ConversationState> {}

/** The state of a Thread nothing has been said in. */
export const emptyConversation: ConversationState = {
  messages: [],
  settlements: [],
  working: false,
  queued: 0,
}

/**
 * One frame of the state link, runtime to server to screen.
 *
 * `Whole` carries the state: it is the first frame of every link, and it is sent again whenever
 * the sender replaced what it had queued for a slow reader with the newest state. `Changes`
 * carries the operations that turn the previous state into the next one, in the wire form of
 * `@earendil-works/chord/delta` (`Op`). They are opaque to this contract on purpose: the library
 * that made them is the one that checks and applies them (`assertValidOp`, `applyImmutable`), and
 * a reader that cannot apply a frame drops the link and takes the next `Whole`.
 */
export const ConversationFrame = Schema.TaggedUnion({
  Whole: { state: ConversationState },
  Changes: { ops: Schema.Array(Schema.Unknown) },
})
export type ConversationFrame = typeof ConversationFrame.Type
