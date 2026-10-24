import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer, References, Logger } from 'effect'
import { ServiceId } from '@vivid/contracts'
import {
  effectScoreCount,
  LIVE_METADATA_BUDGET,
  liveDecisionEnabled,
  liveDecisionLayer,
  liveTools,
} from '../decisions/testing.ts'
import { ExecutorTool } from './executor.ts'
import { ToolEffects, toolEffectsTestLayer } from './effects.ts'

/** Destructive semantics must never remove Approval. Jev retains Executor's write
 * when the source did not declare destructive; only the source owns that upgrade.
 * Each debug receipt proves a real judgment rather than conservative outage recovery. */
describe.skipIf(!liveDecisionEnabled)('Gateway destructive effects', () => {
  it.live('never recover a destructive operation as read', () => {
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
          for (const tool of liveTools.filter(
            (candidate) => candidate.expected === 'destructive',
          )) {
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
        }).pipe(Effect.provide(context))
      }).pipe(
        Effect.scoped,
        Effect.provideService(References.MinimumLogLevel, 'Debug'),
        Effect.provideService(Logger.CurrentLoggers, loggers),
      )
    }).pipe(Effect.scoped)
  })
})
