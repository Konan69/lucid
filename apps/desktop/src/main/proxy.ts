import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import * as FetchHttpClient from 'effect/unstable/http/FetchHttpClient'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest'
import type { Session } from 'electron'
import type { ServerSettings } from '../shared/settings.ts'
import { serveAsset } from './assets.ts'
import { isAppRequest } from './security.ts'

const decodeUrl = Schema.decodeUnknownEffect(Schema.URLFromString)

/**
 * Says where a forwarded request came from, when the request does not already say.
 *
 * Chromium adds `Origin` in its network service, after the point where this handler takes the
 * request, so what arrives here carries none. The server refuses a request that changes anything
 * without one, which made signing up and signing in from the desktop app fail with a 403 the first
 * time the app was run for real.
 *
 * Naming the chosen server's origin is the truth, not a way round that check: the app session
 * cancels every request to any other origin (`secureSession`), so no document from elsewhere can
 * load in it, and every request that reaches this handler was made by the app served from that
 * origin. A request that does name an origin keeps the one it named.
 */
const attributed = (request: Request, origin: string) => {
  const forwarded = HttpClientRequest.fromWeb(request)
  return request.headers.has('origin')
    ? forwarded
    : HttpClientRequest.setHeader(forwarded, 'origin', origin)
}

/** Only the saved origin reaches the credential-bearing HttpClient transport. */
export const handleAppRequest = Effect.fn('DesktopProxy.handle')(function* (
  root: string,
  request: Request,
  server: ServerSettings,
) {
  if (!isAppRequest(request.url, server)) return new Response(null, { status: 403 })
  const url = yield* decodeUrl(request.url)
  if (url.pathname !== '/api' && !url.pathname.startsWith('/api/') && url.pathname !== '/health') {
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return new Response(null, { status: 405 })
    return yield* serveAsset(root, request, url)
  }
  const response = yield* HttpClient.execute(attributed(request, url.origin))
  const body =
    [101, 204, 205, 304].includes(response.status) || request.method === 'HEAD'
      ? null
      : Stream.toReadableStream(response.stream)
  const headers = new Headers(response.headers)
  // Chromium decoded these bytes already; retaining compression or length corrupts the response.
  headers.delete('content-encoding')
  headers.delete('content-length')
  return new Response(body, { status: response.status, headers })
})

/**
 * Serve packaged assets at the chosen origin. The main-process session guard is installed first
 * and rejects cross-origin redirects even though Chromium owns cookies and same-origin redirects.
 * The protocol handler also fails closed independently of webRequest.
 */
export function registerAppProxy(input: {
  readonly root: string
  readonly session: Session
  readonly server: () => ServerSettings
  readonly run: (program: Effect.Effect<Response>) => Promise<Response>
}): void {
  for (const scheme of ['http', 'https']) {
    input.session.protocol.handle(scheme, (request) =>
      input.run(
        handleAppRequest(input.root, request, input.server()).pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.provideService(FetchHttpClient.Fetch, (resource, options) =>
            input.session.fetch(resource instanceof URL ? resource.href : resource, {
              ...options,
              credentials: 'include',
              redirect: 'follow',
              bypassCustomProtocolHandlers: true,
            }),
          ),
          Effect.catchTags({
            RendererAssetUnavailable: () => Effect.succeed(new Response(null, { status: 404 })),
            RendererPathInvalid: () => Effect.succeed(new Response(null, { status: 400 })),
            SchemaError: () => Effect.succeed(new Response(null, { status: 400 })),
            HttpClientError: () => Effect.succeed(new Response(null, { status: 502 })),
          }),
        ),
      ),
    )
  }
}
