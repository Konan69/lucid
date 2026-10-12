import { describe, expect, layer } from '@effect/vitest'
import { Effect } from 'effect'
import {
  LIVE_METADATA_BUDGET,
  liveDecisionEnabled,
  liveDecisionLayer,
  liveTools,
} from '../decisions/testing.ts'
import { relevantToolsWithin } from './relevance.ts'

/** One behavioral claim: the real production ranking promotes the three necessary DeepWiki
 * tools while retaining every lexical candidate. Payload timings live in latency.live.test.ts. */
describe.skipIf(!liveDecisionEnabled)('Gateway tool relevance', () => {
  layer(liveDecisionLayer, { excludeTestServices: true, timeout: 5_000 })((it) => {
    it.effect('promotes necessary tools in one bounded request', () =>
      Effect.gen(function* () {
        const { ordered } = yield* relevantToolsWithin(
          'Use DeepWiki to explain how Layer works in Effect-TS/effect',
          liveTools.slice(0, 20),
          LIVE_METADATA_BUDGET,
        )
        expect(ordered.slice(0, 3).map((tool) => tool.serviceName)).toEqual([
          'DeepWiki',
          'DeepWiki',
          'DeepWiki',
        ])
        expect(ordered).toHaveLength(20)
        expect(new Set(ordered)).toEqual(new Set(liveTools.slice(0, 20)))
        expect(
          ordered
            .slice(0, 3)
            .map((tool) => tool.name)
            .sort(),
        ).toEqual(['ask_question', 'read_wiki_contents', 'read_wiki_structure'])
      }),
    )
  })
})
