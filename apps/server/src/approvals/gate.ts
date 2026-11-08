import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import {
  Approval,
  RunId,
  type ApprovalBinding,
  ThreadId,
  NotFound,
  type Person,
  type ProposedAction,
  type Workspace,
} from '@vivid/contracts'
import * as Option from 'effect/Option'
import * as Match from 'effect/Match'
import { Refusal, recordRefusal } from '../observability/refusal.ts'
import { actingRun } from '../threads/runs.ts'
import { requireThread } from '../threads/access.ts'
import type { Actor } from '../auth/access.ts'
import { Database, type DatabaseInfrastructureError } from '../database/client.ts'

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
 * can read. `PersonalInShared` is a personal Connection or computer used in a shared Thread: Vivid asks first
 * even for a read, because the answer lands where others see it (docs/22, "Shared work asks
 * first"). Everything else is `Ordinary`.
 */
export const GateExposure = Schema.Literals(['Ordinary', 'PersonalInShared'] as const)
export type GateExposure = typeof GateExposure.Type

/** Derived from the authenticated Actor. RuntimeThread is a runtime RPC outside an admitted
 * working turn (legacy cloud and Connection callers); it never grants Person-device authority.
 * Run names the admitted turn acting for that Person. Human calls do not propose actions. */
export const ActionOrigin = Schema.TaggedUnion({
  Run: { threadId: ThreadId, runId: RunId },
  RuntimeThread: { threadId: ThreadId },
})
export type ActionOrigin = typeof ActionOrigin.Type

/** Runtime RPC carries Thread authority; resolve its exact acting Run before proposing an action. */
export const actionOrigin = Effect.fn('Gate.origin')(function* (actor: Actor) {
  if (actor.by === 'person') return yield* new NotFound({ message: 'Action needs a Vivid Thread' })
  if (Option.isNone(actor.threadId))
    return yield* new NotFound({ message: 'Action needs a Vivid Thread' })
  const threadId = actor.threadId.value
  return yield* actingRun(threadId, actor.person.id).pipe(
    Effect.map((runId) => ActionOrigin.cases.Run.make({ threadId, runId })),
    Effect.catchTag('NoActingRun', ({ reason }) =>
      Match.value(reason).pipe(
        Match.when('NoWorkingRun', () =>
          Effect.succeed(ActionOrigin.cases.RuntimeThread.make({ threadId })),
        ),
        Match.when('ActsForAnotherPerson', () =>
          Effect.fail(new NotFound({ message: 'Action is acting for another Person' })),
        ),
        Match.exhaustive,
      ),
    ),
  )
})

export interface GateService {
  /**
   * Decides whether Vivid may take `action` now, acting for `actor`.
   *
   * The working model never decides this. A `read` passes. A `write` or `destructive` action is
   * weighed against the rules that bind the acting Person: `Never` beats `Ask` beats `Allow`, a
   * Company's rules are binding on every Member, and a Person's own rules can only make things
   * stricter. For watched work with no rule, the default is to run, including a write on the Person's
   * own browser (owner decision, 4 October 2026; see the ask group below): only an action that uses something of the
   * Person's own, or is `destructive`, goes to the `Reviewer`, and `policy.ts#reviewOutcome` asks
   * only when the Person did not ask for it and it reaches other people or cannot be undone. With
   * no review (decisions switched off or unavailable) a `write` runs and a `destructive` action
   * asks. If a rule that could forbid the action could not be weighed, the answer is to ask.
   * Unwatched work asks before a non-read unless reviewed as contained. An unwatched destructive action always asks.
   *
   * `bound` is what the action was prepared against: the sign-in of the Integration it uses and
   * the Thread documents whose text it carries. An Approval raised here is bound to it and goes
   * stale when any of it changes.
   */
  readonly check: (
    actor: Actor,
    action: ProposedAction,
    exposure: GateExposure,
    bound: ApprovalBinding,
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
   * and never with anything the model says afterwards. Machine endings are ActionOutcome values;
   * infrastructure failures retain their typed error for the handler.
   */
  readonly run: (input: {
    readonly person: Person
    readonly workspace: Workspace
    readonly action: ProposedAction
    readonly origin: ActionOrigin
  }) => Effect.Effect<ActionOutcome, DatabaseInfrastructureError>
}

/**
 * Performs approved actions. Composed in `main.ts` from the domains that own each kind of target:
 * Connections for `Connection`, the Computer for `Browser` and `Desktop`.
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
import { reviewOutcome, unwatchedOutcome } from './policy.ts'
import { Reviewer } from './review.ts'
import { isDreamThread } from '../dreams/thread.ts'

/** What Vivid is told when work in a Dreamer Thread tries anything but a read. */
const DREAM_READS_ONLY =
  'Work Vivid does while dreaming only reads. Nothing is changed, sent or deleted from here; put what the Person could do on the Feed instead.'

/** Whether the action is on the Person's own computer: only that Person may decide an Approval for it. */
export const usesPersonalBrowser = (action: ProposedAction) =>
  ActionTarget.match(action.target, {
    Browser: ({ target }) => BrowseTarget.match(target, { Person: () => true, Vivid: () => false }),
    Desktop: () => false,
    Connection: () => false,
  })

/** Record consequential Connection allowance and use of the Person's own browser. */
const allow = Effect.fn('Gate.allow')(function* (
  audit: Audit['Service'],
  actor: Actor,
  action: ProposedAction,
) {
  if (
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
  bound: ApprovalBinding,
) {
  return GateDecision.cases.ApprovalRequired.make({
    approval: yield* approvals.raise(actor, action, bound),
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
    const database = yield* Database
    /** Background Threads need containment even after expiry or without an admitted Run. */
    const checkUnwatched = Effect.fn('Gate.checkUnwatched')(function* (
      actor: Actor,
      action: ProposedAction,
      origin: ActionOrigin,
      bound: ApprovalBinding,
    ) {
      if (action.effect === 'read') return Option.none()
      const thread = yield* requireThread(origin.threadId, actor.person.id).pipe(
        Effect.provideService(Database, database),
      )
      if (thread.place !== 'Background') return Option.none()
      const review = yield* reviewer.review(actor, action)
      if (unwatchedOutcome(action.effect, review) === 'Ask')
        return Option.some<GateDecision>(yield* ask(approvals, actor, action, bound))
      return Option.some<GateDecision>(yield* allow(audit, actor, action))
    })
    /**
     * What is decided before rules: an ordinary read passes, and anything else in a Dreamer
     * Thread is refused. The Dreamer reads every Integration and never changes anything; neither
     * does the Run its finding wakes. Rules and review come after, and could otherwise allow it.
     */
    const before = Effect.fn('Gate.before')(function* (
      actor: Actor,
      action: ProposedAction,
      exposure: GateExposure,
      origin: ActionOrigin,
    ) {
      if (action.effect === 'read' && exposure === 'Ordinary')
        return Option.some<GateDecision>(yield* allow(audit, actor, action))
      if (!isDreamThread(origin.threadId)) return Option.none<GateDecision>()
      yield* recordRefusal(
        Refusal.cases.ActionBlocked.make({ effect: action.effect, target: action.target._tag }),
      )
      return Option.some<GateDecision>(GateDecision.cases.Blocked.make({ rule: DREAM_READS_ONLY }))
    })
    return Gate.of({
      /** Ordinary reads pass; rules come first; the rest runs unless the review says a Person is needed. */
      check: Effect.fn('Gate.check')(function* (actor, action, exposure, bound) {
        // All callers previously resolved origin before Gate.check. Keep that authority check
        // here when removing the duplicated proposal field, including actions allowed immediately.
        const origin = yield* actionOrigin(actor).pipe(Effect.provideService(Database, database))
        const early = yield* before(actor, action, exposure, origin)
        if (Option.isSome(early)) return early.value
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
          // The Gate decides Never; outward Blocked outcomes only carry this same decision.
          yield* recordRefusal(
            Refusal.cases.ActionBlocked.make({ effect: action.effect, target: action.target._tag }),
          )
          return GateDecision.cases.Blocked.make({ rule: never.action })
        }
        // An applicable Ask rule, rules that could not be weighed, and something personal
        // entering a shared Thread always ask: none of these is a judgment about the request.
        //
        // A write on the Person's own signed-in browser is deliberately NOT in this group. It
        // was, for a few hours on 4 October 2026, after a review found such writes could run
        // unasked; the owner then decided, the same day: "I don't need approval for writing my
        // browser". It follows the same table as a write through the Person's own Integration
        // (`reviewOutcome` in `policy.ts`, where the decision and its risk are recorded): Vivid
        // acts as the Person on every site they are signed in to. What still stops it is here
        // and below: a Never rule, an Ask rule, a shared Thread, a destructive effect, and the
        // Stop on the page itself.
        if (
          applicable.some((rule) => rule.decision === 'Ask') ||
          BindingJudgment.guards.Uncertain(judged) ||
          exposure === 'PersonalInShared'
        )
          return yield* ask(approvals, actor, action, bound)
        // A standing Allow and a high "asked" score never authorize outward background work.
        const background = yield* checkUnwatched(actor, action, origin, bound)
        if (Option.isSome(background)) return background.value
        // An Allow rule is the Person's standing request for an undoable action. It does not
        // settle a destructive one: applicability is a 0.5 match (`rules/judge.ts`), too loose
        // to let "Allow updating projects" authorize deleting one, so that goes to the review.
        if (action.effect !== 'destructive' && applicable.some((rule) => rule.decision === 'Allow'))
          return yield* allow(audit, actor, action)
        if (!reviewable(action)) return yield* allow(audit, actor, action)
        const review = yield* reviewer.review(actor, action)
        if (reviewOutcome(action.effect, review) === 'Ask')
          return yield* ask(approvals, actor, action, bound)
        return yield* allow(audit, actor, action)
      }),
    })
  }),
)
