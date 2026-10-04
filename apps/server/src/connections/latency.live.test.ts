import { describe, expect, it } from '@effect/vitest'
import { Clock, Effect } from 'effect'
import { decideWithin } from '../decisions/model.ts'
import { liveDecisionEnabled, liveDecisionLayer, liveTools } from '../decisions/testing.ts'
import { toolRelevanceDecision } from './relevance.ts'
import { batchToolEffectDecision, EFFECT_BATCH_SIZE, TOOL_DESCRIPTION_LIMIT } from './effects.ts'

/** Measure raw payload cost before truncation using the production question builder.
 * Repeating real descriptive words avoids measuring cheap whitespace or repeated tokens.
 * The generous measurement budget reveals latency rather than censoring slow samples. */
describe.skipIf(!liveDecisionEnabled)('Gateway description cost', () => {
  it.live(
    'measures twenty questions at three description lengths',
    () =>
      Effect.gen(function* () {
        for (const length of [100, 500, 1500]) {
          const tools = liveTools.slice(0, 20).map((tool) => ({
            serviceName: tool.serviceName,
            account: tool.account,
            name: tool.name,
            description:
              `${tool.description}. Fields include repository, account, owner, title, content, query, timestamp, status, labels, permissions and identifiers. `
                .repeat(12)
                .slice(0, length),
          }))
          for (const phase of ['first', 'warm']) {
            const start = yield* Clock.currentTimeMillis
            const { answers, usage } = yield* decideWithin(
              toolRelevanceDecision(tools),
              { request: 'Use DeepWiki to explain how Layer works in Effect-TS/effect' },
              '10 seconds',
            )
            const latency = (yield* Clock.currentTimeMillis) - start
            yield* Effect.logInfo('Gateway relevance payload', {
              length,
              phase,
              latency,
              inputTokens: usage.inputTokens,
            })
            expect(Object.keys(answers)).toHaveLength(20)
            expect(usage.inputTokens).toBeGreaterThan(0)
          }
        }
        const tools = liveTools.slice(0, EFFECT_BATCH_SIZE).map((tool) => ({
          service: tool.serviceName,
          tool: tool.name,
          description:
            `${tool.description}. Fields include repository, account, owner, title, content, query, timestamp, status, labels, permissions and identifiers. `
              .repeat(12)
              .slice(0, TOOL_DESCRIPTION_LIMIT),
        }))
        for (const phase of ['first', 'warm']) {
          const start = yield* Clock.currentTimeMillis
          const { answers, usage } = yield* decideWithin(
            batchToolEffectDecision(tools),
            {},
            '10 seconds',
          )
          yield* Effect.logInfo('Gateway bounded effect payload', {
            size: tools.length,
            length: TOOL_DESCRIPTION_LIMIT,
            phase,
            latency: (yield* Clock.currentTimeMillis) - start,
            inputTokens: usage.inputTokens,
          })
          expect(Object.keys(answers)).toHaveLength(EFFECT_BATCH_SIZE)
          expect(usage.inputTokens).toBeGreaterThan(0)
        }
      }).pipe(Effect.provide(liveDecisionLayer)),
    60_000,
  )
})
