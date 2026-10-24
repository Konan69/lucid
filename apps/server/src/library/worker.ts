import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schedule from 'effect/Schedule'
import { Database } from '../database/client.ts'
import { observeFailures } from '../observability/failure.ts'
import type { extractPdf } from './extraction.ts'
import { ingestOwed } from './ingest.ts'
import { ingestionOperations, LibraryIngestion, libraryIngestion } from './ingestion.ts'

/**
 * The SDK's 1-based metadata is the only budget counter. Non-interrupt failures are logged once
 * without printing their cause or private bytes; acknowledgement preserves the original exit.
 * rc.116 PersistedQueue.ts:1739-1755 completes, retries or releases after this callback exits.
 */
export const takeIngestion = (
  queue: Effect.Success<ReturnType<typeof libraryIngestion>>,
  ingest: ReturnType<typeof ingestOwed>,
) =>
  queue.take((job, metadata) =>
    ingest(job.itemId, metadata.attempts).pipe(
      // Records the failure's tag; the line below still names the item and the attempt.
      observeFailures('schedule'),
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logWarning('Library ingestion delivery failed').pipe(
              Effect.annotateLogs({ itemId: job.itemId, attempt: metadata.attempts }),
            ),
      ),
    ),
  )

/** Paces restarts after any non-interrupt failure or defect. A driver's unclassified store
 * failure must not strand owed ingestion until server restart. Source: Effect 4.0.2
 * PersistedQueue's 500 ms supervision cadence. Only the owning scope stops the taker. */
const QUEUE_RECONNECT_DELAY = '500 millis'

/**
 * Adoption completes in Layer acquisition, so a typed database fault prevents request handling.
 * One scoped taker claims one row (rc.116 PQ:1598) and starts at most one extraction process.
 * The SDK persists item retries before this consumer continues. This supervisor restarts
 * the taker after store, item or code failures; shutdown interruption is never recovered.
 */
export const libraryIngestionLayer = (
  retrySchedule: Schedule.Schedule<unknown, number>,
  extract: typeof extractPdf,
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const queue = yield* libraryIngestion(retrySchedule)
      const operations = ingestionOperations(yield* Database)
      const stranded = yield* operations.stranded()
      yield* Effect.forEach(
        stranded,
        ({ id }) => queue.offer(LibraryIngestion.make({ itemId: id }), { id }),
        { discard: true },
      )
      yield* takeIngestion(queue, ingestOwed(operations, extract)).pipe(
        Effect.forever,
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterrupts(cause),
          () => Effect.logError('Library ingestion consumer failed; restarting'),
        ),
        Effect.repeat(Schedule.spaced(QUEUE_RECONNECT_DELAY)),
        Effect.forkScoped,
      )
    }),
  )
