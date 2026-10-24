import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Predicate from 'effect/Predicate'
import * as PersistedQueue from 'effect/persistence/PersistedQueue'
import * as SqlError from 'effect/sql/SqlError'
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

/** The SQL store preserves its typed Cause in PersistedQueueError. Reconnecting can repair a
 * lost connection; it cannot repair an invalid statement, credential, payload, or code defect. */
const disconnectedQueue = (error: PersistedQueue.PersistedQueueError): boolean => {
  if (!Cause.isCause(error.cause)) return false
  return Option.exists(
    Cause.findErrorOption(error.cause),
    (failure) =>
      SqlError.isSqlError(failure) && Predicate.isTagged(failure.reason, 'ConnectionError'),
  )
}

/** Paces reconnects for the scoped SQL queue consumer. Source: Effect 4.0.2 PersistedQueue's
 * 500 ms supervision cadence. Permanent store faults and defects stop the consumer visibly. */
const QUEUE_RECONNECT_DELAY = '500 millis'

/**
 * Adoption completes in Layer acquisition, so a typed database fault prevents request handling.
 * One scoped taker claims one row (rc.116 PQ:1598) and starts at most one extraction process.
 * The SDK persists item retries before this consumer continues. Only transient item failures
 * resume taking; permanent database failures and defects stop supervision for operator repair.
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
        Effect.catchTags({
          ExtractionFaulted: () => Effect.void,
          ExtractionUnavailable: () => Effect.void,
          DatabaseUnavailable: () => Effect.void,
        }),
        Effect.forever,
        Effect.tapCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logError('Library ingestion consumer stopped'),
        ),
        Effect.retry({
          schedule: Schedule.spaced(QUEUE_RECONNECT_DELAY),
          while: (error) =>
            Predicate.isTagged(error, 'PersistedQueueError') && disconnectedQueue(error),
        }),
        Effect.forkScoped,
      )
    }),
  )
