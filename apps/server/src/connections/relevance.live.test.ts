import { describe, expect, it } from '@effect/vitest'
import { Clock, Effect } from 'effect'
import { liveDecisionEnabled, liveDecisionLayer, liveTools } from '../decisions/testing.ts'
import { relevantTools } from './relevance.ts'

/** A single real batched call ranks necessary DeepWiki steps above unrelated tools. */
describe.skipIf(!liveDecisionEnabled)('Jev tool relevance', () => {
  it.live('ranks DeepWiki for an Effect Layer explanation', () =>
    Effect.gen(function* () {
      const start = yield* Clock.currentTimeMillis
      const ranked = yield* relevantTools(
        'Use DeepWiki to explain how Layer works in Effect-TS/effect',
        liveTools,
      )
      const elapsed = (yield* Clock.currentTimeMillis) - start
      yield* Effect.logInfo(
        `Jev relevance batch: latency=${elapsed}ms ${ranked.map(({ tool, probability }) => `${tool.name}=${probability.toFixed(6)}`).join(' ')}`,
      )
      expect(ranked.slice(0, 3).map(({ tool }) => tool.serviceName)).toEqual([
        'DeepWiki',
        'DeepWiki',
        'DeepWiki',
      ])
    }).pipe(Effect.provide(liveDecisionLayer)),
  )
})
