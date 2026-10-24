import { NodeHttpServer } from '@effect/platform-node'
import { expect, it } from '@effect/vitest'
import { Effect, Layer, Redacted, Ref, Schema } from 'effect'
import { Decision } from 'effect/ai'
import { HttpClient, HttpClientRequest, HttpServer, HttpServerResponse } from 'effect/http'
import * as TestClock from 'effect/testing/TestClock'
import { decide, decisionWouldAttempt, gatewayDecisionLayer } from './model.ts'

const question = Decision.make({
  input: Schema.Struct({}),
  decisions: {
    allowed: Decision.probability({
      instructions: 'Can this request proceed',
      criteria: { false: 'Refused', true: 'Allowed' },
    }),
  },
})

/** The real provider adapter suppresses a rejected key for five minutes, then probes again.
 * Providers can repair account state without a Vivid restart or a new Layer. */
it.effect(
  're-probes an HTTP-rejected credential after five minutes without rebuilding its Layer',
  () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(NodeHttpServer.layerTest)
      return yield* Effect.gen(function* () {
        const calls = yield* Ref.make(0)
        const server = yield* HttpServer.HttpServer
        yield* server.serve(
          Ref.update(calls, (count) => count + 1).pipe(
            Effect.as(HttpServerResponse.empty({ status: 401 })),
          ),
        )
        const origin = new URL(HttpServer.formatAddress(server.address))
        origin.hostname = '127.0.0.1'
        const transport = yield* HttpClient.HttpClient
        // Redirect at the transport boundary, after TypeSafe has prepended its gateway URL.
        const client = HttpClient.make((request) =>
          transport.execute(HttpClientRequest.setUrl(request, origin.href)),
        )
        const layer = gatewayDecisionLayer({
          key: Redacted.make('test-rejected-key'),
          model: 'jev-latest',
        }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client)))
        const model = yield* Layer.build(layer)
        const first = yield* decide(question, {}).pipe(Effect.provide(model), Effect.flip)
        expect(yield* Ref.get(calls)).toBe(1)
        expect(first.reason).toBe('Authentication')
        yield* TestClock.adjust('4 minutes')
        expect(yield* decisionWouldAttempt.pipe(Effect.provide(model))).toBe(false)
        const refused = yield* decide(question, {}).pipe(Effect.provide(model), Effect.flip)
        expect(refused.reason).toBe('Backoff')
        expect(yield* Ref.get(calls)).toBe(1)
        yield* TestClock.adjust('1 minute')
        expect(yield* decisionWouldAttempt.pipe(Effect.provide(model))).toBe(true)
        const retried = yield* decide(question, {}).pipe(Effect.provide(model), Effect.flip)
        expect(retried.reason).toBe('Authentication')
        expect(yield* Ref.get(calls)).toBe(2)
      }).pipe(Effect.provide(context))
    }).pipe(Effect.scoped),
)
