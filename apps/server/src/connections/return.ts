import { Effect, Option, Redacted } from 'effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http'
import { ConnectionState } from '@vivid/contracts'
import { authenticate } from '../auth/session.ts'
import { ServerConfig } from '../config.ts'
import { observeFailures } from '../observability/failure.ts'
import { ConnectionStore } from './store.ts'

/** Executor has one deployment-wide redirect URI. The opaque state, signed-in Person, and
 * pending Connection select the return; the full callback remains redacted through completion.
 * Unknown, foreign, reused, and malformed state reveal no Connection identity or provider data.
 */
const callback = Effect.fn('Http.Connections.return')(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const config = yield* ServerConfig
  const destination = yield* Effect.gen(function* () {
    const auth = yield* authenticate(new Headers(Object.entries(request.headers)))
    const actor = {
      person: auth.person,
      workspace: auth.workspace,
      by: 'person' as const,
      threadId: Option.none(),
    }
    const address = Redacted.make(new URL(request.url, config.PUBLIC_URL).href)
    const store = yield* ConnectionStore
    const id = yield* store.callbackId(actor, address)
    const result = yield* store.callback(actor, id, address)
    const target = new URL('/settings/connections', config.PUBLIC_URL)
    target.searchParams.set(ConnectionState.guards.Ready(result) ? 'connected' : 'failed', id)
    return target
  }).pipe(
    // The recorder writes the one log line a failure gets here: its tag, never the callback
    // address. The recovery below then answers every failure with the same redirect, so the
    // response says nothing about which state was unknown, foreign, reused or malformed.
    observeFailures('http'),
    Effect.orElseSucceed(() => new URL('/settings/connections', config.PUBLIC_URL)),
  )
  return HttpServerResponse.redirect(destination.href, { status: 303 })
})

export const connectionReturnRoutes = HttpRouter.add('GET', '/api/connections/return', callback())
