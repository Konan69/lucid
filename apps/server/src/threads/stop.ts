import { and, eq } from 'drizzle-orm'
import { NotFound, type PersonId, type RunId, type ThreadId } from '@vivid/contracts'
import { Clock, Effect, Option } from 'effect'
import { Database } from '../database/client.ts'
import { Runtime } from '../runtime/client.ts'
import { runs } from './tables.ts'

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
        .for('update')
      if (row === undefined) return yield* new NotFound({ message: 'Run not found' })
      const changed = yield* tx
        .update(runs)
        .set({ state: 'stopped', finishedAt: now })
        .where(and(eq(runs.id, runId), eq(runs.state, 'working')))
        .returning({ id: runs.id })
      return changed.length === 0 ? Option.none<ThreadId>() : Option.some(row.threadId)
    }),
  )
  if (Option.isSome(stopped)) yield* abortThread(stopped.value)
})
