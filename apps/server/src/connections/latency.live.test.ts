import { describe, expect, it } from '@effect/vitest'
import { Clock, Effect } from 'effect'
import { decideWithin } from '../decisions/model.ts'
import { liveDecisionEnabled, liveDecisionLayer, liveTools } from '../decisions/testing.ts'
import { toolRelevanceDecision } from './relevance.ts'
import { batchToolEffectDecision, TOOL_DESCRIPTION_LIMIT } from './effects.ts'

/** Ten warm samples per shape reveal tail latency in one gateway connection pool. The first
 * single call is process-cold; subsequent first samples are only cold for that payload shape. */
const WARM_SAMPLES = 10
/** A generous measurement budget reveals slow samples instead of censoring them at the
 * optional production deadline. The asserted warm bound is calibrated separately below. */
const MEASUREMENT_BUDGET = '10 seconds'
/** These generous measurement calls must still fit the production per-shape budgets,
 * chosen from observed warm maxima 1551/1304/1350ms with 449/496/450ms headroom. */
const budgets = { single: 2000, relevance20: 1800, effects20: 1800 }

/** Report the whole measured distribution without substituting missing token usage. */
const statistics = (samples: readonly number[]) => {
  const ordered = samples.toSorted((left, right) => left - right)
  const lower = ordered[Math.floor((ordered.length - 1) / 2)]
  const upper = ordered[Math.floor(ordered.length / 2)]
  const median = lower === undefined || upper === undefined ? undefined : (lower + upper) / 2
  return { min: ordered[0], median, max: ordered.at(-1) }
}

/** Each shape exercises the same definition and bounded metadata used by production. */
const tools = liveTools.slice(0, 20).map((tool) => ({
  serviceName: tool.serviceName,
  account: tool.account,
  name: tool.name,
  description:
    `${tool.description}. Fields include repository, account, owner, title, content, query, timestamp, status, labels, permissions and identifiers. `
      .repeat(12)
      .slice(0, TOOL_DESCRIPTION_LIMIT),
}))
const effectTools = tools.map((tool) => ({
  service: tool.serviceName,
  tool: tool.name,
  description: tool.description,
}))
const requests = [
  {
    workload: 'relevance20',
    bound: budgets.relevance20,
    run: decideWithin(
      toolRelevanceDecision(tools),
      { request: 'Use DeepWiki to explain how Layer works in Effect-TS/effect' },
      MEASUREMENT_BUDGET,
    ),
  },
  {
    workload: 'effects20',
    bound: budgets.effects20,
    run: decideWithin(batchToolEffectDecision(effectTools), {}, MEASUREMENT_BUDGET),
  },
]

/** One claim: sustained warm metadata decisions fit the calibrated optional-work bound.
 * Cold samples and token counts explain its limits; no latency assertion relies on a sleep. */
describe.skipIf(!liveDecisionEnabled)('Gateway warm latency', () => {
  it.live(
    'sustains bounded warm metadata judgments at the production description cap',
    () =>
      Effect.gen(function* () {
        const receipts: {
          readonly withinBudget: boolean
          readonly inputCount: number
          readonly outputCount: number
        }[] = []
        for (const request of requests) {
          const latencies: number[] = []
          const inputTokens: number[] = []
          const outputTokens: number[] = []
          for (let sample = 0; sample <= WARM_SAMPLES; sample += 1) {
            const start = yield* Clock.currentTimeMillis
            const response = yield* request.run
            latencies.push((yield* Clock.currentTimeMillis) - start)
            if (response.usage.inputTokens !== undefined)
              inputTokens.push(response.usage.inputTokens)
            if (response.usage.outputTokens !== undefined)
              outputTokens.push(response.usage.outputTokens)
          }
          yield* Effect.logInfo('Gateway latency calibration', {
            workload: request.workload,
            first: latencies[0],
            warm: statistics(latencies.slice(1)),
            latencies,
            inputTokens: statistics(inputTokens),
            outputTokens: statistics(outputTokens),
          })
          receipts.push({
            inputCount: inputTokens.length,
            outputCount: outputTokens.length,
            withinBudget: latencies.slice(1).every((latency) => latency < request.bound),
          })
        }
        for (const receipt of receipts) {
          expect(receipt.inputCount).toBe(WARM_SAMPLES + 1)
          expect(receipt.outputCount).toBe(WARM_SAMPLES + 1)
          expect(receipt.withinBudget).toBe(true)
        }
      }).pipe(Effect.provide(liveDecisionLayer)),
    120_000,
  )
})
