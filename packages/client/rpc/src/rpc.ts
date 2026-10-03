import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest'
import * as RpcClient from 'effect/unstable/rpc/RpcClient'
import type * as RpcClientError from 'effect/unstable/rpc/RpcClientError'
import type * as RpcGroup from 'effect/unstable/rpc/RpcGroup'
import * as RpcSerialization from 'effect/unstable/rpc/RpcSerialization'
import * as Socket from 'effect/unstable/socket/Socket'
import { VividRpc } from '@vivid/contracts/rpc'

export type VividRpcClientService = RpcClient.RpcClient<
  RpcGroup.Rpcs<typeof VividRpc>,
  RpcClientError.RpcClientError
>

/** Schema-derived product client shared by web, mobile, desktop, and the Flue runtime. */
export class VividRpcClient extends Context.Service<VividRpcClient, VividRpcClientService>()(
  'vivid/VividRpcClient',
) {
  static readonly layer = (options: {
    readonly url: string
    readonly headers?: Readonly<Record<string, string>>
  }) => {
    const headers = options.headers
    return Layer.effect(VividRpcClient, RpcClient.make(VividRpc)).pipe(
      Layer.provide(
        RpcClient.layerProtocolHttp({
          url: options.url,
          transformClient:
            headers === undefined
              ? undefined
              : (client) =>
                  HttpClient.mapRequest(client, (request) =>
                    HttpClientRequest.setHeaders(request, headers),
                  ),
        }),
      ),
      Layer.provide(RpcSerialization.layerNdjson),
    )
  }

  /**
   * The live client: every call and every `Watch…` subscription over one WebSocket to
   * `/api/live`.
   *
   * When the connection drops, everything in flight on it fails, and the socket is opened again
   * on a backoff for as long as the client lives. Nothing is replayed by the transport: a
   * subscription that wants to continue asks again (the live layer in `@vivid/state` does), and a
   * write that was on its way reports that it did not arrive. `retryTransientErrors` is off on
   * purpose. With it on, the protocol keeps a connection that stopped answering its pings (a
   * laptop that slept, a phone that changed network) to itself: the requests on it are neither
   * failed nor sent again, so every screen kept its last result and never moved again.
   *
   * `onLink` hears each time the socket opens and each time it closes or fails to open, through
   * the protocol's own `ConnectionHooks`, so an app can say that it is reconnecting.
   *
   * The caller supplies how a WebSocket is opened (`Socket.WebSocketConstructor`): a browser uses
   * the global one and sends its session cookie with the upgrade; a paired device supplies one
   * that adds its bearer token, since a native socket has no cookie to send.
   */
  static readonly layerLive = (options: {
    readonly url: string
    readonly onLink: (open: boolean) => void
  }) =>
    Layer.effect(VividRpcClient, RpcClient.make(VividRpc)).pipe(
      Layer.provide(RpcClient.layerProtocolSocket({ retryTransientErrors: false })),
      Layer.provide(
        Layer.succeed(RpcClient.ConnectionHooks)({
          onConnect: Effect.sync(() => options.onLink(true)),
          onDisconnect: Effect.sync(() => options.onLink(false)),
        }),
      ),
      Layer.provide(Socket.layerWebSocket(options.url)),
      Layer.provide(RpcSerialization.layerJson),
    )
}
