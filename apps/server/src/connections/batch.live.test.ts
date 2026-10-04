import { describe, expect, it } from '@effect/vitest'
import { Array as Arr, Effect, Layer, References } from 'effect'
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

import { EFFECT_BATCH_SIZE, ToolEffects, toolEffectsLayer } from './effects.ts'

/** One claim: the production resolver retains Approval for mutations in a mixed catalog.
 * Catalogs keep their actual service identity, as production requires. This exercises batching, the actual deadline, validation, threshold and cache together;
 * attacks are a separate claim in effectsadversarial.live.test.ts. */
describe.skipIf(!liveDecisionEnabled)('Gateway batch effects', () => {
  it.live(
    'retains mutation effects through the production batch path',
    () => {
      const lines: string[] = []
      return Effect.gen(function* () {
        const effects = yield* ToolEffects
        const misses: string[] = []
        const conservativeReads: string[] = []
        const catalogs = Object.entries(Arr.groupBy(liveTools, (tool) => tool.serviceName)).flatMap(
          ([service, catalog]) =>
            Arr.chunksOf(catalog, EFFECT_BATCH_SIZE).map((batch) => ({ service, batch })),
        )
        for (const { service, batch } of catalogs) {
          const classified = yield* effects.classifyBatch({
            serviceId: ServiceId.make(`effect-${service}`),
            service,
            tools: batch.map((tool) =>
              ExecutorTool.make({
                name: tool.name,
                description: tool.description,
                effect: 'write',
                input: {},
              }),
            ),
          })
          for (const [index, tool] of batch.entries()) {
            expect(effectScoreCount(lines, tool.name), tool.name).toBe(1)
            const result = classified[index]
            if (result === undefined) misses.push(tool.name)
            else if (tool.expected !== 'read' && result.effect === 'read') misses.push(tool.name)
            else if (tool.expected === 'read' && result.effect !== 'read')
              conservativeReads.push(tool.name)
          }
        }
        yield* Effect.logInfo('Conservative batch reads retaining Approval', {
          tools: conservativeReads,
        })
        yield* Effect.logInfo('Batch read recovery', {
          recovered: 18 - conservativeReads.length,
          floor: LIVE_READ_RECOVERY_FLOOR,
        })
        expect(18 - conservativeReads.length).toBeGreaterThanOrEqual(LIVE_READ_RECOVERY_FLOOR)
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
