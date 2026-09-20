import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest'
import * as HttpClientResponse from 'effect/unstable/http/HttpClientResponse'
import {
  RuntimeRunRequest,
  RuntimeRunResponse,
  type RuntimeRunResponse as RuntimeReceipt,
} from '@vivid/contracts'
import { RuntimeUnavailable } from '@vivid/contracts/rpc'
import { ServerConfig } from '../config.ts'

export interface RuntimeService {
  readonly start: (request: RuntimeRunRequest) => Effect.Effect<RuntimeReceipt, RuntimeUnavailable>
}

export class Runtime extends Context.Service<Runtime, RuntimeService>()('vivid/Runtime') {}

/** The application server has one narrow authority over Flue: submit a Run and retain its receipt. */
export const runtimeLayer = Layer.effect(
  Runtime,
  Effect.gen(function* () {
    const config = yield* ServerConfig
    const client = yield* HttpClient.HttpClient
    const endpoint = new URL('/internal/runs', config.RUNTIME_URL)

    const start = Effect.fn('Runtime.start')(function* (input: RuntimeRunRequest) {
      const request = yield* HttpClientRequest.post(endpoint).pipe(
        HttpClientRequest.bearerToken(Redacted.value(config.RUNTIME_TOKEN)),
        HttpClientRequest.schemaBodyJson(RuntimeRunRequest)(input),
        Effect.mapError(
          () => new RuntimeUnavailable({ message: 'Run request could not be encoded' }),
        ),
      )
      const response = yield* client.execute(request).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.mapError(
          () => new RuntimeUnavailable({ message: 'Vivid runtime did not accept the Run' }),
        ),
      )
      return yield* HttpClientResponse.schemaBodyJson(RuntimeRunResponse)(response).pipe(
        Effect.mapError(
          () => new RuntimeUnavailable({ message: 'Vivid runtime returned an invalid receipt' }),
        ),
      )
    })

    return Runtime.of({ start })
  }),
)
