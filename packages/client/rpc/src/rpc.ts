import * as Context from 'effect/Context'
import * as Layer from 'effect/Layer'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest'
import * as RpcClient from 'effect/unstable/rpc/RpcClient'
import type * as RpcClientError from 'effect/unstable/rpc/RpcClientError'
import type * as RpcGroup from 'effect/unstable/rpc/RpcGroup'
import * as RpcSerialization from 'effect/unstable/rpc/RpcSerialization'
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
}
