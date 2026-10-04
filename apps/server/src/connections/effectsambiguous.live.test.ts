import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer, References } from 'effect'
import { ServiceId } from '@vivid/contracts'
import {
  effectScoreCount,
  effectScoreLogLayer,
  liveDecisionEnabled,
  liveDecisionLayer,
} from '../decisions/testing.ts'
import { ExecutorTool } from './executor.ts'
import { ToolEffects, toolEffectsLayer } from './effects.ts'

/** Noun phrases exceed the 15-character evidence floor but state no read semantics.
 * Mutating and ambiguous names cannot turn this weak evidence into a read. */
const cohort = [
  { name: 'get_or_create_customer', description: 'Customer record.', expected: 'write' },
  { name: 'checkout', description: 'Checkout session for the cart.', expected: 'write' },
  { name: 'deleteUser', description: 'Customer record.', expected: 'write' },
  { name: 'sync', description: 'Customer record.', expected: 'write' },
  { name: 'process', description: 'Customer record.', expected: 'write' },
  { name: 'submit_form', description: 'Customer record.', expected: 'write' },
  { name: 'manage_record', description: 'Customer record.', expected: 'write' },
] as const

/** Each public path uses a fresh Layer and requires every tool's score receipt,
 * so timeout/backoff recovery cannot accidentally satisfy the safety claim. */
describe.skipIf(!liveDecisionEnabled)('Gateway effectsambiguous', () => {
  it.live.each(['direct', 'batch'] as const)(
    'ambiguous metadata retains Approval on %s',
    (mode) => {
      const lines: string[] = []
      return Effect.gen(function* () {
        const effects = yield* ToolEffects
        const request = {
          serviceId: ServiceId.make('effectsambiguous'),
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
            : yield* Effect.forEach(request.tools, (tool) => effects.classify({ ...request, tool }))
        for (const [index, tool] of cohort.entries()) {
          expect(effectScoreCount(lines, tool.name), tool.name).toBe(1)
          if (tool.expected === 'read') expect(result[index], tool.name).toBe('read')
          else expect(result[index], tool.name).not.toBe('read')
        }
      }).pipe(
        Effect.provide(toolEffectsLayer.pipe(Layer.provide(liveDecisionLayer))),
        Effect.provideService(References.MinimumLogLevel, 'Debug'),
        Effect.provide(effectScoreLogLayer(lines)),
      )
    },
    60_000,
  )
})
