import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import { NodeHttpClient } from '@effect/platform-node'
import { VividRpcClient } from '@vivid/client-runtime'

const rpcLayer = Layer.unwrap(
  Effect.gen(function* () {
    const serverUrl = yield* Config.URL('VIVID_SERVER_URL')
    const token = yield* Config.Redacted('VIVID_RUNTIME_TOKEN')
    return VividRpcClient.layer({
      url: new URL('/api/rpc', serverUrl).href,
      headers: { authorization: `Bearer ${Redacted.value(token)}` },
    }).pipe(Layer.provide(NodeHttpClient.layerUndici))
  }),
)

/** Runs one generated server RPC at Flue's Promise-based tool boundary. */
export const runServerRpc = <A, E>(effect: Effect.Effect<A, E, VividRpcClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(rpcLayer)))
