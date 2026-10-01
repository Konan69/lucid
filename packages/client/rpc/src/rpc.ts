import * as Context from 'effect/Context'
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
   * `/api/live`. The socket reconnects on its own and open subscriptions resume, so a screen that
   * was showing live data keeps showing it after a dropped connection.
   *
   * The caller supplies how a WebSocket is opened (`Socket.WebSocketConstructor`): a browser uses
   * the global one and sends its session cookie with the upgrade; a paired device supplies one
   * that adds its bearer token, since a native socket has no cookie to send.
   */
  static readonly layerLive = (options: { readonly url: string }) =>
    Layer.effect(VividRpcClient, RpcClient.make(VividRpc)).pipe(
      Layer.provide(RpcClient.layerProtocolSocket({ retryTransientErrors: true })),
      Layer.provide(Socket.layerWebSocket(options.url)),
      Layer.provide(RpcSerialization.layerJson),
    )
}
