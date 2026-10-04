import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer, References } from 'effect'
import { ServiceId } from '@vivid/contracts'
import {
  effectScoreCount,
  effectScoreLogLayer,
  liveDecisionEnabled,
  liveDecisionLayer,
  liveTools,
  LIVE_READ_RECOVERY_FLOOR,
} from '../decisions/testing.ts'
import { ExecutorTool } from './executor.ts'
import { ToolEffects, toolEffectsLayer } from './effects.ts'

/** One claim: the production direct path recovers reads above a calibrated floor. This uses
 * ToolEffects' actual metadata eligibility, deadline, cache and threshold; debug scores
 * are from that attempt, not an independently repeated ten-second calibration request. */
describe.skipIf(!liveDecisionEnabled)('Gateway read effects', () => {
  it.live(
    'recover read tools without Approval',
    () => {
      const lines: string[] = []
      return Effect.gen(function* () {
        const effects = yield* ToolEffects
        const misses: string[] = []
        for (const tool of liveTools.filter((candidate) => candidate.expected === 'read')) {
          const effect = yield* effects.classify({
            serviceId: ServiceId.make(`effect-${tool.serviceName}`),
            service: tool.serviceName,
            tool: ExecutorTool.make({
              name: tool.name,
              description: tool.description,
              effect: 'write',
              input: {},
            }),
          })
          expect(effectScoreCount(lines, tool.name), tool.name).toBe(1)
          if (effect !== tool.expected) misses.push(`${tool.name}:${effect}`)
        }
        const recovered = 18 - misses.length
        yield* Effect.logInfo('Direct read recovery', {
          recovered,
          floor: LIVE_READ_RECOVERY_FLOOR,
          conservative: misses,
        })
        expect(recovered).toBeGreaterThanOrEqual(LIVE_READ_RECOVERY_FLOOR)
      }).pipe(
        Effect.provide(toolEffectsLayer.pipe(Layer.provide(liveDecisionLayer))),
        Effect.provideService(References.MinimumLogLevel, 'Debug'),
        Effect.provide(effectScoreLogLayer(lines)),
      )
    },
    60_000,
  )
})
