import * as NodeSocket from '@effect/platform-node/NodeSocket'
import { Effect, Option, Redacted } from 'effect'
import * as HttpRouter from 'effect/unstable/http/HttpRouter'
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import * as Socket from 'effect/unstable/socket/Socket'
import { authenticate } from '../auth/session.ts'
import { ComputerStore, computerScreenAddress } from './store.ts'

const notFound = () =>
  HttpServerResponse.empty({ status: 404, headers: { 'cache-control': 'no-store' } })

/** An upgraded connection stays inside the route fiber and closes both transports when either leg ends. */
const relay = Effect.fn('Computer.screen.relay')(function* (
  request: HttpServerRequest.HttpServerRequest,
  endpoint: { readonly address: string; readonly authorization: Redacted.Redacted },
) {
  const upstream = yield* Socket.fromWebSocket(
    Effect.acquireRelease(
      Effect.sync(
        () =>
          new NodeSocket.NodeWS.WebSocket(endpoint.address, ['binary'], {
            headers: { authorization: Redacted.value(endpoint.authorization) },
          }),
      ),
      (socket) => Effect.sync(() => socket.close(1000)),
    ),
    { openTimeout: '10 seconds' },
  )
  // Dial first: a dead provider must not leave the browser with a successful but unusable upgrade.
  const source = yield* upstream.reader
  const outgoing = yield* upstream.writer
  const client = yield* request.upgrade
  const incoming = yield* client.reader
  const destination = yield* client.writer
  yield* Effect.raceFirst(
    source.pull.pipe(
      Effect.flatMap((frames) => destination.writeAll(frames)),
      Effect.forever,
    ),
    incoming.pull.pipe(
      Effect.flatMap((frames) => outgoing.writeAll(frames)),
      Effect.forever,
    ),
  ).pipe(Effect.catch(() => Effect.void))
  return HttpServerResponse.empty()
})

/** Cookie upgrades also enforce browser Origin; the session cookie is never forwarded to the provider. */
const originAllowed = (request: HttpServerRequest.HttpServerRequest): boolean => {
  const origin = request.headers.origin
  if (origin === undefined) return true
  const parsed = URL.parse(origin)
  return parsed !== null && parsed.host === request.headers.host
}

/** Only the exact cookie-authenticated RFB upgrade is served; container documents can never execute on Vivid's origin. */
const screen = Effect.fn('Computer.screen')(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const url = new URL(request.url, 'http://vivid.local')
  if (
    request.method !== 'GET' ||
    request.headers.upgrade !== 'websocket' ||
    url.pathname !== computerScreenAddress ||
    url.search !== '' ||
    !originAllowed(request)
  )
    return notFound()
  const auth = yield* authenticate(new Headers(Object.entries(request.headers))).pipe(Effect.option)
  if (Option.isNone(auth)) return notFound()
  const store = yield* ComputerStore
  const endpoint = yield* store.screen(auth.value.person.id).pipe(Effect.option)
  if (Option.isNone(endpoint) || Option.isNone(endpoint.value)) return notFound()
  return yield* relay(request, endpoint.value.value).pipe(
    Effect.scoped,
    Effect.catch(() => Effect.succeed(notFound())),
  )
})

/** NodeHttpServer's pinned upgrade handler invokes HttpRouter and supplies request.upgrade; no separate server hook is needed. */
export const computerScreenRoutes = HttpRouter.add('*', '/api/computer/screen/*', screen())
