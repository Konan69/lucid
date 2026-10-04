import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer, References } from 'effect'
import { ServiceId } from '@vivid/contracts'
import { liveDecisionEnabled, liveDecisionLayer, liveTools } from '../decisions/testing.ts'
import { ExecutorTool } from './executor.ts'
import { ToolEffects, toolEffectsLayer } from './effects.ts'

/** One claim: the production direct path projects read tools correctly. This uses
 * ToolEffects' actual metadata eligibility, deadline, cache and threshold; debug scores
 * are from that attempt, not an independently repeated ten-second calibration request. */
describe.skipIf(!liveDecisionEnabled)('Gateway read effects', () => {
  it.live(
    'recover read tools without Approval',
    () =>
      Effect.gen(function* () {
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
          if (effect !== tool.expected) misses.push(`${tool.name}:${effect}`)
        }
        expect(misses).toEqual([])
      }).pipe(
        Effect.provide(toolEffectsLayer.pipe(Layer.provide(liveDecisionLayer))),
        Effect.provideService(References.MinimumLogLevel, 'Debug'),
      ),
    40_000,
  )
})
