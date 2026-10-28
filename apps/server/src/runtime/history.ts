import { ConversationState, RunId, RuntimeUnavailable, type ThreadId } from '@vivid/contracts'
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { Effect } from 'effect'
import { Database, decodeStored } from '../database/client.ts'
import { Admitted } from '../threads/conversation.ts'
import { runs } from '../threads/tables.ts'
import { HttpClientResponse } from 'effect/http'
import type { RuntimeService } from './client.ts'

/** Decode canonical conversation state once before server consumers attribute it to product Runs. */
export const readThreadHistory = Effect.fn('Runtime.history')(function* (
  runtime: Pick<RuntimeService, 'read'>,
  threadId: ThreadId,
) {
  const response = yield* runtime.read({
    threadId,
    suffix: '',
  })
  if (response.status < 200 || response.status >= 300)
    return yield* RuntimeUnavailable.make({ message: 'Conversation history could not be read' })
  const state = yield* HttpClientResponse.schemaBodyJson(ConversationState)(response).pipe(
    Effect.mapError(() => RuntimeUnavailable.make({ message: 'Conversation history is invalid' })),
  )
  return state
})

type Message = Omit<ConversationState['messages'][number], 'submissionId'> & {
  readonly runId?: RunId
}
/** Tools, reasoning, attachments and unfinished text are never conversation text for titles or approval context. */
export const textOf = (message: Message) =>
  message.parts
    .flatMap((part) => (part.type === 'text' && part.state === 'done' ? [part.text] : []))
    .join('\n')

const decodeAdmission = decodeStored(Admitted, 'Conversation Run receipt')

/** Pi submission numbers are Person-local, whereas readers attribute words to product Runs.
 * Translate only persisted admission receipts of this Thread. Unrecorded submissions retain no
 * attribution, and a missing follow-up submissionId stays missing rather than being inferred.
 * Only receipts named by this state are decoded, so old runtime receipts outside the Pi transcript
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
