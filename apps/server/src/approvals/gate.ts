import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
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

export interface GateService {
  /**
   * Decides whether Vivid may take `action` now, acting for `actor`.
   *
   * The model never decides this. A `read` passes. A `write` or `destructive` action is weighed
   * against the rules that bind the acting Person: `Never` beats `Ask` beats `Allow`, a Company's
   * rules are binding on every Member, and a Person's own rules can only make things stricter.
   * When no rule allows it, the answer is to ask. If the rules cannot be weighed (the check
   * itself fails), the answer is also to ask.
   */
  readonly check: (
    actor: Actor,
    action: ProposedAction,
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
