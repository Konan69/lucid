import { describe, expect, it } from '@effect/vitest'
import { Array as Arr, Effect, Layer, References, Logger } from 'effect'
import { ServiceId } from '@vivid/contracts'
import {
  effectScoreCount,
  LIVE_METADATA_BUDGET,
  LIVE_METADATA_COHORT_BUDGET_MILLIS,
  liveDecisionEnabled,
  liveDecisionLayer,
  liveTools,
  LIVE_READ_RECOVERY_FLOOR,
} from '../decisions/testing.ts'
import { DECISION_QUESTION_LIMIT } from '../decisions/model.ts'
import { ExecutorTool } from './executor.ts'
import { ToolEffects, toolEffectsTestLayer } from './effects.ts'

/** One claim: the production resolver retains Approval for mutations in a mixed catalog.
 * Catalogs keep their actual service identity, as production requires. This exercises
 * batching, validation, threshold and cache together under a measurement budget;
 * attacks are a separate claim in effectsadversarial.live.test.ts. */
describe.skipIf(!liveDecisionEnabled)('Gateway batch effects', () => {
  it.live(
    'retains mutation effects through the production batch path',
    () => {
      const lines: string[] = []
      return Effect.gen(function* () {
        const loggers = new Set([
          Logger.consoleLogFmt,
          Logger.make(({ message }) => lines.push(JSON.stringify(message))),
        ])
        return yield* Effect.gen(function* () {
          const context = yield* Layer.build(
            toolEffectsTestLayer(LIVE_METADATA_BUDGET).pipe(Layer.provide(liveDecisionLayer)),
          )
          return yield* Effect.gen(function* () {
            const effects = yield* ToolEffects
            const misses: string[] = []
            const conservativeReads: string[] = []
            const catalogs = Object.entries(
              Arr.groupBy(liveTools, (tool) => tool.serviceName),
            ).flatMap(([service, catalog]) =>
              Arr.chunksOf(catalog, DECISION_QUESTION_LIMIT).map((batch) => ({ service, batch })),
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
                else if (tool.expected !== 'read' && result.effect === 'read')
                  misses.push(tool.name)
                else if (tool.expected === 'read' && result.effect !== 'read')
                  conservativeReads.push(tool.name)
              }
            }
            yield* Effect.logInfo('Conservative batch reads retaining Approval', {
              tools: conservativeReads,
            })
            yield* Effect.logInfo('Batch read recovery', {
              recovered:
                liveTools.filter((tool) => tool.expected === 'read').length -
                conservativeReads.length,
              floor: LIVE_READ_RECOVERY_FLOOR,
            })
            expect(
              liveTools.filter((tool) => tool.expected === 'read').length -
                conservativeReads.length,
            ).toBeGreaterThanOrEqual(LIVE_READ_RECOVERY_FLOOR)
            expect(misses).toEqual([])
          }).pipe(Effect.provide(context))
        }).pipe(
          Effect.scoped,
          Effect.provideService(References.MinimumLogLevel, 'Debug'),
          Effect.provideService(Logger.CurrentLoggers, loggers),
        )
      }).pipe(Effect.scoped)
    },
    LIVE_METADATA_COHORT_BUDGET_MILLIS,
  )
})
