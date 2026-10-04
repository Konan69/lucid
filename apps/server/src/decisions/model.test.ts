import { expect, it } from '@effect/vitest'
import { ConfigProvider, Effect, Layer, Logger, Predicate, Schema } from 'effect'
import { Decision } from 'effect/unstable/ai'
import { HttpClient, HttpClientResponse } from 'effect/unstable/http'
import { decide, decisionModelLayer } from './model.ts'

const definition = Decision.make({
  input: Schema.String,
  decisions: {
    applies: Decision.probability({
      instructions: 'Applies',
      criteria: { false: 'No', true: 'Yes' },
    }),
  },
})

/** Exercise provider selection through the real library adapter, including credential
 * precedence and provider-specific defaults. The transport records no secret values. */
it.effect.each([
  {
    config: { TYPESAFE_API_KEY: 'test', OPENROUTER_API_KEY: 'other' },
    provider: 'typesafe',
    model: 'jev-1.13.0',
  },
  { config: { OPENROUTER_API_KEY: 'test' }, provider: 'openrouter', model: 'typesafe/jev-1.13' },
  {
    config: { TYPESAFE_API_KEY: 'test', VIVID_DECISION_MODEL: 'custom' },
    provider: 'typesafe',
    model: 'custom',
  },
])('selects $provider with model $model', ({ config, provider, model }) => {
  const transport = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      expect(request.url).toContain(provider)
      const body = request.body
      if (Predicate.isTagged(body, 'Uint8Array'))
        expect(new TextDecoder().decode(body.body)).toContain(model)
      const payload =
        provider === 'typesafe'
          ? { model, answers: { applies: { type: 'noul', noul: 0.7 } } }
          : {
              id: 'reply',
              model,
              answers: { applies: { type: 'noul', noul: 0.7 } },
              usage: { input_tokens: 1, output_tokens: 1 },
            }
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(JSON.stringify(payload))),
      )
    }),
  )
  return Effect.gen(function* () {
    expect((yield* decide(definition, 'question')).answers.applies.probability).toBe(0.7)
  }).pipe(
    Effect.provide(
      decisionModelLayer.pipe(
        Layer.provide(transport),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
      ),
    ),
  )
})

/** Startup warns once, names configuration only, and leaves an unavailable typed model. */
it.effect('unconfigured startup warns once and every decision fails', () => {
  let warnings = 0
  const logger = Logger.make(({ message }) => {
    expect(message).toEqual(['Decisions unconfigured: TYPESAFE_API_KEY or OPENROUTER_API_KEY'])
    warnings += 1
  })
  return Effect.gen(function* () {
    const first = yield* Effect.flip(decide(definition, 'one'))
    const second = yield* Effect.flip(decide(definition, 'two'))
    expect(first._tag).toBe('AiError')
    expect(second._tag).toBe('AiError')
    expect(warnings).toBe(1)
  }).pipe(
    Effect.provide(
      decisionModelLayer.pipe(
        Layer.provide(
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die('Unexpected HTTP')),
          ),
        ),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
      ),
    ),
    Effect.provide(Logger.layer([logger])),
  )
})
