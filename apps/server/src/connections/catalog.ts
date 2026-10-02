import { ServiceAuthorization, ServiceUnavailable } from '@vivid/contracts'
import { Deferred, Effect, Option, Ref, Schedule } from 'effect'
import type { ExecutorService, ExecutorServiceEntry } from './executor.ts'

/** One scoped writer owns all downloads. Readers retain the last good catalog, while cold
 * readers share the current attempt's latch, including its typed failure. Schedules use the
 * Effect Clock: successful refreshes wait ten minutes; failed attempts retry after thirty seconds.
 */
export const retainCatalog = Effect.fn('Executor.catalogSnapshot')(function* (
  load: Effect.Effect<readonly (typeof ExecutorServiceEntry.Type)[], ServiceUnavailable>,
) {
  const snapshot = yield* Ref.make<Option.Option<readonly (typeof ExecutorServiceEntry.Type)[]>>(
    Option.none(),
  )
  const attempts = yield* Ref.make(
    yield* Deferred.make<readonly (typeof ExecutorServiceEntry.Type)[], ServiceUnavailable>(),
  )
  /** Rotate only completed latches; the first latch exists before the writer can start so no
   * cold reader can be stranded. Publication precedes waking successful readers.
   */
  const refresh = Effect.fn('Executor.refreshCatalog')(function* () {
    let attempt = yield* Ref.get(attempts)
    if (yield* Deferred.isDone(attempt)) {
      attempt = yield* Deferred.make<
        readonly (typeof ExecutorServiceEntry.Type)[],
        ServiceUnavailable
      >()
      yield* Ref.set(attempts, attempt)
    }
    yield* Deferred.complete(
      attempt,
      load.pipe(
        Effect.tap((entries) =>
          Ref.set(snapshot, Option.some(entries)).pipe(
            Effect.andThen(
              Effect.logInfo('Connection catalog loaded').pipe(
                Effect.annotateLogs({ services: entries.length }),
              ),
            ),
          ),
        ),
        Effect.tapError(() => Effect.logWarning('Connection catalog refresh failed')),
      ),
    )
    return yield* Deferred.await(attempt)
  })
  yield* Effect.forkScoped(
    refresh().pipe(
      Effect.retry(Schedule.spaced('30 seconds')),
      Effect.repeat(Schedule.spaced('10 minutes')),
    ),
  )
  return Effect.fn('Executor.catalog')(function* () {
    const current = yield* Ref.get(snapshot)
    if (Option.isSome(current)) return current.value
    return yield* Deferred.await(yield* Ref.get(attempts))
  })
})

/** Refresh availability outside every request. Per-service recovery and timeout live in Executor;
 * this writer publishes no collective latch, so inspections cannot hold a downloaded catalog.
 * Installation/catalog outages retry independently without terminating the scoped worker.
 */
export const inspectCatalog = Effect.fn('Connections.inspectCatalog')(function* (
  executor: Pick<ExecutorService, 'catalog' | 'authorization'>,
  returnAddress: string,
) {
  /** Per-service failure leaves the adapter fact intact and cannot cancel healthy peers. */
  const inspect = Effect.fn('Connections.inspectAvailability')(
    (entry: typeof ExecutorServiceEntry.Type) =>
      executor
        .authorization({ service: entry.id, returnAddress })
        .pipe(Effect.catch(() => Effect.void)),
  )
  const refresh = Effect.fn('Connections.refreshAvailability')(function* () {
    const entries = yield* executor.catalog()
    yield* Effect.forEach(
      entries.filter((entry) => !ServiceAuthorization.guards.None(entry.authorization)),
      inspect,
      { concurrency: 4, discard: true },
    )
  })
  yield* Effect.forkScoped(
    refresh().pipe(
      Effect.tapError(() => Effect.logWarning('Connection availability refresh failed')),
      Effect.retry(Schedule.spaced('30 seconds')),
      Effect.repeat(Schedule.spaced('10 minutes')),
    ),
  )
})
