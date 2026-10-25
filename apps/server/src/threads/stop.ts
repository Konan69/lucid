import { and, eq } from 'drizzle-orm'
import {
  RuntimeUnavailable,
  NotFound,
  type PersonId,
  type RunId,
  type ThreadId,
} from '@vivid/contracts'
import { Array, Clock, Effect, Option, Result } from 'effect'
import { Database } from '../database/client.ts'
import { announceFeed } from '../feed/changes.ts'
import { Runtime } from '../runtime/client.ts'
import { requireThread, findThread } from './access.ts'
import { runs, threads } from './tables.ts'
import { Conversation } from './conversation.ts'
import { withAdmission } from './admissions.ts'

/** Abort names the creator's runtime store, independently from the Person whose Run was stopped. */
const abortThread = Effect.fn('Threads.abort')(function* (threadId: ThreadId) {
  const thread = yield* findThread(threadId)
  if (Option.isNone(thread)) return yield* new NotFound({ message: 'Thread not found' })
  return yield* (yield* Runtime)
    .stop(thread.value.personId, threadId)
    .pipe(Effect.mapError(() => RuntimeUnavailable.make({ message: 'Vivid could not be reached' })))
})

/** Stop only this Person's work, including reservations with no receipt to abort.
 * Admission's gate excludes a late receipt, so receiptless work can settle directly. Admitted
 * work still needs a successful abort; otherwise its observer retains the completed outcome. */
export const stopThread = Effect.fn('Threads.stop')(
  function* (personId: PersonId, threadId: ThreadId) {
    yield* requireThread(threadId, personId)
    const database = yield* Database
    const working = yield* database.run(
      database
        .select({ id: runs.id, receipt: runs.receipt })
        .from(runs)
        .where(
          and(eq(runs.threadId, threadId), eq(runs.personId, personId), eq(runs.state, 'working')),
        ),
    )
    const [reserved, admitted] = Array.partition(working, (run) =>
      run.receipt === null ? Result.succeed(run.id) : Result.fail(run.id),
    )
    if (reserved.length > 0) yield* (yield* Conversation).stopped(reserved)
    if (admitted.length > 0 && (yield* abortThread(threadId)))
      yield* (yield* Conversation).stopped(admitted)
  },
  (effect, _personId, threadId) => withAdmission(effect, threadId),
)

/**
 * A Device can stop only its Person's exact Run. Revoke dispatch authority before aborting,
 * so queued work fails its final Working check. Only the caller that changes Working to Stopped
 * aborts: repeated reports and reports for an already settled Run cannot stop a newer turn.
 * DeviceRegistry owns RunEnded because it holds the link that received the window work.
 */
export const stopPersonRun = Effect.fn('Threads.stopPersonRun')(function* (
  personId: PersonId,
  runId: RunId,
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const stopped = yield* database.transaction((tx) =>
    Effect.gen(function* () {
      const [row] = yield* tx
        .select()
        .from(runs)
        .where(and(eq(runs.id, runId), eq(runs.personId, personId)))
      if (row === undefined) return yield* new NotFound({ message: 'Run not found' })
      // Start, settlement and deletion lock the parent before changing a Run.
      yield* tx
        .select({ id: threads.id })
        .from(threads)
        .where(eq(threads.id, row.threadId))
        .for('update')
      const changed = yield* tx
        .update(runs)
        .set({ state: 'stopped', finishedAt: now })
        .where(and(eq(runs.id, runId), eq(runs.state, 'working')))
        .returning({ id: runs.id })
      if (changed.length === 0) return Option.none<ThreadId>()
      // Runtime settlement may now be a no-op. Date history and publish this Stop in its own write.
      yield* tx.update(threads).set({ updatedAt: now }).where(eq(threads.id, row.threadId))
      yield* announceFeed(tx, [row.threadId])
      return Option.some(row.threadId)
    }),
  )
  if (Option.isSome(stopped)) yield* abortThread(stopped.value)
})
