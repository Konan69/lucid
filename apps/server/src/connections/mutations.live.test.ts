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

/** The public direct path retains Approval for writes. Only its measurement budget
 * differs from production; eligibility, prompt, cache and threshold are unchanged.
 * A receipt proves every tool was judged rather than returned from timeout recovery. */
describe.skipIf(!liveDecisionEnabled)('Gateway write effects', () => {
  it.live('retain Approval for reversible mutations', () => {
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
          for (const tool of liveTools.filter((candidate) => candidate.expected === 'write')) {
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
            if (effect === 'read') misses.push(`${tool.name}:${effect}`)
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
