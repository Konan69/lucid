import type { ConversationState } from '@vivid/contracts'
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { Database, decodeStored } from '../database/client.ts'
import { Admitted } from '../threads/conversation.ts'
import { runs } from '../threads/tables.ts'
import { readThreadHistory } from '../runtime/history.ts'
import { RunId, ThreadId } from '@vivid/contracts'
import { Array as Arr, Effect, Option, Schema } from 'effect'
import type { RuntimeService } from '../runtime/client.ts'
import type { LearningInput } from './learn.ts'
import { MemoryExchange } from './extract.ts'

type Message = Omit<ConversationState['messages'][number], 'submissionId'> & {
  readonly runId?: RunId
}
interface AttributedHistory {
  readonly messages: ReadonlyArray<Message>
  readonly settlements: ReadonlyArray<{
    readonly runId: RunId
    readonly outcome: 'completed' | 'failed' | 'aborted'
    readonly answeredBy?: RunId
  }>
}
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
    .flatMap((part) => (part.type === 'text' && part.state === 'done' ? [part.text] : []))
    .join('\n')

const decodeAdmission = decodeStored(Admitted, 'Conversation Run receipt')

/** Pi submission numbers are Person-local, whereas readers attribute words to product Runs.
 * Translate only persisted admission receipts of this Thread. Unrecorded submissions retain no
 * attribution, and a missing follow-up submissionId stays missing rather than being inferred.
 * Only receipts named by this state are decoded, so old Flue receipts outside the Pi transcript
 * cannot break a new Thread read. Submission numbers are trusted only while the Person's Pi store
 * has not been reset or restored; receipts cannot distinguish store generations. A matching corrupt receipt remains a typed database failure. */
export const attributedConversation = Effect.fn('Conversation.attribute')(function* (
  state: ConversationState,
  threadId: ThreadId,
) {
  const database = yield* Database
  const submissionIds = [
    ...new Set([
      ...state.messages.flatMap((message) =>
        message.submissionId === undefined ? [] : [message.submissionId],
      ),
      ...state.settlements.flatMap((settlement) =>
        settlement.answeredBy === undefined
          ? [settlement.submissionId]
          : [settlement.submissionId, settlement.answeredBy],
      ),
    ]),
  ]
  const rows = yield* database.run(
    database
      .select({ receipt: runs.receipt })
      .from(runs)
      .where(
        and(
          eq(runs.threadId, threadId),
          isNotNull(runs.admittedAt),
          inArray(sql<string>`${runs.receipt}->>'submissionId'`, submissionIds),
        ),
      ),
  )
  const admitted = yield* Effect.forEach(rows, (row) => decodeAdmission(row.receipt))
  const identities = new Map(
    admitted.map((receipt) => [String(receipt.submissionId), receipt.runId]),
  )
  const messages = state.messages.map((message): Message => {
    const { submissionId, ...unattributed } = message
    if (submissionId === undefined) return unattributed
    const runId = identities.get(submissionId)
    return runId === undefined ? unattributed : { ...unattributed, runId }
  })
  const settlements = state.settlements.flatMap((settlement) => {
    const runId = identities.get(settlement.submissionId)
    if (runId === undefined) return []
    const answeredBy =
      settlement.answeredBy === undefined ? undefined : identities.get(settlement.answeredBy)
    return answeredBy === undefined
      ? [{ runId, outcome: settlement.outcome }]
      : [{ runId, outcome: settlement.outcome, answeredBy }]
  })
  return { messages, settlements }
})

/** History consumers share the canonical state and its recorded product Run attribution. */
export const readConversationHistory = Effect.fn('Conversation.history')(function* (
  runtime: Pick<RuntimeService, 'read'>,
  threadId: ThreadId,
) {
  const history = yield* readThreadHistory(runtime, threadId)
  return yield* attributedConversation(history, threadId)
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
function contextOf(history: AttributedHistory, input: LearningInput): Option.Option<Context> {
  const position = history.messages.findIndex(
    (message) => message.runId === input.runId && Option.isSome(speakerOf(message, input)),
  )
  if (position < 0) return Option.none()
  const hosts = new Map(
    history.settlements.flatMap((settlement) => {
      if (settlement.outcome !== 'completed') return []
      const host = settlement.answeredBy
      return [[settlement.runId, host === undefined ? settlement.runId : host] as const]
    }),
  )
  const currentHost = hosts.get(input.runId)
  const prior = history.messages.slice(0, position)
  const replies = new Map(
    prior.flatMap((message) => {
      if (message.purpose !== 'assistant' || message.runId === undefined) return []
      if (message.runId === currentHost || !hosts.has(message.runId)) return []
      const text = textOf(message)
      return text.trim().length === 0 ? [] : [[message.runId, text] as const]
    }),
  )
  const recent = prior.flatMap((message) => {
    const speaker = speakerOf(message, input)
    if (Option.isNone(speaker) || message.runId === undefined) return []
    const host = hosts.get(message.runId)
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
