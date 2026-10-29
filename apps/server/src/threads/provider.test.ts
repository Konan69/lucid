import { NodeHttpClient, NodeHttpServer } from '@effect/platform-node'
import { describe, expect, it } from '@effect/vitest'
import { ConfigProvider, Effect, Layer, Predicate, Queue, Result, Schema } from 'effect'
import { HttpClient, HttpClientRequest, HttpServer, HttpServerResponse } from 'effect/http'
import { Decision, DecisionModel } from 'effect/ai'
import { decisionModelLayer } from '../decisions/model.ts'
import { TitleModel, titleModelLayer } from './model.ts'

const settings = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    OPENROUTER_API_KEY: 'protocol-test-key',
    VIVID_DECISIONS: 'on',
  }),
)

/** Redirect only the transport to a real local server after recording the selected provider URL.
 * Only its OpenRouter credential exists in this fixture. */
const provider = (
  requests: Queue.Queue<HttpClientRequest.HttpClientRequest>,
  response: Schema.Json,
) =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer
      const client = yield* HttpClient.HttpClient
      yield* server.serve(Effect.succeed(HttpServerResponse.jsonUnsafe(response)))
      const url = new URL(HttpServer.formatAddress(server.address))
      url.hostname = '127.0.0.1'
      return HttpClient.make((request) =>
        Queue.offer(requests, request).pipe(
          Effect.andThen(client.execute(HttpClientRequest.setUrl(request, url))),
        ),
      )
    }),
  ).pipe(Layer.provide(NodeHttpClient.layerUndici), Layer.provide(NodeHttpServer.layerTest))

const Body = Schema.fromJsonString(
  Schema.Struct({ model: Schema.String, dimensions: Schema.optionalKey(Schema.Int) }),
)
const decodeBody = Schema.decodeSync(Body)
/** HttpClient body bytes are the exact JSON sent over the real transport. */
const requestBody = (request: HttpClientRequest.HttpClientRequest) => {
  if (!Predicate.isTagged(request.body, 'Uint8Array'))
    throw new Error('Expected JSON request bytes')
  return decodeBody(new TextDecoder().decode(request.body.body))
}

/** The same adapters used in production select one configured provider for every kind of model call. */
describe('OpenRouter server adapters', () => {
  it.effect('completes structured text with the OpenRouter credential', () =>
    Effect.gen(function* () {
      const requests = yield* Queue.unbounded<HttpClientRequest.HttpClientRequest>()
      const acquired = yield* Layer.build(
        titleModelLayer.pipe(
          Layer.provide(
            provider(requests, {
              choices: [
                { message: { content: '{"title":"Florence holiday"}' }, finish_reason: 'stop' },
              ],
            }),
          ),
          Layer.provide(settings),
        ),
      ).pipe(Effect.result)
      expect(
        Result.isSuccess(acquired),
        'OpenRouter text adapter must start with only its selected key',
      ).toBe(true)
      const context = Result.getOrThrow(acquired)
      const model = yield* TitleModel.pipe(Effect.provideContext(context))
      const completion = yield* model.complete({
        name: 'title',
        prompt: 'Name the trip',
        content: 'Florence',
        schema: { type: 'object' },
      })
      expect(completion.text).toContain('Florence')
      const request = yield* Queue.take(requests)
      expect(request.url).toBe('https://openrouter.ai/api/v1/chat/completions')
      expect(requestBody(request).model).toBe('z-ai/glm-5.3-flash')
    }).pipe(Effect.scoped),
  )

  it.effect('uses the compatible System One endpoint for decisions', () =>
    Effect.gen(function* () {
      const requests = yield* Queue.unbounded<HttpClientRequest.HttpClientRequest>()
      const acquired = yield* Layer.build(
        decisionModelLayer.pipe(
          Layer.provide(
            provider(requests, {
              model: 'jev-latest',
              answers: { urgent: { type: 'noul', noul: 0.9 } },
            }),
          ),
          Layer.provide(settings),
        ),
      ).pipe(Effect.result)
      expect(
        Result.isSuccess(acquired),
        'OpenRouter decision adapter must start with only its selected key',
      ).toBe(true)
      const context = Result.getOrThrow(acquired)
      const definition = Decision.make({
        input: Schema.String,
        decisions: {
          urgent: Decision.probability({
            instructions: 'Needs action today',
            criteria: { true: 'today', false: 'later' },
          }),
        },
      })
      const answered = yield* DecisionModel.decide(definition, { input: 'Today' }).pipe(
        Effect.provideContext(context),
        Effect.result,
      )
      expect(
        Result.isSuccess(answered),
        'The configured OpenRouter decision must be answered',
      ).toBe(true)
      const result = Result.getOrThrow(answered)
      expect(result.answers.urgent.probability).toBe(0.9)
      const request = yield* Queue.take(requests)
      expect(request.url).toBe('https://openrouter.ai/api/v1/systemone')
      expect(requestBody(request).model).toBe('jev-latest')
    }).pipe(Effect.scoped),
  )
})
