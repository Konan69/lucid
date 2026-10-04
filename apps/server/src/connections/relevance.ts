import { Array as Arr, Effect, Schema } from 'effect'
import { AiError, Decision } from 'effect/unstable/ai'
import { decide } from '../decisions/model.ts'

export const TOOL_RELEVANCE_THRESHOLD = 0.3
export const TOOL_CANDIDATE_LIMIT = 60
const RELEVANCE_BATCH_SIZE = 20
const RELEVANCE_CONCURRENCY = 4

interface Candidate {
  readonly serviceName: string
  readonly account: string
  readonly name: string
  readonly description: string
}

const Input = Schema.Array(
  Schema.Struct({
    request: Schema.String,
    service: Schema.String,
    account: Schema.String,
    tool: Schema.String,
    description: Schema.String,
  }),
)

/** One definition covers up to twenty positional candidates. rc.116
 * OpenRouterDecisionModel.make and TypeSafeDecisionModel.make collect every decision
 * into questions and send one createDecisions/systemOne call. Each question repeats its tool facts because Jev can confuse array positions; no Connection or Person identifiers enter the prompt. */
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
  const input = tools.map((tool) => ({
    request,
    service: tool.serviceName,
    account: tool.account,
    tool: tool.name,
    description: tool.description,
  }))
  const { answers } = yield* decide(Decision.make({ input: Input, decisions }), input)
  // Dynamic keys stay checked even though DecisionModel validates coverage; missing scores fail the whole request.
  return yield* Effect.forEach(tools, (tool, index) => {
    const answer = answers[`tool_${index}`]
    if (answer === undefined)
      return Effect.fail(
        AiError.make({
          module: 'Vivid.Relevance',
          method: 'scoreTools',
          reason: new AiError.InvalidOutputError({ description: 'Missing tool relevance answer' }),
        }),
      )
    return Effect.succeed({ tool, probability: answer.probability })
  })
})

/** Batched relevance does not discard partial failures: the owning request uses its
 * complete lexical order if any batch fails, so discovery remains predictable. Stable
 * ties preserve provider order and 0.3 keeps plausible necessary steps discoverable. */
export const relevantTools = Effect.fn('Connections.relevantTools')(function* <A extends Candidate>(
  request: string,
  tools: readonly A[],
) {
  const batches = yield* Effect.forEach(
    Arr.chunksOf(tools, RELEVANCE_BATCH_SIZE),
    (batch) => scoreBatch(request, batch),
    { concurrency: RELEVANCE_CONCURRENCY },
  )
  return batches
    .flat()
    .filter(({ probability }) => probability >= TOOL_RELEVANCE_THRESHOLD)
    .toSorted((left, right) => right.probability - left.probability)
})
