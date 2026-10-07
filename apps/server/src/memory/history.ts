import { RunId, ThreadId } from '@vivid/contracts'
import { Array as Arr, Effect, Option, Schema } from 'effect'
import { HttpClientResponse } from 'effect/unstable/http'
import type { RuntimeService } from '../runtime/client.ts'
import type { LearningInput } from './learn.ts'
import { MemoryExchange } from './extract.ts'

/** Decode only the history projection learning consumes. Flue owns all other parts and metadata.
 * Installed @flue/sdk 2.1 flue-client docs and runtime canonical projection show signal text is
 * the original body, with the speaker in signal.attributes.from, rather than rendered XML. */
const Text = Schema.Struct({
  type: Schema.Literal('text'),
  text: Schema.String,
  state: Schema.Literals(['streaming', 'done']),
})
const Message = Schema.Struct({
  role: Schema.Literals(['user', 'assistant', 'system']),
  purpose: Schema.Literals(['user', 'assistant', 'dispatch', 'advisory']),
  submissionId: Schema.optionalKey(Schema.String),
  signal: Schema.optionalKey(
    Schema.Struct({
      tagName: Schema.optionalKey(Schema.String),
      attributes: Schema.optionalKey(
        Schema.Struct({ from: Schema.optionalKey(Schema.NonEmptyString) }),
      ),
    }),
  ),
  parts: Schema.Array(
    Schema.Union([
      Text,
      Schema.Struct({
        type: Schema.String.check(Schema.isPattern(/^(?:reasoning|file|dynamic-tool|data-.+)$/u)),
      }),
    ]),
  ),
})
const History = Schema.Struct({
  v: Schema.Literal(1),
  messages: Schema.Array(Message),
  settlements: Schema.Array(
    Schema.Struct({
      submissionId: Schema.String,
      outcome: Schema.Literals(['completed', 'failed', 'aborted']),
      answeredBySubmissionId: Schema.optionalKey(Schema.String),
    }),
  ),
})
const decodeHistory = HttpClientResponse.schemaBodyJson(History)
type Message = typeof Message.Type
type Context = Pick<MemoryExchange, 'previousReply' | 'recent'>

/** Missing/malformed history is a context failure, never a reason to undo settlement or learning. */
class MemoryHistoryUnavailable extends Schema.TaggedError<MemoryHistoryUnavailable>()(
  'MemoryHistoryUnavailable',
  { threadId: ThreadId, runId: RunId },
  { title: 'Memory conversation context unavailable' },
) {}

/** Tools, reasoning, attachments and unfinished text are never evidence for memory extraction. */
export const textOf = (message: Message) =>
  message.parts
    .flatMap((part) => ('text' in part && part.state === 'done' ? [part.text] : []))
    .join('\n')

/** History transport status is independent of a particular Run or consumer. */
class ConversationHistoryUnavailable extends Schema.TaggedError<ConversationHistoryUnavailable>()(
  'ConversationHistoryUnavailable',
  { threadId: ThreadId },
  { title: 'Conversation history unavailable' },
) {}

/** Read the canonical Flue projection once at ingress; memory and Thread titles share this path. */
export const readConversationHistory = Effect.fn('Conversation.history')(function* (
  runtime: Pick<RuntimeService, 'read'>,
  threadId: ThreadId,
) {
  const response = yield* runtime.read({
    threadId,
    suffix: '',
    search: '?view=history',
    accept: 'application/json',
  })
  if (response.status < 200 || response.status >= 300)
    return yield* ConversationHistoryUnavailable.make({ threadId })
  return yield* decodeHistory(response)
})

/** Shared deliveries carry names. A historical plain user turn belongs only to the creator;
 * omit it when that creator is not the current Person rather than attributing it to the asker. */
