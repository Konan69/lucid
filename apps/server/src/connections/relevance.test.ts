import { expect, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { DecisionModel } from 'effect/unstable/ai'
import { ScriptedAnswer } from '../decisions/testing.ts'
import { unconfiguredDecisionLayer } from '../decisions/model.ts'
import { TOOL_DESCRIPTION_LIMIT } from './effects.ts'
import { relevantTools } from './relevance.ts'

/** Truncation bounds only the semantic request. Returned candidates retain their complete
 * original descriptions and object identity so ranking never mutates discovery metadata. */
it.effect('caps relevance descriptions before constructing questions', () => {
  const tools = Array.from({ length: 20 }, (_, index) => ({
    serviceName: 'Records',
    account: 'Work',
    name: `lookup_${index}`,
    description: `${'Read existing records. '.repeat(100)}uniqueTail`,
  }))
  let calls = 0
  const model = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: ({ decisions }) => {
        calls += 1
        for (const question of Object.values(decisions)) {
          expect(question.instructions).not.toContain('uniqueTail')
          expect(question.instructions).toContain(
            JSON.stringify('Read existing records. '.repeat(100).slice(0, TOOL_DESCRIPTION_LIMIT)),
          )
        }
        return Effect.succeed({
          answers: Object.fromEntries(
            Object.keys(decisions).map((key) => [
              key,
              ScriptedAnswer.cases.Probability.make({ probability: 0.1 }),
            ]),
          ),
          usage: { inputTokens: undefined, outputTokens: undefined },
        })
      },
    }),
  )
  return Effect.gen(function* () {
    const result = yield* relevantTools('read records', tools)
    expect(result.ordered).toEqual(tools)
    expect(result.ordered.every((tool, index) => tool === tools[index])).toBe(true)
    expect(calls).toBe(1)
  }).pipe(Effect.provide(model))
})

/** Absence and a sole lexical result are valid discovery states. Neither spends a provider
 * request, even if the provided model cannot answer anything. Usage is genuinely unreported. */
it.effect('returns empty and single candidate lists without a decision', () =>
  Effect.gen(function* () {
    const single = [
      {
        serviceName: 'Records',
        account: 'Work',
        name: 'read',
        description: 'Read records',
      },
    ]
    for (const tools of [[], single]) {
      const result = yield* relevantTools('read records', tools)
      expect(result.ordered).toBe(tools)
      expect(result.usage.inputTokens).toBeUndefined()
      expect(result.usage.outputTokens).toBeUndefined()
    }
  }).pipe(Effect.provide(unconfiguredDecisionLayer)),
)
