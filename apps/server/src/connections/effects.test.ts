import { expect, it } from '@effect/vitest'
import { Effect, Fiber, Layer } from 'effect'
import { ScriptedAnswer } from '../decisions/testing.ts'
import * as TestClock from 'effect/testing/TestClock'
import { AiError, DecisionModel } from 'effect/unstable/ai'
import { ServiceId } from '@vivid/contracts'
import { ExecutorTool } from './executor.ts'
import { ToolEffects, toolEffectsLayer } from './effects.ts'

const request = {
  serviceId: ServiceId.make('private-service-id'),
  service: 'DeepWiki',
  tool: ExecutorTool.make({
    name: 'ask_question',
    description: 'Answer a question',
    effect: 'write',
    input: {},
  }),
}

/** The production cache wraps a real DecisionModel.make implementation, so validation,
 * conservative recovery and deduplication are observed through ToolEffects.classify. */
const provider = (
  reply: (
    options: DecisionModel.ProviderOptions,
  ) => Effect.Effect<DecisionModel.ProviderResponse, AiError.AiError>,
) =>
  toolEffectsLayer.pipe(
    Layer.provide(Layer.effect(DecisionModel.DecisionModel, DecisionModel.make({ decide: reply }))),
  )

/** Full distributions test the Approval-removal threshold independently of the top label. */
const answer = (read: number, label: string) =>
  ({
    answers: {
      effect: ScriptedAnswer.cases.Classify.make({
        label,
        probabilities: { read, write: 1 - read, destructive: 0 },
      }),
    },
    usage: { inputTokens: undefined, outputTokens: undefined },
  }) satisfies DecisionModel.ProviderResponse

it.effect.each([
  { read: 0.9499, label: 'read', expected: 'write' },
  { read: 0.95, label: 'read', expected: 'read' },
  { read: 0.9501, label: 'read', expected: 'read' },
  { read: 0, label: 'destructive', expected: 'destructive' },
])('classifies $label at $read as $expected', ({ read, label, expected }) =>
  Effect.gen(function* () {
    expect(yield* (yield* ToolEffects).classify(request)).toBe(expected)
  }).pipe(Effect.provide(provider(() => Effect.succeed(answer(read, label))))),
)

it.effect('explicit hints bypass Jev; identical and concurrent writes share a cache entry', () => {
  let calls = 0
  return Effect.gen(function* () {
    const effects = yield* ToolEffects
    for (const effect of ['read', 'destructive'] as const)
      expect(
        yield* effects.classify({
          ...request,
          tool: ExecutorTool.make({ ...request.tool, effect }),
        }),
      ).toBe(effect)
    expect(calls).toBe(0)
    expect(
      yield* Effect.forEach([1, 2, 3], () => effects.classify(request), { concurrency: 3 }),
    ).toEqual(['read', 'read', 'read'])
    expect(yield* effects.classify(request)).toBe('read')
    expect(calls).toBe(1)
    yield* effects.classify({
      ...request,
      tool: ExecutorTool.make({ ...request.tool, description: 'Changed description' }),
    })
    expect(calls).toBe(2)
    yield* effects.classify({ ...request, serviceId: ServiceId.make('other-service') })
    expect(calls).toBe(3)
    yield* effects.classify({
      ...request,
      tool: ExecutorTool.make({ ...request.tool, name: 'other_tool' }),
    })
    expect(calls).toBe(4)
  }).pipe(
    Effect.provide(
      provider((input) => {
        calls += 1
        expect(JSON.stringify(input)).not.toContain(request.serviceId)
        return Effect.succeed(answer(0.99, 'read'))
      }),
    ),
  )
})

it.effect('failed or malformed decisions retain write', () =>
  Effect.gen(function* () {
    expect(yield* (yield* ToolEffects).classify(request)).toBe('write')
  }).pipe(
    Effect.provide(
      provider(() =>
        Effect.fail(
          AiError.make({
            module: 'Test',
            method: 'decide',
            reason: new AiError.InvalidOutputError({ description: 'Unavailable' }),
          }),
        ),
      ),
    ),
  ),
)

it.effect('missing distributions retain write', () =>
  Effect.gen(function* () {
    expect(yield* (yield* ToolEffects).classify(request)).toBe('write')
  }).pipe(Effect.provide(provider(() => Effect.succeed(answer(2, 'read'))))),
)

/** The approval-removing answer expires after 24 hours; refreshing rechecks metadata
 * against the provider without sleeping or depending on wall-clock scheduling. */
it.effect('cached classification expires after 24 hours', () => {
  let calls = 0
  return Effect.gen(function* () {
    const effects = yield* ToolEffects
    expect(yield* effects.classify(request)).toBe('read')
    yield* TestClock.adjust('23 hours')
    expect(yield* effects.classify(request)).toBe('read')
    expect(calls).toBe(1)
    yield* TestClock.adjust('1 hour')
    expect(yield* effects.classify(request)).toBe('read')
    expect(calls).toBe(2)
  }).pipe(
    Effect.provide(
      provider(() => {
        calls += 1
        return Effect.succeed(answer(0.99, 'read'))
      }),
    ),
  )
})

/** A stalled provider keeps Approval without attempting another request. */
it.effect('ten-second classification timeout retains write', () => {
  let calls = 0
  return Effect.gen(function* () {
    const effects = yield* ToolEffects
    const pending = yield* effects.classify(request).pipe(Effect.forkChild)
    yield* TestClock.adjust('10 seconds')
    expect(yield* Fiber.join(pending)).toBe('write')
    expect(calls).toBe(1)
  }).pipe(
    Effect.provide(
      provider(() => {
        calls += 1
        return Effect.never
      }),
    ),
  )
})
