import { Effect, Match, Redacted } from 'effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http'
import { ConnectionState } from '@vivid/contracts'
import { PHONE_SCHEME } from '../auth/signin.ts'
import { ServerConfig } from '../config.ts'
import { observeFailures } from '../observability/failure.ts'
import { ConnectionStore } from './store.ts'

/** Executor has one deployment-wide redirect URI. The opaque state alone selects the pending
 * Connection and the Person who began it: the browser need not be signed in to Vivid, because a
 * phone hands the sign-in to a browser that never was (`callbackTrip`, `records.ts`). The full
 * callback remains redacted through completion. Unknown, reused, and malformed state reveal no
 * Connection identity or provider data.
 */
const callback = Effect.fn('Http.Connections.return')(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const config = yield* ServerConfig
  const destination = yield* Effect.gen(function* () {
    const address = Redacted.make(new URL(request.url, config.PUBLIC_URL).href)
    const store = yield* ConnectionStore
    const { id, state: result, surface } = yield* store.returning(address)
    const target = Match.value(surface).pipe(
      Match.when('Web', () => new URL('/settings/connections', config.PUBLIC_URL)),
      Match.when('Phone', () => new URL(`${PHONE_SCHEME}://integrations`)),
      Match.exhaustive,
    )
    target.searchParams.set(ConnectionState.guards.Ready(result) ? 'connected' : 'failed', id)
    return target
  }).pipe(
    // The recorder writes the one log line a failure gets here: its tag, never the callback
    // address. The recovery below then answers every failure with the same redirect, so the
    // response says nothing about which state was unknown, reused or malformed.
    observeFailures('http'),
    Effect.orElseSucceed(() => new URL('/settings/connections', config.PUBLIC_URL)),
  )
  return HttpServerResponse.redirect(destination.href, { status: 303 })
})

export const connectionReturnRoutes = HttpRouter.add('GET', '/api/connections/return', callback())
