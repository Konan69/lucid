import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import {
  Approval,
  type NotFound,
  type Person,
  type ProposedAction,
  type Workspace,
} from '@vivid/contracts'
import type { Actor } from '../auth/access.ts'
import type { DatabaseInfrastructureError } from '../database/client.ts'

/**
 * What the server decided about one thing Vivid wants to do.
 *
 * - `Allowed`: do it now.
 * - `ApprovalRequired`: an Approval was raised in the Thread for the acting Person; the tool
 *   reports that and the Run ends its turn. The action runs later, from the stored copy, if and
 *   when that Person allows it.
 * - `Blocked`: a rule says never. `rule` is the rule's own wording, for Vivid to repeat.
 */
export const GateDecision = Schema.TaggedUnion({
  Allowed: {},
  ApprovalRequired: { approval: Approval },
  Blocked: { rule: Schema.String },
})
export type GateDecision = typeof GateDecision.Type

/**
 * Whether the action would bring something of the acting Person's own into a Thread other people
 * can read. `PersonalInShared` is a personal Connection used in a shared Thread: Vivid asks first
 * even for a read, because the answer lands where others see it (docs/22, "Shared work asks
 * first"). Everything else is `Ordinary`.
 */
export const GateExposure = Schema.Literals(['Ordinary', 'PersonalInShared'] as const)
export type GateExposure = typeof GateExposure.Type

export interface GateService {
  /**
   * Decides whether Vivid may take `action` now, acting for `actor`.
   *
   * The working model never decides this. A `read` passes. A `write` or `destructive` action is
   * weighed against the rules that bind the acting Person: `Never` beats `Ask` beats `Allow`, a
   * Company's rules are binding on every Member, and a Person's own rules can only make things
   * stricter. With no rule, the default is to run: only an action that uses something of the
   * Person's own, or is `destructive`, goes to the `Reviewer`, and `policy.ts#reviewOutcome` asks
   * only when the Person did not ask for it and it reaches other people or cannot be undone. If
   * the rules cannot be weighed (the check itself fails), the answer is to ask.
   */
  readonly check: (
    actor: Actor,
    action: ProposedAction,
    exposure: GateExposure,
  ) => Effect.Effect<GateDecision, NotFound | DatabaseInfrastructureError>
}

/** The trust loop's single decision point. Implemented in `approvals/gate.ts` by `gateLayer`. */
export class Gate extends Context.Service<Gate, GateService>()('vivid/Gate') {}

/** How an action that was allowed to run ended. `Unknown` is honest: it may or may not have happened. */
export const ActionOutcome = Schema.TaggedUnion({
  Succeeded: { result: Schema.String },
  Failed: { reason: Schema.String },
  Unknown: {},
})
export type ActionOutcome = typeof ActionOutcome.Type

export interface ActionRunnerService {
  /**
   * Performs one stored action for the Person who approved it. It is called exactly once per
   * Approval, after the Approval has been claimed, with the action as it was stored when proposed
   * and never with anything the model says afterwards. It does not fail: every ending is an
   * `ActionOutcome`.
   */
  readonly run: (input: {
    readonly person: Person
    readonly workspace: Workspace
    readonly action: ProposedAction
  }) => Effect.Effect<ActionOutcome>
}

/**
 * Performs approved actions. Composed in `main.ts` from the domains that own each kind of target:
 * Connections for `Connection`, the Computer for `Command` and `Browser`.
 */
export class ActionRunner extends Context.Service<ActionRunner, ActionRunnerService>()(
  'vivid/ActionRunner',
) {}

import * as Layer from 'effect/Layer'
import { ActionTarget, BrowseTarget, AuditEvent } from '@vivid/contracts'
import { Audit } from '../audit/record.ts'
import { RuleStore } from '../rules/store.ts'
import { BindingJudgment, RuleJudge, judgeBinding } from '../rules/judge.ts'
import { ApprovalStore } from './store.ts'
import { auditAction } from './action.ts'
import { reviewOutcome } from './policy.ts'
import { Reviewer } from './review.ts'

