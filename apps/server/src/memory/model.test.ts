import { expect, it } from '@effect/vitest'
import { ConfigProvider, Effect, Layer, Predicate, Result, Schema } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/unstable/http'
import { Completion, MemoryGenerationIncomplete, MemoryModel, memoryModelLayer } from './model.ts'

const decodeRequest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      model: Schema.String,
      reasoning_effort: Schema.String,
      temperature: Schema.Finite,
      max_tokens: Schema.Finite,
    }),
  ),
)
const configuration = ConfigProvider.layer(
  ConfigProvider.fromUnknown({ EXPLABS_API_KEY: 'test', VIVID_MEMORY_MODEL: 'test-small-model' }),
)

/** Exercise the shared production provider adapter; only the network response is deliberate test data. */
function modelLayer(content: string, reason: string) {
  const client = HttpClient.make(
    Effect.fn('MemoryModel.test.http')(function* (request) {
      if (!Predicate.isTagged(request.body, 'Uint8Array'))
        return yield* Effect.sync(() => expect.fail('Missing JSON body'))
      const body = yield* decodeRequest(new TextDecoder().decode(request.body.body)).pipe(
        Effect.catch(() => Effect.sync(() => expect.fail('Malformed provider request'))),
      )
      expect(body).toEqual({
        model: 'test-small-model',
        reasoning_effort: 'low',
        temperature: 0,
        max_tokens: 4096,
      })
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          JSON.stringify({ choices: [{ message: { content }, finish_reason: reason }] }),
          { headers: { 'content-type': 'application/json' } },
        ),
      )
    }),
  )
  return memoryModelLayer.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    Layer.provide(configuration),
  )
}

const input = {
  name: 'thread_title',
  prompt: 'Give a concise title',
  content: {},
  schema: { type: 'object' },
}

it.effect('shares the configured small-model protocol for structured completion', () =>
  Effect.gen(function* () {
    const result = yield* (yield* MemoryModel).complete(input)
    expect(result).toEqual(
      Completion.cases.Finished.make({ text: '{"title":"Plan an Italian holiday"}' }),
    )
  }).pipe(Effect.provide(modelLayer('{"title":"Plan an Italian holiday"}', 'stop'))),
)

it.effect('preserves budget-limited output for the owning decoder', () =>
  Effect.gen(function* () {
    const result = yield* (yield* MemoryModel).complete(input)
    expect(result).toEqual(Completion.cases.BudgetReached.make({ text: '{"title":"Holiday"}' }))
  }).pipe(Effect.provide(modelLayer('{"title":"Holiday"}', 'length'))),
)

it.effect('rejects unfinished or blank provider output without inventing a title', () =>
  Effect.gen(function* () {
    const result = yield* (yield* MemoryModel).complete(input).pipe(Effect.result)
    expect(Result.isFailure(result) && result.failure).toEqual(
      MemoryGenerationIncomplete.make({
        operation: 'thread_title',
        reason: 'stop',
        outputCharacters: 0,
      }),
    )
  }).pipe(Effect.provide(modelLayer('', 'stop'))),
)
