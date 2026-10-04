import { Effect, Schema } from 'effect'
import { Decision } from 'effect/unstable/ai'
import { decideWithin, DecisionUnavailable } from '../decisions/model.ts'
import { TOOL_DESCRIPTION_LIMIT } from './effects.ts'

/** A 0.3 score promotes plausible necessary steps; lower scores retain lexical order
 * and remain discoverable. This is an ordering threshold, never an exclusion rule. */
export const TOOL_RELEVANCE_THRESHOLD = 0.3
/** Only the top twenty lexical candidates need optional semantic enrichment; lower candidates
 * keep their order. Gateway calibration on 4 Oct 2026 used 3844 input tokens at the 500-character
 * cap, versus 7704 at 1500 characters, bounding catalog-driven payload growth. */
export const RELEVANCE_BATCH_SIZE = 20
/** Experiential Labs gateway, 4 Oct 2026: twenty 100/500/1500-character descriptions used
 * 2292/3844/7704 tokens; first calls took 831/2045/681ms and warm calls 493/667/682ms.
 * Repeat first calls: 841/619/677ms; warm: 527/611/715ms, with identical token counts.
 * At the selected 500-character cap, 1.5 seconds leaves 833ms warm headroom. A slow cold
 * connection may exceed it; optional ordering then keeps the lexical baseline. */
export const RELEVANCE_BUDGET = '1500 millis'

interface Candidate {
  readonly serviceName: string
  readonly account: string
  readonly name: string
  readonly description: string
}

const Input = Schema.Struct({ request: Schema.String })

/** One authoritative question shape serves production and gateway payload calibration.
 * Facts stay beside each question because positional relevance previously confused Jev. */
export const toolRelevanceDecision = (tools: readonly Candidate[]) =>
  Decision.make({
    input: Input,
    decisions: Object.fromEntries(
      tools.map((tool, index) => [
        `tool_${index}`,
        Decision.probability({
          instructions: `This tool can do what the request asks, or is a necessary step for it. Judge only this tool: ${JSON.stringify({ service: tool.serviceName, account: tool.account, tool: tool.name, description: tool.description })}`,
          criteria: {
            false: 'Unrelated or the wrong service',
            true: 'Directly does it or is a necessary step',
          },
        }),
      ]),
    ),
  })

/** TypeSafe sends all questions in one gateway request; missing coverage fails the
 * whole ordering so a partial provider response cannot influence discovery. */
const scoreBatch = Effect.fn('Connections.scoreTools')(function* <A extends Candidate>(
  request: string,
  tools: readonly A[],
) {
  const { answers, usage } = yield* decideWithin(
    toolRelevanceDecision(
      tools.map((tool) => ({
        ...tool,
        description: tool.description.slice(0, TOOL_DESCRIPTION_LIMIT),
      })),
    ),
    { request },
    RELEVANCE_BUDGET,
  )
  const scores = yield* Effect.forEach(tools, (tool, index) => {
    const answer = answers[`tool_${index}`]
    if (answer === undefined) return Effect.fail(new DecisionUnavailable({ reason: 'Provider' }))
    return Effect.succeed({ tool, probability: answer.probability })
  })
  return { scores, usage }
})

/** Jev can promote candidates, never remove them. Stable score ties retain lexical
 * order; unpromoted and unscored candidates follow in their original lexical order.
 * Provider usage accompanies the result so live evaluations measure the actual request. */
export const relevantTools = Effect.fn('Connections.relevantTools')(function* <A extends Candidate>(
  request: string,
  tools: readonly A[],
) {
  const { scores, usage } = yield* scoreBatch(request, tools.slice(0, RELEVANCE_BATCH_SIZE))
  const promoted = scores
    .filter(({ probability }) => probability >= TOOL_RELEVANCE_THRESHOLD)
    .toSorted((left, right) => right.probability - left.probability)
    .map(({ tool }) => tool)
  const selected = new Set(promoted)
  return { ordered: [...promoted, ...tools.filter((tool) => !selected.has(tool))], usage }
})