function speakerOf(message: Message, input: LearningInput): Option.Option<string> {
  if (message.purpose === 'user' && input.thread.personId === input.person.id)
    return Option.some(input.person.name)
  if (message.purpose !== 'dispatch' || message.signal === undefined) return Option.none()
  const signal = message.signal
  if (signal.tagName !== 'message' || signal.attributes === undefined) return Option.none()
  return Option.fromUndefinedOr(signal.attributes.from)
}

/** Prior context is at most six whole exchanges and 8,000 UTF-16 characters, including names
 * and the previous reply (last 2,000 characters). Preserve the newest contiguous suffix;
 * never slice a Person's statement into a different fact to fill the remaining budget. */
function bounded(previous: Option.Option<string>, recent: MemoryExchange['recent']): Context {
  const previousReply = Option.getOrNull(Option.map(previous, (reply) => reply.slice(-2000)))
  let remaining = 8000 - (previousReply === null ? 0 : previousReply.length)
  const kept: Array<MemoryExchange['recent'][number]> = []
  for (const exchange of Arr.reverse(recent.slice(-6))) {
    const size = exchange.speaker.length + exchange.message.length + exchange.reply.length
    if (size > remaining) break
    kept.push(exchange)
    remaining -= size
  }
  return { previousReply, recent: Arr.reverse(kept) }
}

/** Submission identity anchors context before this message, excluding later deliveries and its
 * own coalesced response. Only completed replies can form prior exchanges; signals that wake
 * Vivid for schedules or approvals are not statements made by a Person. */
function contextOf(history: typeof History.Type, input: LearningInput): Option.Option<Context> {
  const position = history.messages.findIndex(
    (message) => message.submissionId === input.runId && Option.isSome(speakerOf(message, input)),
  )
  if (position < 0) return Option.none()
  const hosts = new Map(
    history.settlements.flatMap((settlement) => {
      if (settlement.outcome !== 'completed') return []
      const host = settlement.answeredBySubmissionId
      return [
        [settlement.submissionId, host === undefined ? settlement.submissionId : host] as const,
      ]
    }),
  )
  const currentHost = hosts.get(input.runId)
  const prior = history.messages.slice(0, position)
  const replies = new Map(
    prior.flatMap((message) => {
      if (message.purpose !== 'assistant' || message.submissionId === undefined) return []
      if (message.submissionId === currentHost || !hosts.has(message.submissionId)) return []
      const text = textOf(message)
      return text.trim().length === 0 ? [] : [[message.submissionId, text] as const]
    }),
  )
  const recent = prior.flatMap((message) => {
    const speaker = speakerOf(message, input)
    if (Option.isNone(speaker) || message.submissionId === undefined) return []
    const host = hosts.get(message.submissionId)
    if (host === undefined) return []
    const reply = replies.get(host)
    if (reply === undefined) return []
    return [{ speaker: speaker.value, message: textOf(message), reply }]
  })
  return Option.some(bounded(Option.fromUndefinedOr([...replies.values()].at(-1)), recent))
}

/** Runtime.read is the existing authenticated Flue client path. The installed SDK's history()
 * issues this same GET ?view=history, without pagination; nothing is copied into product tables.
 * A failed read logs once, without conversation content, and retains isolated-exchange learning. */
export const conversationContext = Effect.fn('Learning.context')(
  function* (runtime: Pick<RuntimeService, 'read'>, input: LearningInput) {
    const unavailable = () =>
      MemoryHistoryUnavailable.make({ threadId: input.thread.id, runId: input.runId })
    const history = yield* readConversationHistory(runtime, input.thread.id).pipe(
      Effect.mapError(unavailable),
    )
    const context = contextOf(history, input)
    if (Option.isNone(context)) return yield* unavailable()
    return context.value
  },
  (effect) =>
    effect.pipe(
      Effect.scoped,
      Effect.timeout('5 seconds'),
      Effect.catch((error) =>
        Effect.logWarning('Memory history unavailable; learning isolated exchange', {
          tag: error._tag,
        }).pipe(Effect.as<Context>({ previousReply: null, recent: [] })),
      ),
    ),
)
