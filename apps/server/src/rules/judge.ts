import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import { Decision, DecisionModel } from 'effect/unstable/ai'
import { Rule, RuleScope, type ProposedAction } from '@vivid/contracts'
import { decide } from '../decisions/model.ts'

/** A failed judge cannot authorize an action; provider detail and private payloads stay behind this seam. */
export class RulesNotJudged extends Schema.TaggedError<RulesNotJudged>()(
  'RulesNotJudged',
  {},
  { title: 'Rules not judged' },
) {}

export interface RuleJudgeService {
  readonly judge: (
    action: ProposedAction,
    rules: ReadonlyArray<Rule>,
  ) => Effect.Effect<ReadonlyArray<Rule>, RulesNotJudged>
}
export class RuleJudge extends Context.Service<RuleJudge, RuleJudgeService>()('vivid/RuleJudge') {}

/** A missed Never rule is worse than an extra match; 0.5 includes uncertain matches
 * rather than demanding high confidence before the gate can enforce a prohibition. */
export const RULE_APPLICABILITY_THRESHOLD = 0.5

const Action = Schema.Struct({
  summary: Schema.String,
  effect: Schema.String,
  target: Schema.String,
})

/** The model sees summary, effect and target tag only; target values and rationale stay
 * private. Positional keys keep rule identifiers out of provider prompts. Decision.ts
 * probability and DecisionModel.ts make validate every answer in one provider call. */
export const ruleJudgeLayer = Layer.effect(
  RuleJudge,
  Effect.gen(function* () {
    const model = yield* DecisionModel.DecisionModel
    return RuleJudge.of({
      /** Applicability alone belongs here; independent scope judgments and precedence
       * remain in judgeBinding and the gate. Failure never silently erases a rule. */
      judge: Effect.fn('RuleJudge.judge')(
        function* (action, rules) {
          if (rules.length === 0) return []
          const decisions = Object.fromEntries(
            rules.map((rule, index) => [
              `rule_${index}`,
              Decision.probability({
                instructions: `This rule applies to the proposed action: ${rule.action}`,
                criteria: { false: 'The rule does not apply', true: 'The rule applies' },
              }),
            ]),
          )
          const { answers } = yield* decide(Decision.make({ input: Action, decisions }), {
            summary: action.summary,
            effect: action.effect,
            target: action.target._tag,
          }).pipe(Effect.provideService(DecisionModel.DecisionModel, model))
          return rules.filter(
            (_, index) => answers[`rule_${index}`].probability >= RULE_APPLICABILITY_THRESHOLD,
          )
        },
        (effect) =>
          effect.pipe(
            Effect.mapError(() => new RulesNotJudged({})),
            Effect.tapError(() => Effect.logWarning('RulesNotJudged')),
          ),
      ),
    })
  }),
)

export const BindingJudgment = Schema.TaggedUnion({
  Judged: { rules: Schema.Array(Rule) },
  Uncertain: { rules: Schema.Array(Rule) },
})

/** Independent contexts preserve known prohibitions even when the other completion fails. */
export const judgeBinding = Effect.fn('Rules.judgeBinding')(function* (
  judge: RuleJudgeService,
  action: ProposedAction,
  rules: ReadonlyArray<Rule>,
) {
  const company = yield* Effect.result(
    judge.judge(
      action,
      rules.filter((rule) => RuleScope.guards.Company(rule.scope)),
    ),
  )
  const personal = yield* Effect.result(
    judge.judge(
      action,
      rules.filter((rule) => RuleScope.guards.Personal(rule.scope)),
    ),
  )
  const applicable = [company, personal].flatMap((result) =>
    Result.isSuccess(result) ? result.success : [],
  )
  return Result.isFailure(company) || Result.isFailure(personal)
    ? BindingJudgment.cases.Uncertain.make({ rules: applicable })
    : BindingJudgment.cases.Judged.make({ rules: applicable })
})
