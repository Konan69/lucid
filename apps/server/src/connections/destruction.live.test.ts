import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer, References } from 'effect'
import { ServiceId } from '@vivid/contracts'
import {
  effectScoreCount,
  effectScoreLogLayer,
  liveDecisionEnabled,
  liveDecisionLayer,
  liveTools,
} from '../decisions/testing.ts'
import { ExecutorTool } from './executor.ts'
import { ToolEffects, toolEffectsLayer } from './effects.ts'

/** Destructive semantics must never remove Approval. Jev retains Executor's write
 * when the source did not declare destructive; only the source owns that upgrade.
 * Each debug receipt proves a real judgment rather than conservative outage recovery. */
describe.skipIf(!liveDecisionEnabled)('Gateway destructive effects', () => {
  it.live(
    'never recover a destructive operation as read',
    () => {
      const lines: string[] = []
      return Effect.gen(function* () {
        const effects = yield* ToolEffects
        const misses: string[] = []
        for (const tool of liveTools.filter((candidate) => candidate.expected === 'destructive')) {
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
          if (effect !== 'write') misses.push(`${tool.name}:${effect}`)
        }
        expect(misses).toEqual([])
      }).pipe(
        Effect.provide(toolEffectsLayer.pipe(Layer.provide(liveDecisionLayer))),
        Effect.provideService(References.MinimumLogLevel, 'Debug'),
        Effect.provide(effectScoreLogLayer(lines)),
      )
    },
    60_000,
  )
})
