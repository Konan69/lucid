import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { liveDecisionEnabled, liveDecisionLayer, liveTools } from '../decisions/testing.ts'
import { relevantTools } from './relevance.ts'

/** One behavioral claim: the real production ranking promotes the three necessary DeepWiki
 * tools while retaining every lexical candidate. Payload timings live in latency.live.test.ts. */
describe.skipIf(!liveDecisionEnabled)('Gateway tool relevance', () => {
  it.live('promotes necessary tools in one bounded request', () =>
    Effect.gen(function* () {
      const { ordered } = yield* relevantTools(
        'Use DeepWiki to explain how Layer works in Effect-TS/effect',
        liveTools.slice(0, 20),
      )
      expect(ordered.slice(0, 3).map((tool) => tool.serviceName)).toEqual([
        'DeepWiki',
        'DeepWiki',
        'DeepWiki',
      ])
      expect(ordered).toHaveLength(20)
    }).pipe(Effect.provide(liveDecisionLayer)),
  )
})
