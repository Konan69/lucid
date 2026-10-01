import * as NodeSocket from '@effect/platform-node/NodeSocket'
import { Effect, Option } from 'effect'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpRouter from 'effect/unstable/http/HttpRouter'
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import * as Socket from 'effect/unstable/socket/Socket'
import { authenticate } from '../auth/session.ts'
import { ComputerStore } from './store.ts'

const prefix = '/api/computer/screen/'
const notFound = () =>
  HttpServerResponse.empty({ status: 404, headers: { 'cache-control': 'no-store' } })

/** An upgraded connection stays inside the route fiber and closes both transports when either leg ends. */
const relay = Effect.fn('Computer.screen.relay')(function* (
  request: HttpServerRequest.HttpServerRequest,
  address: string,
) {
  const upstream = yield* Socket.makeWebSocket(address, {
    protocols: ['binary'],
    openTimeout: '10 seconds',
  })
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

/** Only noVNC assets beneath the fixed prefix are proxied; query text cannot change the provider origin. */
const upstreamAddress = (request: HttpServerRequest.HttpServerRequest, screen: string) => {
  const url = new URL(request.url, 'http://vivid.local')
  if (!url.pathname.startsWith(prefix)) return Option.none<string>()
  const path = url.pathname.slice(prefix.length)
  if (!/^[a-zA-Z0-9_./-]+$/.test(path) || path.split('/').includes('..'))
    return Option.none<string>()
  const endpoint = new URL(screen)
  endpoint.pathname = `/${path}`
  endpoint.search = url.search
  endpoint.hash = ''
  return Option.some(endpoint.href)
}

/** Cookie upgrades also enforce browser Origin; the session cookie is never forwarded to the provider. */
const originAllowed = (request: HttpServerRequest.HttpServerRequest): boolean => {
  const origin = request.headers.origin
  if (origin === undefined) return true
  const parsed = URL.parse(origin)
  return parsed !== null && parsed.host === request.headers.host
}

/** Authentication and Person ownership happen before both HTTP fetch and WebSocket upgrade. Failures are opaque 404s. */
const screen = Effect.fn('Computer.screen')(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  if (!originAllowed(request)) return notFound()
  const auth = yield* authenticate(new Headers(Object.entries(request.headers))).pipe(Effect.option)
  if (Option.isNone(auth)) return notFound()
  const store = yield* ComputerStore
  const endpoint = yield* store.screen(auth.value.person.id).pipe(Effect.option)
  if (Option.isNone(endpoint) || Option.isNone(endpoint.value)) return notFound()
  const address = upstreamAddress(request, endpoint.value.value)
  if (Option.isNone(address)) return notFound()
  if (request.headers.upgrade === 'websocket') {
    const url = new URL(address.value)
    if (url.pathname !== '/websockify') return notFound()
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return yield* relay(request, url.href).pipe(
      Effect.scoped,
      Effect.catch(() => Effect.succeed(notFound())),
    )
  }
  const response = yield* HttpClient.get(address.value).pipe(Effect.option)
  if (Option.isNone(response)) return notFound()
  return HttpServerResponse.stream(response.value.stream, {
    status: response.value.status,
    headers: { 'cache-control': 'no-store', vary: 'Cookie' },
    contentType: response.value.headers['content-type'],
  })
})

/** NodeHttpServer's pinned upgrade handler invokes HttpRouter and supplies request.upgrade; no separate server hook is needed. */
export const computerScreenRoutes = HttpRouter.add('GET', '/api/computer/screen/*', screen()).pipe(
  HttpRouter.provideRequest(NodeSocket.layerWebSocketConstructorWS),
)
