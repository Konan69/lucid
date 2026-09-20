import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as HttpRouter from 'effect/unstable/http/HttpRouter'
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import { ConnectionCallbackState, ConnectionId } from '@vivid/contracts'
import { authenticate } from '../auth/session.ts'
import { ConnectionStore } from '../connections/store.ts'

const start = Effect.fn('Http.Connection.start')(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  yield* authenticate(new globalThis.Headers(Object.entries(request.headers)))
  const route = yield* HttpRouter.RouteContext
  const id = yield* Schema.decodeUnknownEffect(ConnectionId)(route.params.id).pipe(Effect.option)
  if (Option.isNone(id)) return HttpServerResponse.jsonUnsafe({ error: 'Unknown Connection' }, { status: 404 })
  const state = Buffer.from(JSON.stringify(ConnectionCallbackState.make({ connector: id.value, nonce: crypto.randomUUID() }))).toString('base64url')
  const store = yield* ConnectionStore
  const authUrl = yield* store.authorizationUrl(id.value, state).pipe(Effect.option)
  return Option.isNone(authUrl)
    ? HttpServerResponse.jsonUnsafe({ error: 'Google sign-in is not configured' }, { status: 503 })
    : HttpServerResponse.jsonUnsafe({ authUrl: authUrl.value })
})

const callback = Effect.fn('Http.Connection.callback')(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const url = new URL(request.url, 'http://vivid.local')
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (code === null || state === null) return HttpServerResponse.jsonUnsafe({ error: 'Missing authorization state' }, { status: 400 })
  const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ConnectionCallbackState))(
    Buffer.from(state, 'base64url').toString('utf8'),
  ).pipe(Effect.option)
  if (Option.isNone(decoded)) return HttpServerResponse.jsonUnsafe({ error: 'Invalid authorization state' }, { status: 400 })
  const store = yield* ConnectionStore
  const exchanged = yield* store.exchangeCode(decoded.value.connector, code).pipe(Effect.option)
  return Option.isNone(exchanged)
    ? HttpServerResponse.redirect('/?settings=connectors&error=authorization-failed', { status: 303 })
    : HttpServerResponse.redirect(`/?settings=connectors&connected=${encodeURIComponent(exchanged.value.connectorId)}`, { status: 303 })
})

export const oauthRoutes = Layer.mergeAll(
  HttpRouter.add('GET', '/api/connectors/:id/auth', start()),
  HttpRouter.add('GET', '/api/connectors/google/callback', callback()),
)
