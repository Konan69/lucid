import { Effect, Layer, Option, Redacted, Schema } from 'effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http'
import { ConnectionId, ConnectionState } from '@vivid/contracts'
import { authenticate } from '../auth/session.ts'
import { ServerConfig } from '../config.ts'
import { ConnectionStore } from './store.ts'
import { decodeGoogleState, googleReturnPath } from './google.ts'

const decodeId = Schema.decodeUnknownEffect(ConnectionId)

/** The callback URL stays redacted throughout authentication and provider completion. */
const returnState = Effect.fn('Connections.returnState')(function* (
  id: ConnectionId,
  request: typeof HttpServerRequest.HttpServerRequest.Service,
  publicUrl: URL,
) {
  const auth = yield* authenticate(new Headers(Object.entries(request.headers)))
  return yield* (yield* ConnectionStore).callback(
    { person: auth.person, workspace: auth.workspace, by: 'person', threadId: Option.none() },
    id,
    Redacted.make(new URL(request.url, publicUrl).href),
  )
})

/** Provider returns always land on Settings, including expired sessions. Only failure tag and
 * Connection id enter logs; callback codes, headers and provider diagnostics never do.
 */
const callback = Effect.fn('Http.Connections.return')(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const route = yield* HttpRouter.RouteContext
  const config = yield* ServerConfig
  const id = yield* decodeId(route.params.id)
  const ready = yield* returnState(id, request, config.PUBLIC_URL).pipe(
    Effect.flatMap((state) =>
      ConnectionState.guards.Ready(state)
        ? Effect.succeed(true)
        : Effect.logWarning({ tag: state._tag, connectionId: id }).pipe(Effect.as(false)),
    ),
    Effect.catch((error) =>
      Effect.logWarning({ tag: error._tag, connectionId: id }).pipe(Effect.as(false)),
    ),
  )
  const destination = new URL('/settings/connections', config.PUBLIC_URL)
  destination.searchParams.set(ready ? 'connected' : 'failed', id)
  return HttpServerResponse.redirect(destination.href, { status: 303 })
})

/** Google's exact-match registration requires one fixed callback across Persons and attempts.
 * Resolve only the authenticated Person's exact saved state, then use the existing completion
 * path. Multiple state parameters are refused; unknown/expired returns never reveal an id.
 */
const googleCallback = Effect.fn('Http.Connections.googleReturn')(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const config = yield* ServerConfig
  const address = new URL(request.url, config.PUBLIC_URL)
  const destination = yield* Effect.gen(function* () {
    const states = address.searchParams.getAll('state')
    const state = yield* decodeGoogleState(states.length === 1 ? states[0] : null)
    const auth = yield* authenticate(new Headers(Object.entries(request.headers)))
    const actor = {
      person: auth.person,
      workspace: auth.workspace,
      by: 'person' as const,
      threadId: Option.none(),
    }
    const store = yield* ConnectionStore
    const id = yield* store.googleCallbackId(actor, state)
    const result = yield* store.callback(actor, id, Redacted.make(address.href))
    const target = new URL('/settings/connections', config.PUBLIC_URL)
    target.searchParams.set(ConnectionState.guards.Ready(result) ? 'connected' : 'failed', id)
    return target
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning({ tag: error._tag }).pipe(
        Effect.as(new URL('/settings/connections', config.PUBLIC_URL)),
      ),
    ),
  )
  return HttpServerResponse.redirect(destination.href, { status: 303 })
})

export const connectionReturnRoutes = Layer.mergeAll(
  HttpRouter.add('GET', '/api/connections/return/:id', callback()),
  HttpRouter.add('GET', googleReturnPath, googleCallback()),
)
