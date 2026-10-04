import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schedule from 'effect/Schedule'
import { Database } from '../database/client.ts'
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
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logWarning('Library ingestion delivery failed').pipe(
              Effect.annotateLogs({ itemId: job.itemId, attempt: metadata.attempts }),
            ),
      ),
    ),
  )

/**
 * Adoption completes in Layer acquisition, so a typed database fault prevents request handling.
 * One scoped taker claims one row (rc.116 PQ:1598) and starts at most one extraction thread.
 * Supervision ports the SDK poller's tapCause/sandbox/retry sequence (PQ:1612-1616); it restarts
 * taking after native acknowledgement, while retry/backoff of an obligation remains SDK-owned.
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
        Effect.tapCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logWarning('Library ingestion taker restarting'),
        ),
        Effect.sandbox,
        Effect.retry(Schedule.spaced('500 millis')),
        Effect.forkScoped,
      )
    }),
  )
