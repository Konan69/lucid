import { ByteSize, Effect, Layer, Option } from 'effect'
import { Headers, HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'
import * as RpcServer from 'effect/rpc/RpcServer'

/** Four 5 MiB pictures grow by a third as base64. Text and the RPC envelope fit in 28 MiB. */
export const requestLimit = ByteSize.mebibytes(28)

/** Keep the old send boundary's preflight and bounded read on the HTTP RPC that replaced it. */
export const requestProtocolLayer = Layer.effect(RpcServer.Protocol)(
  Effect.gen(function* () {
    const { httpEffect, protocol } = yield* RpcServer.makeProtocolWithHttpEffect({})
    const router = yield* HttpRouter.HttpRouter
    const bounded = Effect.fn('Rpc.request')(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const declared = Headers.get(request.headers, 'content-length')
      if (Option.exists(declared, (value) => /^\d+$/u.test(value) && BigInt(value) > requestLimit))
        return HttpServerResponse.jsonUnsafe(
          { error: { message: 'That message is too large to send' } },
          { status: 413 },
        )
      return yield* httpEffect.pipe(
        Effect.provideService(HttpServerRequest.MaxBodySize, requestLimit),
      )
    })
    yield* router.add('POST', '/api/rpc', bounded())
    return protocol
  }),
)
