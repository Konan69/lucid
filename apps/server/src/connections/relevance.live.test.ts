import { describe, expect, it } from '@effect/vitest'
import { Clock, Effect } from 'effect'
import { liveDecisionEnabled, liveDecisionLayer, liveTools } from '../decisions/testing.ts'
import { relevantTools } from './relevance.ts'

/** One process measures cold transport and warm question-count cost on the production
 * definition; no fixtures enter production, and credentials remain in the live Layer. */
describe.skipIf(!liveDecisionEnabled)('Jev tool relevance', () => {
  it.live(
    'promotes necessary tools in one bounded request',
    () =>
      Effect.gen(function* () {
        for (const [label, size] of [
          ['cold20', 20],
          ['warm20', 20],
          ['warm5', 5],
          ['warm20again', 20],
        ] as const) {
          const start = yield* Clock.currentTimeMillis
          const { ordered, usage } = yield* relevantTools(
            'Use DeepWiki to explain how Layer works in Effect-TS/effect',
            liveTools.slice(0, size),
          )
          const elapsed = (yield* Clock.currentTimeMillis) - start
          yield* Effect.logInfo(
            `Jev relevance ${label}: latency=${elapsed}ms inputTokens=${usage.inputTokens}`,
          )
          expect(ordered.slice(0, 3).map((tool) => tool.serviceName)).toEqual([
            'DeepWiki',
            'DeepWiki',
            'DeepWiki',
          ])
          expect(ordered).toHaveLength(size)
        }
      }).pipe(Effect.provide(liveDecisionLayer)),
    45_000,
  )
})
