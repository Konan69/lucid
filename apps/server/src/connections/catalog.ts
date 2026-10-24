import { ServiceUnavailable } from '@vivid/contracts'
import { Deferred, Effect, Exit, Option, Predicate, Ref, Schedule } from 'effect'
import type { ExecutorFailure, ExecutorServiceEntry } from './executor.ts'

/** Cold pulls can recover from transport loss or a temporarily unavailable Executor. Three
 * retries bound one recovery series; malformed responses and access refusals require repair.
 * Source: unmeasured. Exhaustion retains the last good snapshot until the next scheduled refresh. */
export const CATALOG_RETRY_DELAY = '30 seconds'
const CATALOG_RETRIES = 3
/** Bounds catalog staleness because this provider exposes a pull feed, with no change signal.
 * Source: unmeasured. Expiry refreshes the snapshot without discarding the last good one. */
const CATALOG_REFRESH = '10 minutes'

/** Only transport loss, temporary readiness and uncertain read outcomes can recover without repair. */
const catalogTransient = (error: ExecutorFailure) =>
  Predicate.isTagged(error, 'ExecutorTransportFailure') ||
  Predicate.isTagged(error, 'ExecutorNotReady') ||
  Predicate.isTagged(error, 'ExecutorExecutionUncertain')

/** One scoped writer owns all downloads. Readers retain the last good catalog, while cold
 * readers share the current attempt's latch, including its typed failure. Schedules use the
 * Effect Clock: successful refreshes wait ten minutes; failed attempts retry after thirty seconds.
 */
export const retainCatalog = Effect.fn('Executor.catalogSnapshot')(function* (
  load: Effect.Effect<readonly (typeof ExecutorServiceEntry.Type)[], ExecutorFailure>,
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
    const exit = yield* Effect.exit(
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
    yield* Deferred.done(
      attempt,
      Exit.mapError(exit, () =>
        ServiceUnavailable.make({ service: 'connections', message: 'The catalog is unavailable.' }),
      ),
    )
    return yield* exit
  })
  yield* Effect.forkScoped(
    refresh().pipe(
      Effect.retry({
        schedule: Schedule.spaced(CATALOG_RETRY_DELAY).pipe(
          Schedule.upTo({ times: CATALOG_RETRIES }),
        ),
        while: catalogTransient,
      }),
      Effect.catchIf(catalogTransient, () => Effect.void),
      Effect.repeat(Schedule.spaced(CATALOG_REFRESH)),
      Effect.catch((error) =>
        Effect.logError('Connection catalog refresh stopped', { failure: error._tag }),
      ),
    ),
  )
  return Effect.fn('Executor.catalog')(function* () {
    const current = yield* Ref.get(snapshot)
    if (Option.isSome(current)) return current.value
    return yield* Deferred.await(yield* Ref.get(attempts))
  })
})
