import * as TestClock from 'effect/testing/TestClock'
import { expect, it } from '@effect/vitest'
import { ConfigProvider, Effect, Fiber, Layer, Logger, Predicate, Schema } from 'effect'
import { AiError, Decision, DecisionModel } from 'effect/unstable/ai'
import { HttpClient, HttpClientResponse } from 'effect/unstable/http'
import { decide, decideWithin, DecisionUnavailable, decisionModelLayer } from './model.ts'

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
    if (
      Array.isArray(message) &&
      message[0] === 'Decisions unconfigured: TYPESAFE_API_KEY or OPENROUTER_API_KEY'
    )
      warnings += 1
  })
  return Effect.gen(function* () {
    const first = yield* Effect.flip(decide(definition, 'one'))
    const second = yield* Effect.flip(decide(definition, 'two'))
    expect(first).toBeInstanceOf(DecisionUnavailable)
    expect(second).toBeInstanceOf(DecisionUnavailable)
    expect(first.reason).toBe('Unconfigured')
    expect(second.reason).toBe('Unconfigured')
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

/** Provider payloads stop at the decision boundary, including validation failures. */
it.effect('provider failure exposes only a typed unavailable reason', () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(decide(definition, 'private input'))
    expect(error).toBeInstanceOf(DecisionUnavailable)
    expect(error.reason).toBe('Provider')
    expect(JSON.stringify(error)).not.toContain('private')
  }).pipe(
    Effect.provide(
      Layer.effect(
        DecisionModel.DecisionModel,
        DecisionModel.make({
          decide: () =>
            Effect.fail(
              AiError.make({
                module: 'Test',
                method: 'decide',
                reason: new AiError.InvalidOutputError({ description: 'private provider payload' }),
              }),
            ),
        }),
      ),
    ),
  ),
)

/** Controllable time proves both budgets without wall-clock sleeps. */
it.effect.each(['10 seconds', '1200 millis'] as const)('bounds a stalled request at %s', (budget) =>
  Effect.gen(function* () {
    const pending = yield* (
      budget === '10 seconds'
        ? decide(definition, 'question')
        : decideWithin(definition, 'question', budget)
    ).pipe(Effect.forkChild)
    yield* TestClock.adjust(budget)
    const error = yield* Effect.flip(Fiber.join(pending))
    expect(error).toBeInstanceOf(DecisionUnavailable)
    expect(error.reason).toBe('TimedOut')
  }).pipe(
    Effect.provide(
      Layer.effect(DecisionModel.DecisionModel, DecisionModel.make({ decide: () => Effect.never })),
    ),
  ),
)
