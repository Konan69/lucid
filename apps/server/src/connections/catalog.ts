import { ServiceUnavailable } from '@vivid/contracts'
import { Cause, Deferred, Duration, Effect, Exit, Option, Predicate, Ref, Schedule } from 'effect'
import { FailureAttribute, recordFailures } from '../observability/failure.ts'
import { Message } from '../observability/messages.ts'
import type { ExecutorFailure, ExecutorServiceEntry } from './executor.ts'

/** Cold pulls can recover from transport loss or a temporarily unavailable Executor. Three
 * retries bound one recovery series; malformed responses and access refusals require repair.
 * Source: unmeasured. A cold transient failure keeps this pace even after the fast retry series. */
export const CATALOG_RETRY_DELAY = Duration.seconds(30)
const CATALOG_RETRIES = 3
/** Bounds catalog staleness because this provider exposes a pull feed, with no change signal.
 * Source: unmeasured. Expiry refreshes the snapshot without discarding the last good one. */
const CATALOG_REFRESH = Duration.minutes(10)

/** Only transport loss, temporary readiness and uncertain read outcomes can recover without repair. */
const catalogTransient = (error: ExecutorFailure) =>
  Predicate.isTagged(error, 'ExecutorTransportFailure') ||
  Predicate.isTagged(error, 'ExecutorNotReady') ||
  Predicate.isTagged(error, 'ExecutorExecutionUncertain')

/** One scoped writer owns all downloads. Readers retain the last good catalog, while cold
 * readers share the current attempt's latch, including its typed failure. Schedules use the
 * Effect Clock: cold transient failures retain thirty-second recovery after fast retries exhaust.
 * Successes, warm failures and refusals wait ten minutes. No failure ends this scoped writer.
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
        // One attempt; a transient one is tried again, so it is a warning, said by its tag.
        Effect.tapError((failure) =>
          Effect.logWarning(Message.catalogAttempt).pipe(
            Effect.annotateLogs(FailureAttribute.type, failure._tag),
          ),
        ),
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
      Effect.as(CATALOG_REFRESH),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        Effect.fn('Executor.catalogRefreshFailure')(function* (
          cause: Cause.Cause<ExecutorFailure>,
        ) {
          const error = Cause.findErrorOption(cause)
          // Retries gave up: said as any failure that is answered is, so it leaves the process.
          yield* recordFailures('schedule')(cause)
          const current = yield* Ref.get(snapshot)
          return Option.exists(error, catalogTransient) && Option.isNone(current)
            ? CATALOG_RETRY_DELAY
            : CATALOG_REFRESH
        }),
      ),
      Effect.repeat(
        Schedule.forever.pipe(
          Schedule.setInputType<Duration.Duration>(),
          Schedule.addDelay(({ input }) => Effect.succeed(input)),
        ),
      ),
    ),
  )
  return Effect.fn('Executor.catalog')(function* () {
    const current = yield* Ref.get(snapshot)
    if (Option.isSome(current)) return current.value
    return yield* Deferred.await(yield* Ref.get(attempts))
  })
})
