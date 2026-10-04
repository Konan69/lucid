import { and, eq } from 'drizzle-orm'
import * as Effect from 'effect/Effect'
import type { PersonId, ThreadId } from '@vivid/contracts'
import { Database } from '../database/client.ts'
import { submissionId } from '../runtime/identity.ts'
import { inputRequests } from './tables.ts'

/** The delivery key of the answer to one Input request; its Run id is derived from it. */
export const answerKey = (requestId: string) => `answer-${requestId}`

/**
 * The Runs in a Thread that were started by an answer this Person gave themselves.
 *
 * In a shared Thread another member may answer a question addressed to somebody else, and the
 * continuing Run still acts for the Person who was asked (`approvals/replay.ts`). So neither the
 * Run's Person nor the Thread's audience says who spoke; `answered_by` does. The Run id is not
 * stored on the request: it is `submissionId(thread, answerKey(request))`, the same derivation
 * the delivery used (`runtime/identity.ts`), so the two cannot disagree.
 */
export const answeredRuns = Effect.fn('Inputs.answeredRuns')(function* (
  threadId: ThreadId,
  personId: PersonId,
) {
  const database = yield* Database
  const rows = yield* database.run(
    database
      .select({ id: inputRequests.id })
      .from(inputRequests)
      .where(
        and(
          eq(inputRequests.threadId, threadId),
          eq(inputRequests.answeredBy, personId),
          eq(inputRequests.status, 'answered'),
        ),
      ),
  )
  return new Set<string>(rows.map((row) => submissionId(threadId, answerKey(row.id))))
})
