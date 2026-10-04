import { describe, expect, it } from '@effect/vitest'
import { Clock, Effect } from 'effect'
import { decide } from '../decisions/model.ts'
import { liveDecisionEnabled, liveDecisionLayer, liveTools } from '../decisions/testing.ts'
import { READ_PROBABILITY_THRESHOLD, toolEffectDecision } from './effects.ts'

/** Permanent removal and revocation keep their distinct destructive classification.
 * Every miss is collected before assertion so calibration reports the whole category. */
describe.skipIf(!liveDecisionEnabled)('Jev destructive effects', () => {
  it.live(
    'preserve destructive effect judgments',
    () =>
      Effect.gen(function* () {
        const misses: string[] = []
        const probabilities: number[] = []
        for (const tool of liveTools.filter((candidate) => candidate.expected === 'destructive')) {
          const start = yield* Clock.currentTimeMillis
          const { answers } = yield* decide(toolEffectDecision, {
            service: tool.serviceName,
            tool: tool.name,
            description: tool.description,
          })
          const elapsed = (yield* Clock.currentTimeMillis) - start
          const read = answers.effect.probabilities.read
          probabilities.push(read)
          yield* Effect.logInfo(
            `Jev effect ${tool.name}: label=${answers.effect.label} read=${read.toFixed(6)} latency=${elapsed}ms`,
          )
          if (read >= READ_PROBABILITY_THRESHOLD || answers.effect.label !== 'destructive')
            misses.push(
              `${tool.name}: expected=destructive label=${answers.effect.label} read=${read}`,
            )
        }
        yield* Effect.logInfo(
          `destructive band=${Math.min(...probabilities)}..${Math.max(...probabilities)} misses=${JSON.stringify(misses)}`,
        )
        expect(misses).toEqual([])
      }).pipe(Effect.provide(liveDecisionLayer)),
    60_000,
  )
})
