import { and, eq } from 'drizzle-orm'
import { NotFound, type PersonId, type RunId, type ThreadId } from '@vivid/contracts'
import { Clock, Effect, Option } from 'effect'
import { Database } from '../database/client.ts'
import { announceFeed } from '../feed/changes.ts'
import { Runtime } from '../runtime/client.ts'
import { runs, threads } from './tables.ts'

/** Thread Stop and a computer Stop use the same runtime abort adapter. */
export const abortThread = Effect.fn('Threads.abort')(function* (threadId: ThreadId) {
  yield* (yield* Runtime).stop(threadId)
})

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
