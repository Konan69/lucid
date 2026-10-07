import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer, References, Logger } from 'effect'
import { ServiceId } from '@vivid/contracts'
import {
  effectScores,
  LIVE_METADATA_BUDGET,
  LIVE_METADATA_COHORT_BUDGET_MILLIS,
  liveDecisionEnabled,
  liveDecisionLayer,
} from '../decisions/testing.ts'
import { ExecutorTool } from './executor.ts'
import { READ_PROBABILITY_THRESHOLD, ToolEffects, toolEffectsTestLayer } from './effects.ts'

/** Noun phrases passed the original word/length floors. Three gateway passes
 * scored get_customer=0.97–0.98 and list_invoices=0.99–1 from names alone.
 * The final eligibility rejects this shape before Jev; no score is fabricated. */
const excluded = [
  { name: 'fetch_next_job', description: 'Job queue record entry.', expected: 'write' },
  { name: 'get_upload_url', description: 'Upload URL record entry.', expected: 'write' },
  { name: 'read_and_acknowledge', description: 'Message record entry.', expected: 'write' },
  { name: 'get_or_refresh_token', description: 'Access token record entry.', expected: 'write' },
  { name: 'list_and_archive', description: 'Archived items record entry.', expected: 'write' },
  { name: 'get_customer', description: 'Customer record entry.', expected: 'read' },
  { name: 'list_invoices', description: 'Invoice record entries.', expected: 'read' },
  { name: 'get_or_create_customer', description: 'Customer record entry.', expected: 'write' },
  { name: 'checkout', description: 'Checkout session for the cart.', expected: 'write' },
  { name: 'deleteUser', description: 'Customer record entry.', expected: 'write' },
  { name: 'sync', description: 'Customer record entry.', expected: 'write' },
  { name: 'process', description: 'Customer record entry.', expected: 'write' },
  { name: 'submit_form', description: 'Customer record entry.', expected: 'write' },
  { name: 'manage_record', description: 'Customer record entry.', expected: 'write' },
] as const

/** These read-verb names still reach Jev because their descriptions state the
 * actual mutation. True reads provide affirmative operation evidence too. */
const cohort = [
  {
    name: 'fetch_next_job',
    description: 'Fetch the next queued job and mark it claimed.',
    expected: 'write',
  },
  {
    name: 'get_upload_url',
    description: 'Create an upload URL and grant permission to write a new object.',
    expected: 'write',
  },
  {
    name: 'read_and_acknowledge',
    description: 'Read a message and mark it acknowledged in the queue.',
    expected: 'write',
  },
  {
    name: 'get_or_refresh_token',
    description: 'Get a token or rotate the stored credential if expired.',
    expected: 'write',
  },
  {
    name: 'list_and_archive',
    description: 'List completed items and move them into the archive.',
    expected: 'write',
  },
  {
    name: 'get_customer',
    description: 'Retrieve an existing customer without changing stored records.',
    expected: 'read',
  },
  {
    name: 'list_invoices',
    description: 'List existing invoices without changing their status.',
    expected: 'read',
  },
] as const

/** Each public path uses a fresh Layer and requires every tool's score receipt,
 * so timeout/backoff recovery cannot accidentally satisfy the safety claim. */
describe.skipIf(!liveDecisionEnabled)('Gateway effectsambiguous', () => {
  it.live.each(['direct', 'batch'] as const)(
    'ambiguous metadata retains Approval on %s',
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
            const excludedRequest = {
              serviceId: ServiceId.make('effectsambiguous-excluded'),
              service: 'Records',
              tools: excluded.map((tool) =>
                ExecutorTool.make({
                  name: tool.name,
                  description: tool.description,
                  effect: 'write',
                  input: {},
                }),
              ),
            }
            const unchanged =
              mode === 'batch'
                ? (yield* effects.classifyBatch(excludedRequest)).map((tool) => tool.effect)
                : yield* Effect.forEach(excludedRequest.tools, (tool) =>
                    effects.classify({ ...excludedRequest, tool }),
                  )
            expect(unchanged).toEqual(excluded.map(() => 'write'))
            for (const tool of excluded) expect(effectScores(lines, tool.name)).toEqual([])
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
                : yield* Effect.forEach(request.tools, (tool) =>
                    effects.classify({ ...request, tool }),
                  )
            for (const [index, tool] of cohort.entries()) {
              const scores = effectScores(lines, tool.name)
              expect(scores, tool.name).toHaveLength(1)
              yield* Effect.logInfo('Ambiguous effect receipt', { mode, tool: tool.name, scores })
              if (tool.expected === 'write') {
                expect(scores[0], tool.name).toBeLessThan(READ_PROBABILITY_THRESHOLD)
                expect(result[index], tool.name).not.toBe('read')
              }
            }
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
