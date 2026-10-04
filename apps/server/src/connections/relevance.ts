import { Effect, Schema } from 'effect'
import { Decision } from 'effect/unstable/ai'
import { decideWithin, DecisionUnavailable } from '../decisions/model.ts'

/** A 0.3 score promotes plausible necessary steps; lower scores retain lexical order
 * and remain discoverable. This is an ordering threshold, never an exclusion rule. */
export const TOOL_RELEVANCE_THRESHOLD = 0.3
/** Only the top twenty lexical candidates need optional semantic enrichment; the
 * remaining candidates retain their existing order without extra provider calls.
 * Calibration used 2066 input tokens for twenty questions versus 739 for five. */
export const RELEVANCE_BATCH_SIZE = 20
/** Live calibration (2026-10-04, one process): cold 20 questions 791ms/2066
 * input tokens; warm 20 341ms/2066; warm five 331ms/739; repeated warm 20
 * 347ms/2066. A 1.2-second budget leaves warm-call headroom while bounding
 * optional enrichment; outage or slow cold transport retains lexical order. */
export const RELEVANCE_BUDGET = '1200 millis'

interface Candidate {
  readonly serviceName: string
  readonly account: string
  readonly name: string
  readonly description: string
}

const Input = Schema.Struct({ request: Schema.String })

/** rc.116 OpenRouterDecisionModel.make collects all questions into one request.
 * Each question owns its tool facts, so input contains only the Person's request.
 * Dynamic-key coverage is checked before any partial answer can influence ordering. */
const scoreBatch = Effect.fn('Connections.scoreTools')(function* <A extends Candidate>(
  request: string,
  tools: readonly A[],
) {
  const decisions = Object.fromEntries(
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
  )
  const { answers, usage } = yield* decideWithin(
    Decision.make({ input: Input, decisions }),
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
