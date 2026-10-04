import { describe, expect, it } from '@effect/vitest'
import { Clock, Effect } from 'effect'
import { decide } from '../decisions/model.ts'
import { liveDecisionEnabled, liveDecisionLayer, liveTools } from '../decisions/testing.ts'
import { READ_PROBABILITY_THRESHOLD, toolEffectDecision } from './effects.ts'

/** One real call per tool proves the distribution can safely remove Approval for
 * repository questions while preserving Approval for sending and permanent deletion. */
describe.skipIf(!liveDecisionEnabled)('Jev tool effects', () => {
  it.live('DeepWiki reads exceed 0.95 and email/deletion do not', () =>
    Effect.gen(function* () {
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
        if (tool.serviceName === 'DeepWiki')
          expect(read).toBeGreaterThanOrEqual(READ_PROBABILITY_THRESHOLD)
        else expect(read).toBeLessThan(READ_PROBABILITY_THRESHOLD)
        if (tool.name === 'delete_repository') expect(answers.effect.label).toBe('destructive')
      }
    }).pipe(Effect.provide(liveDecisionLayer)),
  )
})
