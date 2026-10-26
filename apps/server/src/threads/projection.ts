import {
  ConversationMessage,
  ConversationPart,
  ConversationSettlement,
  type ConversationState,
  type ThreadId,
} from '@vivid/contracts'
import { Array as Arr, Result, Schema } from 'effect'

/** Flue 2.2.2 history is decoded once here; data writers never enter the product view. */
const File = Schema.Struct({
  type: Schema.Literal('file'),
  mediaType: Schema.String,
  id: Schema.optionalKey(Schema.String),
  filename: Schema.optionalKey(Schema.String),
})
const Part = Schema.Union([
  File,
  ...ConversationPart.members,
  Schema.Struct({ type: Schema.TemplateLiteral(['data-', Schema.String]), data: Schema.Json }),
])
const Message = Schema.Struct({ ...ConversationMessage.fields, parts: Schema.Array(Part) })
const Settlement = Schema.Struct({
  submissionId: Schema.String,
  outcome: ConversationSettlement.fields.outcome,
  answeredBySubmissionId: Schema.optionalKey(Schema.String),
})
export const FlueHistory = Schema.Struct({
  v: Schema.Literal(1),
  conversationId: Schema.String,
  offset: Schema.String,
  messages: Schema.Array(Message),
  settlements: Schema.Array(Settlement),
})
export type FlueHistory = typeof FlueHistory.Type

/** SDK index.mjs:withAttachmentUrls resolves durable ids; only the product gateway may serve them. */
function projectPart(
  part: typeof Part.Type,
  threadId: ThreadId,
): Result.Result<ConversationPart, void> {
  switch (part.type) {
    case 'text':
    case 'reasoning':
    case 'dynamic-tool':
      return Result.succeed(part)
    case 'file':
      return Result.succeed({
        type: 'file',
        mediaType: part.mediaType,
        filename: part.filename,
        url:
          'id' in part && part.id !== undefined
            ? `/api/vivid/${encodeURIComponent(threadId)}/attachments/${encodeURIComponent(part.id)}`
            : undefined,
      })
    default:
      return Result.fail(undefined)
  }
}

/**
 * Flue already classifies messages and advisories, so its purpose/display remain authoritative.
 * @flue/react 2.2.2 dist/index.mjs:converge calls observed submissions without settlements active,
 * and also treats streaming text/reasoning as activity. Flue exposes no inbox; the other
 * unsettled submissions are the agreed queued reading while the oldest one is being answered.
 */
export function projectConversation(
  history: Pick<FlueHistory, 'messages' | 'settlements'>,
  threadId: ThreadId,
  keys: ReadonlyMap<string, string>,
): ConversationState {
  const settled = new Set(history.settlements.map((settlement) => settlement.submissionId))
  const submissions = new Set(
    history.messages.flatMap((message) =>
      message.submissionId === undefined ? [] : [message.submissionId],
    ),
  )
  const active = [...submissions].filter((id) => !settled.has(id))
  const streaming = history.messages.some(
    (message) =>
      message.role === 'assistant' &&
      message.parts.some(
        (part) => (part.type === 'text' || part.type === 'reasoning') && part.state === 'streaming',
      ),
  )
  return {
    messages: history.messages.map((message) =>
      ConversationMessage.make({
        ...message,
        key:
          message.role !== 'assistant' &&
          message.settlement === undefined &&
          message.submissionId !== undefined
            ? keys.get(message.submissionId)
            : undefined,
        parts: Arr.filterMap(message.parts, (part) => projectPart(part, threadId)),
      }),
    ),
    settlements: history.settlements.map((settlement) =>
      ConversationSettlement.make({
        submissionId: settlement.submissionId,
        outcome: settlement.outcome,
        answeredBy: settlement.answeredBySubmissionId,
      }),
    ),
    working: active.length > 0 || streaming,
    queued: Math.max(0, active.length - 1),
  }
}
