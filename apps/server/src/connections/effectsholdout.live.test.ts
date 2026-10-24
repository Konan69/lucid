import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer, References, Logger } from 'effect'
import { ServiceId } from '@vivid/contracts'
import {
  effectScoreCount,
  LIVE_METADATA_BUDGET,
  liveDecisionEnabled,
  liveDecisionLayer,
} from '../decisions/testing.ts'
import { ExecutorTool } from './executor.ts'
import { ToolEffects, toolEffectsTestLayer } from './effects.ts'

/** These five tools were authored after the generalized prompt was fixed. Their
 * scores are reported separately from the calibration catalog; do not tune on them. */
const cohort = [
  {
    name: 'inspect_certificate',
    description:
      'Retrieve the expiry and issuer of an existing TLS certificate without modifying it.',
    expected: 'read',
  },
  {
    name: 'calculate_digest',
    description:
      'Compute a SHA-256 digest of the supplied bytes in memory without storing or sending anything.',
    expected: 'read',
  },
  {
    name: 'lookup_exchange_rate',
    description:
      'Retrieve the published exchange rate for a currency pair without placing a trade.',
    expected: 'read',
  },
  {
    name: 'rotate_secret',
    description: 'Replace the active API credential and invalidate the previous credential.',
    expected: 'write',
  },
  {
    name: 'reserve_inventory',
    description: 'Create a stock reservation and reduce the quantity available for sale.',
    expected: 'write',
  },
] as const

/** Each public path uses a fresh Layer and requires every tool's score receipt,
 * so timeout/backoff recovery cannot accidentally satisfy the safety claim. */
describe.skipIf(!liveDecisionEnabled)('Gateway effectsholdout', () => {
  it.live.each(['direct', 'batch'] as const)(
    'new held-out tools preserve effect safety on %s',
    (mode) => {
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
            const request = {
              serviceId: ServiceId.make('effectsholdout'),
              service: 'Records',
              tools: cohort.map((tool) =>
                ExecutorTool.make({
                  name: tool.name,
                  description: tool.description,
                  effect: 'write',
                  input: {},
                }),
              ),
            }
            const result =
              mode === 'batch'
                ? (yield* effects.classifyBatch(request)).map((tool) => tool.effect)
                : yield* Effect.forEach(request.tools, (tool) =>
                    effects.classify({ ...request, tool }),
                  )
            expect(result).toHaveLength(cohort.length)
            for (const [index, tool] of cohort.entries()) {
              expect(effectScoreCount(lines, tool.name), tool.name).toBe(1)
              if (tool.expected === 'read') expect(result[index], tool.name).toBe('read')
              else expect(result[index], tool.name).not.toBe('read')
            }
          }).pipe(Effect.provide(context))
        }).pipe(
          Effect.scoped,
          Effect.provideService(References.MinimumLogLevel, 'Debug'),
          Effect.provideService(Logger.CurrentLoggers, loggers),
        )
      }).pipe(Effect.scoped)
    },
  )
})
