import { describe, expect, it } from '@effect/vitest'
import { Clock, Effect } from 'effect'
import { DECISION_QUESTION_LIMIT, decideWithin } from '../decisions/model.ts'
import {
  LIVE_METADATA_BUDGET,
  liveDecisionEnabled,
  liveDecisionLayer,
  liveTools,
} from '../decisions/testing.ts'
import { toolRelevanceDecision } from './relevance.ts'
import { batchToolEffectDecision, TOOL_DESCRIPTION_LIMIT } from './effects.ts'

/** Ten warm samples per shape reveal tail latency in one gateway connection pool. The first
 * relevance call is process-cold; the first effects call is cold only for that payload shape. */
const WARM_SAMPLES = 10
/** Gateway, jev-latest, 4 Oct 2026, final three cohorts: relevance first=1037/935/999ms,
 * warm min/median/max=604/665/850, 637/688.5/1026, 640/727/1389ms; effects first=
 * 663/661/777ms, warm=619/650.5/795, 683/766.5/1103, 689/745.5/1422ms.
 * Twenty 500-character questions used relevance input/output=5024/374 tokens, effects=
 * 7603/793. Production's 1800ms budgets leave 411/378ms above these observed maxima,
 * not a promise about arbitrary future samples. Record distributions without asserting a
 * statistical tail with zero remaining margin; production deadlines have TestClock proofs. */

/** Report the whole measured distribution without substituting missing token usage. */
const statistics = (samples: readonly number[]) => {
  const ordered = samples.toSorted((left, right) => left - right)
  const lower = ordered[Math.floor((ordered.length - 1) / 2)]
  const upper = ordered[Math.floor(ordered.length / 2)]
  const median = lower === undefined || upper === undefined ? undefined : (lower + upper) / 2
  return { min: ordered[0], median, max: ordered.at(-1) }
}

/** Each shape exercises the same definition and bounded metadata used by production. */
const tools = liveTools.slice(0, DECISION_QUESTION_LIMIT).map((tool) => ({
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
    run: decideWithin(
      toolRelevanceDecision(tools),
      { request: 'Use DeepWiki to explain how Layer works in Effect-TS/effect' },
      LIVE_METADATA_BUDGET,
    ),
  },
  {
    workload: 'effects20',
    run: decideWithin(batchToolEffectDecision(effectTools), {}, LIVE_METADATA_BUDGET),
  },
]

/** One claim: real warm gateway attempts return complete usage receipts at the description cap.
 * Cold samples, warm distributions and token counts calibrate optional-work budgets; no latency assertion relies on a sleep. */
describe.skipIf(!liveDecisionEnabled)('Gateway warm latency', () => {
  it.live(
    'measures warm metadata judgments at the production description cap',
    () =>
      Effect.gen(function* () {
        const receipts: {
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
          })
        }
        for (const receipt of receipts) {
          expect(receipt.inputCount).toBe(WARM_SAMPLES + 1)
          expect(receipt.outputCount).toBe(WARM_SAMPLES + 1)
        }
      }).pipe(Effect.provide(liveDecisionLayer)),
    120_000,
  )
})
