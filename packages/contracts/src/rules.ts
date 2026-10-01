import { Schema } from 'effect'
import { PersonSummary, RuleId } from './identity.js'

/** What Vivid does when an action matches a rule. When rules disagree, `Never` beats `Ask` beats `Allow`. */
export const RuleDecision = Schema.Literals(['Allow', 'Ask', 'Never'] as const)
export type RuleDecision = typeof RuleDecision.Type

/**
 * Whose rule it is. A Company rule applies to everyone in the Company and cannot be switched off
 * by a Member; a Person's own rule applies to them alone and can only make Vivid more careful.
 */
export const RuleScope = Schema.TaggedUnion({
  Personal: {},
  Company: {},
})
export type RuleScope = typeof RuleScope.Type

/**
 * One standing instruction, in plain words: "When Vivid wants to send an email outside the
 * Company, it should ask first."
 */
export const Rule = Schema.Struct({
  id: RuleId,
  /** The action, as the Person would say it: "send an email outside the Company". */
  action: Schema.String,
  decision: RuleDecision,
  scope: RuleScope,
  createdBy: PersonSummary,
  createdAt: Schema.Number,
}).annotate({ identifier: 'Rule', title: 'Rule' })
export interface Rule extends Schema.Schema.Type<typeof Rule> {}

export const CreateRuleRequest = Schema.Struct({
  action: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
  decision: RuleDecision,
  scope: RuleScope,
})
export interface CreateRuleRequest extends Schema.Schema.Type<typeof CreateRuleRequest> {}

export const RuleResponse = Schema.Struct({ rule: Rule })
export const RuleListResponse = Schema.Struct({ rules: Schema.Array(Rule) })
