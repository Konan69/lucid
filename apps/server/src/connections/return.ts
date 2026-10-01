import { Effect, Option, Redacted, Schema } from 'effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http'
import { ConnectionId } from '@vivid/contracts'
import { authenticate } from '../auth/session.ts'
import { ServerConfig } from '../config.ts'
import { ConnectionStore } from './store.ts'

const decodeId = Schema.decodeUnknownEffect(ConnectionId)

/** The callback is bound to the initiating Person; the provider URL stays redacted. */
const callback = Effect.fn('Http.Connections.return')(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const route = yield* HttpRouter.RouteContext
  const config = yield* ServerConfig
  const id = yield* decodeId(route.params.id).pipe(Effect.option)
  if (Option.isNone(id)) return HttpServerResponse.empty({ status: 404 })
  const destination = new URL('/settings/connections', config.PUBLIC_URL)
  const auth = yield* authenticate(new Headers(Object.entries(request.headers))).pipe(Effect.option)
  if (Option.isNone(auth)) return HttpServerResponse.empty({ status: 401 })
  const store = yield* ConnectionStore
  const ready = yield* store
    .callback(
      {
        person: auth.value.person,
        workspace: auth.value.workspace,
        by: 'person',
        threadId: Option.none(),
      },
      id.value,
      Redacted.make(new URL(request.url, config.PUBLIC_URL).href),
    )
    .pipe(Effect.catch(() => Effect.succeed(false)))
  destination.searchParams.set(ready ? 'connected' : 'failed', id.value)
  return HttpServerResponse.redirect(destination.href, { status: 303 })
})

export const connectionReturnRoutes = HttpRouter.add(
  'GET',
  '/api/connections/return/:id',
  callback(),
)
