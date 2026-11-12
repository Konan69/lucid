import { Duration, Effect, Predicate, Schedule, Schema } from 'effect'
import { HttpClient, HttpClientError } from 'effect/http'
import { Message } from '../observability/messages.ts'

/**
 * Railway sleeps Executor after ten quiet minutes (`sleepApplication` in `infra/railway.ts`) and
 * refuses the first private-network connection after that while it starts a new instance: on
 * 12 November 2026 at 11:31:23.894 the sleeping instance answered the server's connection with
 * one 54-byte reset from port 8080 (Railway network flow log), and the call failed with
 * `ExecutorTransportFailure`. A refused connection delivered nothing, so connecting again is safe
 * for every request, writes included. Any other transport failure may have delivered the request
 * and stays a failure.
 */
const isRefused = Schema.is(Schema.Struct({ code: Schema.Literal('ECONNREFUSED') }))

const refused = (error: HttpClientError.HttpClientError) =>
  Predicate.isTagged(error.reason, 'TransportError') && isRefused(error.reason.cause)

/**
 * Bounds the wait for Executor to wake. Railway sends no signal when the new instance listens, so
 * a connection attempt is the only probe. Across 359 wakes from 9 to 12 November 2026 Executor's
 * app was running a median 1.9 s and at most 14.6 s after Railway started its container (its
 * production log). 30 s is twice that maximum. On expiry the caller meets the refusal as
 * `ExecutorTransportFailure`, as it did before this wait existed.
 */
const WAKE = Duration.seconds(30)
/** One connection attempt a second, so a wake costs at most a second beyond Executor's start. */
const WAKE_PACE = Duration.seconds(1)

/** The HTTP client every private-network Executor caller uses: it reconnects while Executor wakes. */
export const waking = (client: HttpClient.HttpClient): HttpClient.HttpClient =>
  HttpClient.retry(client, {
    schedule: Schedule.spaced(WAKE_PACE).pipe(Schedule.upTo({ duration: WAKE })),
    while: (error) =>
      refused(error)
        ? Effect.as(Effect.logInfo(Message.executorWaking), true)
        : Effect.succeed(false),
  })
