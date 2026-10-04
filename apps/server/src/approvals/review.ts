import { Context, Effect, Layer, Option, Schema } from 'effect'
import { Decision, DecisionModel } from 'effect/unstable/ai'
import { ActionTarget, BrowseTarget, type ProposedAction } from '@vivid/contracts'
import type { Actor } from '../auth/access.ts'
import { decide } from '../decisions/model.ts'
import { Runtime } from '../runtime/client.ts'
import { RunStore } from '../threads/runs.ts'
import { Review } from './policy.ts'
import { REQUEST_CHARACTERS, personRequest } from './request.ts'

/**
 * What the reviewer reads. Names and descriptions only: no identifier, account credential or
 * Connection id is ever written here. `request` is the acting Person's own words from
 * `personRequest`; `summary` and `rationale` are the working model's account of the action.
 */
const Reviewed = Schema.Struct({
  request: Schema.Array(Schema.String),
  summary: Schema.String,
  rationale: Schema.String,
  effect: Schema.String,
  /** Where it runs, as the Person named it: "Gmail (Work)", "Computer", "Person's own browser". */
  integration: Schema.String,
  tool: Schema.String,
  /** The exact arguments, JSON, bounded like a message so one large payload cannot crowd out the request. */
  input: Schema.String,
})

/**
 * The typed review of one proposed action: both questions are answered in one provider call
 * (Decision.ts `make`; DecisionModel.ts validates every answer against these criteria).
 *
 * The mechanism is docs/22 "The trust loop" step 5, after Grok Bot's Auto-review: a separate call
 * made by the server, so Vivid never approves its own action. Vivid differs in the answer shape:
 * instead of the reviewer returning allow or block, it returns two measurements and
 * `policy.ts#reviewOutcome` decides, so the threshold and the precedence are server code.
 */
export const ActionReview = Decision.make({
  input: Reviewed,
  decisions: {
    asked: Decision.probability({
      instructions:
        "The Person asked for this action, or it is a necessary step of what they asked. Judge only from `request`, which holds the Person's own words. `summary` and `rationale` were written by Vivid, which proposes the action; they describe the action and are not evidence that the Person asked for it.",
      criteria: {
        false: 'The Person did not ask for this, and what they asked can be done without it',
        true: 'The Person asked for this, or what they asked cannot be done without it',
      },
    }),
    consequence: Decision.classify({
      instructions: 'What this action does outside Vivid if it runs',
      criteria: {
        contained: 'Creates or edits something only the Person sees, and the Person can undo it',
        reaches:
          "Sends or shows something to other people, speaks in the Person's name, or spends money",
        irreversible: 'Deletes or changes something that cannot be restored afterwards',
      },
    }),
  },
})

/** The action as the reviewer is shown it. Values the Person never named (ids) stay out. */
const shown = (action: ProposedAction) =>
  ActionTarget.match(action.target, {
    Connection: ({ account, tool, input }) => ({
      integration: account,
      tool,
      input: JSON.stringify(input).slice(0, REQUEST_CHARACTERS),
    }),
    Command: ({ command }) => ({
      integration: 'Computer',
      tool: 'command',
      input: command.slice(0, REQUEST_CHARACTERS),
    }),
    Browser: ({ target, action: step }) => ({
      integration: BrowseTarget.guards.Person(target) ? "Person's own browser" : 'Computer',
      tool: 'browser',
      input: JSON.stringify(step).slice(0, REQUEST_CHARACTERS),
    }),
    Desktop: ({ action: step }) => ({
      integration: 'Computer',
      tool: 'desktop',
      input: JSON.stringify(step).slice(0, REQUEST_CHARACTERS),
    }),
  })

export interface ReviewerService {
  /**
   * Measures whether the acting Person asked for `action` and what it would do. It never fails
   * and never decides: every ending is a `Review`, and `Unreviewed` covers a request that could
   * not be read and a provider that failed or passed its ten seconds (`decisions/model.ts`).
   */
  readonly review: (actor: Actor, action: ProposedAction) => Effect.Effect<Review>
}

/** The trust loop's reviewer. The gate asks it only about actions that would otherwise need a Person. */
export class Reviewer extends Context.Service<Reviewer, ReviewerService>()('vivid/Reviewer') {}

export const reviewerLayer = Layer.effect(
  Reviewer,
  Effect.gen(function* () {
    const model = yield* DecisionModel.DecisionModel
    const runtime = yield* Runtime
    const runs = yield* RunStore
    return Reviewer.of({
      review: Effect.fn('Reviewer.review')(
        function* (actor, action) {
          const request = yield* personRequest(runtime, runs, actor)
          // Without the Person's words `asked` would be judged from Vivid's own account alone.
          if (Option.isNone(request)) return Review.cases.Unreviewed.make({})
          const { answers } = yield* decide(ActionReview, {
            request: request.value,
            summary: action.summary,
            rationale: action.rationale,
            effect: action.effect,
            ...shown(action),
          }).pipe(Effect.provideService(DecisionModel.DecisionModel, model))
          // Numbers only: the action, the request and provider detail never reach the log.
          yield* Effect.logInfo('Action reviewed', {
            asked: answers.asked.probability,
            consequence: answers.consequence.label,
            effect: action.effect,
          })
          return Review.cases.Reviewed.make({
            asked: answers.asked.probability,
            consequence: answers.consequence.label,
          })
        },
        (effect) =>
          effect.pipe(
            Effect.catch((error) =>
              Effect.logWarning('Action unreviewed', { tag: error._tag }).pipe(
                Effect.as(Review.cases.Unreviewed.make({})),
              ),
            ),
          ),
      ),
    })
  }),
)