/** Record commands, consequential Connection allowance and use of the Person's own browser. */
const allow = Effect.fn('Gate.allow')(function* (
  audit: Audit['Service'],
  actor: Actor,
  action: ProposedAction,
) {
  if (
    ActionTarget.guards.Command(action.target) ||
    (ActionTarget.guards.Connection(action.target) && action.effect !== 'read') ||
    (ActionTarget.guards.Browser(action.target) && BrowseTarget.guards.Person(action.target.target))
  ) {
    yield* audit.record(
      actor,
      AuditEvent.cases.ActionAllowed.make({ ...auditAction(action), effect: action.effect }),
    )
  }
  return GateDecision.cases.Allowed.make({})
})

/** Raises the Approval the acting Person must answer; the turn ends until they do. */
const ask = Effect.fn('Gate.ask')(function* (
  approvals: ApprovalStore['Service'],
  actor: Actor,
  action: ProposedAction,
) {
  return GateDecision.cases.ApprovalRequired.make({
    approval: yield* approvals.raise(actor, action),
  })
})

/**
 * Whether an action with no rule is worth a review. Work on Vivid's own Computer is contained
 * there (docs/22), so an undoable step runs without a provider call; the Person's own accounts
 * and browser, and anything `destructive`, are reviewed.
 */
const reviewable = (action: ProposedAction) =>
  action.effect === 'destructive' ||
  ActionTarget.guards.Connection(action.target) ||
  (ActionTarget.guards.Browser(action.target) && BrowseTarget.guards.Person(action.target.target))

/** Server policy owns precedence; the judge only supplies applicability and cannot authorize an action. */
export const gateLayer = Layer.effect(
  Gate,
  Effect.gen(function* () {
    const rules = yield* RuleStore
    const judge = yield* RuleJudge
    const approvals = yield* ApprovalStore
    const audit = yield* Audit
    const reviewer = yield* Reviewer
    return Gate.of({
      /** Ordinary reads pass; rules come first; the rest runs unless the review says a Person is needed. */
      check: Effect.fn('Gate.check')(function* (actor, action, exposure) {
        if (action.effect === 'read' && exposure === 'Ordinary')
          return yield* allow(audit, actor, action)
        const binding = yield* rules.list(actor)
        const judged = yield* judgeBinding(judge, action, binding)
        const applicable = judged.rules
        const never = applicable.find((rule) => rule.decision === 'Never')
        if (never !== undefined) {
          yield* audit.record(
            actor,
            AuditEvent.cases.ActionBlocked.make({
              ...auditAction(action),
              rule: never.action,
            }),
          )
          return GateDecision.cases.Blocked.make({ rule: never.action })
        }
        // An applicable Ask rule, rules that could not be weighed, and something personal
        // entering a shared Thread always ask: none of these is a judgment about the request.
        if (
          applicable.some((rule) => rule.decision === 'Ask') ||
          BindingJudgment.guards.Uncertain(judged) ||
          exposure === 'PersonalInShared'
        )
          return yield* ask(approvals, actor, action)
        // An Allow rule is the Person's standing request for an undoable action. It does not
        // settle a destructive one: applicability is a 0.5 match (`rules/judge.ts`), too loose
        // to let "Allow updating projects" authorize deleting one, so that goes to the review.
        if (action.effect !== 'destructive' && applicable.some((rule) => rule.decision === 'Allow'))
          return yield* allow(audit, actor, action)
        if (!reviewable(action)) return yield* allow(audit, actor, action)
        const review = yield* reviewer.review(actor, action)
        if (reviewOutcome(action.effect, review) === 'Ask')
          return yield* ask(approvals, actor, action)
        return yield* allow(audit, actor, action)
      }),
    })
  }),
)
