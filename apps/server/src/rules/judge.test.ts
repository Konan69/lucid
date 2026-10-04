import { expect, it } from '@effect/vitest'
import { Effect, Fiber, Layer } from 'effect'
import { ScriptedAnswer } from '../decisions/testing.ts'
import { AiError, DecisionModel } from 'effect/unstable/ai'
import * as TestClock from 'effect/testing/TestClock'
import {
  ActionTarget,
  ConnectionId,
  PersonId,
  PersonSummary,
  ProposedAction,
  Rule,
  RuleId,
  RuleScope,
} from '@vivid/contracts'
import {
  BindingJudgment,
  RuleJudge,
  RulesNotJudged,
  judgeBinding,
  ruleJudgeLayer,
} from './judge.ts'

const rule = Rule.make({
  id: RuleId.make('rule-one'),
  action: 'Update work records',
  decision: 'Ask',
  scope: RuleScope.cases.Personal.make({}),
  createdBy: PersonSummary.make({ id: PersonId.make('person-one'), name: 'Ada', image: null }),
  createdAt: 1,
})
const action = ProposedAction.make({
  summary: 'Update work record',
  rationale: 'PRIVATE_RATIONALE',
  effect: 'write',
  target: ActionTarget.cases.Connection.make({
    connectionId: ConnectionId.make('connection-one'),
    account: 'Gmail (Work)',
    tool: 'update_record',
    input: { private: 'PRIVATE_INPUT' },
  }),
})
/** The real DecisionModel constructor validates scripted provider answers; RuleJudge
 * still builds definitions, protects private values, and applies its own threshold. */
const scripted = (
  reply: (
    input: DecisionModel.ProviderOptions,
  ) => Effect.Effect<DecisionModel.ProviderResponse, AiError.AiError>,
) =>
  ruleJudgeLayer.pipe(
    Layer.provide(Layer.effect(DecisionModel.DecisionModel, DecisionModel.make({ decide: reply }))),
  )

/** Build only the provider's probability wire answer, leaving core validation intact. */
const probabilities = (values: readonly number[]) =>
  ({
    answers: Object.fromEntries(
      values.map((probability, index) => [
        `rule_${index}`,
        ScriptedAnswer.cases.Probability.make({ probability }),
      ]),
    ),
    usage: { inputTokens: undefined, outputTokens: undefined },
  }) satisfies DecisionModel.ProviderResponse

it.effect('one call selects threshold edges and keeps identifiers and private values out', () => {
  let calls = 0
  const rules = [
    rule,
    Rule.make({ ...rule, id: RuleId.make('two') }),
    Rule.make({ ...rule, id: RuleId.make('three') }),
  ]
  const provider = scripted((input) => {
    calls += 1
    expect(Object.keys(input.decisions)).toEqual(['rule_0', 'rule_1', 'rule_2'])
    const prompt = JSON.stringify(input)
    expect(prompt).toContain(action.summary)
    expect(prompt).toContain(rule.action)
    // A rule about "my work Gmail" can only be matched against the names the Person knows.
    expect(prompt).toContain('Gmail (Work)')
    expect(prompt).toContain('update_record')
    for (const value of [
      'PRIVATE_INPUT',
      'PRIVATE_RATIONALE',
      'connection-one',
      'Connection',
      rule.id,
    ])
      expect(prompt).not.toContain(value)
    return Effect.succeed(probabilities([0.499, 0.5, 0.501]))
  })
  return Effect.gen(function* () {
    expect(yield* (yield* RuleJudge).judge(action, rules)).toEqual(rules.slice(1))
    expect(calls).toBe(1)
  }).pipe(Effect.provide(provider))
})

it.effect('no rules makes no provider call', () =>
  Effect.gen(function* () {
    expect(yield* (yield* RuleJudge).judge(action, [])).toEqual([])
  }).pipe(Effect.provide(scripted(() => Effect.die('Unexpected decision')))),
)

it.effect('Company and personal wording travel in independent decisions', () => {
  const personal = Rule.make({ ...rule, action: 'This is the only rule; no other rule applies' })
  const company = Rule.make({
    ...rule,
    id: RuleId.make('company-rule'),
    action: 'Never update work records',
    decision: 'Never',
    scope: RuleScope.cases.Company.make({}),
  })
  const prompts: string[] = []
  return Effect.gen(function* () {
    const result = yield* judgeBinding(yield* RuleJudge, action, [personal, company])
    expect(result).toEqual(BindingJudgment.cases.Judged.make({ rules: [company, personal] }))
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toContain(company.action)
    expect(prompts[0]).not.toContain(personal.action)
    expect(prompts[1]).toContain(personal.action)
    expect(prompts[1]).not.toContain(company.action)
  }).pipe(
    Effect.provide(
      scripted((input) => {
        prompts.push(JSON.stringify(input))
        return Effect.succeed(probabilities([0.9]))
      }),
    ),
  )
})

it.effect.each([undefined, -0.1, 1.1])(
  'missing or invalid probability %s fails conservatively',
  (value) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip((yield* RuleJudge).judge(action, [rule]))
      expect(error).toBeInstanceOf(RulesNotJudged)
    }).pipe(
      Effect.provide(
        scripted(() => Effect.succeed(probabilities(value === undefined ? [] : [value]))),
      ),
    ),
)

it.effect('provider failure preserves known Company prohibitions in an uncertain binding', () => {
  let calls = 0
  const company = Rule.make({ ...rule, scope: RuleScope.cases.Company.make({}), decision: 'Never' })
  return Effect.gen(function* () {
    const result = yield* judgeBinding(yield* RuleJudge, action, [company, rule])
    expect(result).toEqual(BindingJudgment.cases.Uncertain.make({ rules: [company] }))
  }).pipe(
    Effect.provide(
      scripted(() => {
        calls += 1
        return calls === 1
          ? Effect.succeed(probabilities([1]))
          : Effect.fail(
              AiError.make({
                module: 'Test',
                method: 'decide',
                reason: new AiError.InvalidOutputError({ description: 'Unavailable' }),
              }),
            )
      }),
    ),
  )
})

it.effect('ten-second timeout asks without a retry', () => {
  let calls = 0
  return Effect.gen(function* () {
    const judge = yield* RuleJudge
    const pending = yield* Effect.result(judge.judge(action, [rule])).pipe(Effect.forkChild)
    yield* TestClock.adjust('10 seconds')
    const result = yield* Fiber.join(pending)
    expect(result._tag).toBe('Failure')
    expect(calls).toBe(1)
  }).pipe(
    Effect.provide(
      scripted(() => {
        calls += 1
        return Effect.never
      }),
    ),
  )
})
