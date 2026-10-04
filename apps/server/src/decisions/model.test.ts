import * as TestClock from 'effect/testing/TestClock'
import { expect, it } from '@effect/vitest'
import { ConfigProvider, Effect, Fiber, Layer, Logger, Predicate, Schema } from 'effect'
import { AiError, Decision, DecisionModel } from 'effect/unstable/ai'
import { HttpClient, HttpClientResponse } from 'effect/unstable/http'
import {
  decide,
  decideWithin,
  decisionConfigured,
  DecisionUnavailable,
  decisionModelLayer,
  GATEWAY_URL,
} from './model.ts'

const definition = Decision.make({
  input: Schema.String,
  decisions: {
    applies: Decision.probability({
      instructions: 'Applies',
      criteria: { false: 'No', true: 'Yes' },
    }),
  },
})

/** The switch and the provider are chosen through the real library adapter and real Config.
 * The transport records no secret values. */
it.effect.each([
  { config: { VIVID_DECISIONS: 'on', EXPLABS_API_KEY: 'test' }, model: 'jev-latest' },
  {
    config: { VIVID_DECISIONS: 'on', EXPLABS_API_KEY: 'test', VIVID_DECISION_MODEL: 'custom' },
    model: 'custom',
  },
])('switched on, asks the gateway for model $model', ({ config, model }) => {
  const transport = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      expect(request.url).toBe(`${GATEWAY_URL}/systemone`)
      const body = request.body
      if (Predicate.isTagged(body, 'Uint8Array'))
        expect(new TextDecoder().decode(body.body)).toContain(model)
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({ model, answers: { applies: { type: 'noul', noul: 0.7 } } }),
          ),
        ),
      )
    }),
  )
  return Effect.gen(function* () {
    expect((yield* decide(definition, 'question')).answers.applies.probability).toBe(0.7)
    expect(yield* decisionConfigured).toBe(true)
  }).pipe(
    Effect.provide(
      decisionModelLayer.pipe(
        Layer.provide(transport),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
      ),
    ),
  )
})

/** Off is the default and wins over a present key; on without a key is a different fact. Neither
 * makes a request, and neither writes a line per decision. */
it.effect.each([
  { name: 'by default', config: { EXPLABS_API_KEY: 'test' }, reason: 'Disabled' },
  {
    name: 'when switched off',
    config: { VIVID_DECISIONS: 'off', EXPLABS_API_KEY: 'test' },
    reason: 'Disabled',
  },
  { name: 'when on with no key', config: { VIVID_DECISIONS: 'on' }, reason: 'Unconfigured' },
] as const)('$name every decision fails at once as $reason, silently', ({ config, reason }) => {
  const lines: Array<unknown> = []
  const logger = Logger.make(({ message }) => {
    lines.push(message)
  })
  return Effect.gen(function* () {
    const first = yield* Effect.flip(decide(definition, 'one'))
    const second = yield* Effect.flip(decideWithin(definition, 'two', '1 second'))
    expect(first).toBeInstanceOf(DecisionUnavailable)
    expect(first.reason).toBe(reason)
    expect(second.reason).toBe(reason)
    expect(yield* decisionConfigured).toBe(false)
    // One line at start says the state; a decision that was never asked is not an event.
    expect(lines).toHaveLength(1)
  }).pipe(
    Effect.provide(
      decisionModelLayer.pipe(
        Layer.provide(
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die('Unexpected HTTP')),
          ),
        ),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
      ),
    ),
    Effect.provide(Logger.layer([logger])),
  )
})

/** A fault inside the provider call is an unavailable decision, never a dead caller. */
it.effect('a defect in the provider call is a typed Provider failure', () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(decide(definition, 'question'))
    expect(error).toBeInstanceOf(DecisionUnavailable)
    expect(error.reason).toBe('Provider')
  }).pipe(
    Effect.provide(
      Layer.effect(
        DecisionModel.DecisionModel,
        DecisionModel.make({ decide: () => Effect.die('library fault') }),
      ),
    ),
  ),
)

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
