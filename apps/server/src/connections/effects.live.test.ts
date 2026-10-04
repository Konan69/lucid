import { describe, expect, it } from '@effect/vitest'
import { Clock, Effect } from 'effect'
import { decide } from '../decisions/model.ts'
import { liveDecisionEnabled, liveDecisionLayer, liveTools } from '../decisions/testing.ts'
import { READ_PROBABILITY_THRESHOLD, toolEffectDecision } from './effects.ts'

/** One real call per tool proves the distribution can safely remove Approval for
 * repository questions while preserving Approval for sending and permanent deletion. */
describe.skipIf(!liveDecisionEnabled)('Jev tool effects', () => {
  it.live(
    'separates reads from mutations across realistic provider tools',
    () =>
      Effect.gen(function* () {
        const misses: string[] = []
        const reads: number[] = []
        const mutations: number[] = []
        for (const tool of liveTools) {
          const start = yield* Clock.currentTimeMillis
          const { answers } = yield* decide(toolEffectDecision, {
            service: tool.serviceName,
            tool: tool.name,
            description: tool.description,
          })
          const elapsed = (yield* Clock.currentTimeMillis) - start
          const read = answers.effect.probabilities.read
          yield* Effect.logInfo(
            `Jev effect ${tool.name}: label=${answers.effect.label} read=${read.toFixed(6)} latency=${elapsed}ms`,
          )
          if (tool.expected === 'read') reads.push(read)
          else mutations.push(read)
          const expectedRead = tool.expected === 'read'
          if (
            read >= READ_PROBABILITY_THRESHOLD !== expectedRead ||
            answers.effect.label !== tool.expected
          )
            misses.push(
              `${tool.name}: expected=${tool.expected} label=${answers.effect.label} read=${read}`,
            )
        }
        yield* Effect.logInfo(
          `Bands: reads=${Math.min(...reads)}..${Math.max(...reads)} mutations=${Math.min(...mutations)}..${Math.max(...mutations)} misses=${JSON.stringify(misses)}`,
        )
        expect(misses).toEqual([])
      }).pipe(Effect.provide(liveDecisionLayer)),
    120_000,
  )
})
