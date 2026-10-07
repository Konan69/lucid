import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import * as FetchHttpClient from 'effect/unstable/http/FetchHttpClient'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest'
import { session } from 'electron'
import type { ServerAddress } from '../shared/settings.ts'
import { serveAsset } from './assets.ts'

const decodeUrl = Schema.decodeUnknownEffect(Schema.URLFromString)
/**
 * HttpClient owns forwarding; Electron supplies its cookie-aware transport. Bypassing custom
 * handlers prevents recursion. Chromium follows redirects with the same cookie jar and bodies
 * stay streaming. Electron's manual redirect mode requires ClientRequest redirect callbacks,
 * which Session.fetch does not install; using it rejects otherwise valid API redirects.
 * The pinned Electron Session.fetch option is documented in electron.d.ts beside protocol.handle.
 */
const forwardRequest = Effect.fn('DesktopRenderer.forward')(function* (request: Request) {
  const response = yield* HttpClient.execute(HttpClientRequest.fromWeb(request))
  const body =
    [101, 204, 205, 304].includes(response.status) || request.method === 'HEAD'
      ? null
      : Stream.toReadableStream(response.stream)
  const headers = new Headers(response.headers)
  // Chromium's transport already decodes compressed bytes; retaining these headers corrupts them.
  headers.delete('content-encoding')
  headers.delete('content-length')
  return new Response(body, { status: response.status, headers })
})

/**
 * Serve the packaged UI at the selected server origin, adapting T3 Code's protocol routing design
 * (apps/desktop/src/electron/ElectronProtocol.ts). Relative HTTP and WebSocket URLs retain their ordinary server origin and cookie scope;
 * no origin is embedded in the renderer. Only local GET/HEAD assets are intercepted. WebSocket
 * upgrades remain Chromium network requests to the actual server.
 */
export function registerPackagedRenderer(
  root: string,
  address: () => ServerAddress,
  run: (program: Effect.Effect<Response>) => Promise<Response>,
): void {
  const desktopSession = session.defaultSession
  const forwarding = FetchHttpClient.layer
  const handle = Effect.fn('DesktopRenderer.handle')(function* (request: Request) {
    const url = yield* decodeUrl(request.url)
    const local =
      url.origin === new URL(address()).origin &&
      url.pathname !== '/api' &&
      !url.pathname.startsWith('/api/')
    if (!local) return yield* forwardRequest(request)
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return new Response(null, { status: 405 })
    return yield* serveAsset(root, request, url)
  })
  for (const scheme of ['http', 'https']) {
    desktopSession.protocol.handle(scheme, (request) =>
      run(
        handle(request).pipe(
          // @effect-diagnostics-next-line strictEffectProvide:off -- Electron protocol.handle invokes this request callback with its cookie-aware transport.
          Effect.provide(forwarding),
          Effect.provideService(FetchHttpClient.Fetch, (input, options) =>
            desktopSession.fetch(input instanceof URL ? input.href : input, {
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
