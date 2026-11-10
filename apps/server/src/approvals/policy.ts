import { Effect, Schema } from 'effect'
import { DecisionUnavailable } from '../decisions/model.ts'
import type { ActionEffect } from '@vivid/contracts'

/** Closed fallback reasons combine the provider's typed failures with review preparation failures. */
export const UnreviewedReason = Schema.Literals([
  ...DecisionUnavailable.fields.reason.literals,
  'Unavailable',
  'ArgumentsTooLong',
  'HistoryDeadline',
  'NoRequest',
])

/**
 * The reviewer's answer about one proposed action. `Unreviewed` is the honest remainder: there
 * was no request to judge against, the arguments were too long to show whole, or the decision
 * provider failed or timed out. It is a state the policy below decides on, never a silent allow
 * or a silent refusal.
 */
export const Review = Schema.TaggedUnion({
  Reviewed: {
    /** Probability, 0 to 1, that the Person asked for this or it is a necessary step of it. */
    asked: Schema.Finite,
    /** Probability, 0 to 1, that the action reaches someone or something the request did not name. */
    beyond: Schema.Finite,
    /**
     * Probability, 0 to 1, that the action is contained: it creates or edits something only the
     * Person sees and can undo. The probability is kept, not the chosen label, because the
     * provider's label need not be its most probable one (Decision.ts `ClassifyAnswer`).
     */
    contained: Schema.Finite,
  },
  Unreviewed: {
    reason: UnreviewedReason.pipe(Schema.withConstructorDefault(Effect.succeed('Unavailable'))),
  },
})
export type Review = typeof Review.Type

/**
 * At or above this, the Person asked for the action.
 *
 * Measured with `review.live.test.ts` on `typesafe/jev-1.13`, 4 Oct 2026, twelve cases run five
 * times: actions the Person asked for scored 0.91 to 0.98 (a send, a payment, a draft that is a
 * necessary step, and "yes, go ahead" after a question); unasked ones scored 0.01 to 0.09,
 * including a request already carried out, a request with "do not send yet", and action text
 * that claimed the Person asked. 0.5 is the middle of that empty band. Twelve cases is a small
 * sample: widen the live cases before moving this.
 */
const ASKED_THRESHOLD = 0.5

/**
 * At or above this, the action reaches someone or something the request did not name, and being
 * asked for no longer lets it run. `asked` alone missed this: "Email Dami the NDA" with a hidden
 * second recipient scored asked 0.93. Same live runs: actions that matched their request scored
 * 0.09 to 0.14, the hidden recipient 0.94 to 0.95. 0.5 is the middle of that band.
 */
const BEYOND_THRESHOLD = 0.5

/**
 * At or above this, an action Vivid chose on its own is contained and runs. Same live runs:
 * a draft and a label on the Person's own mail scored 0.95 to 1.00; every send, payment and
 * delete scored 0.00 to 0.12. 0.5 is the middle of that band.
 */
const CONTAINED_THRESHOLD = 0.5

export const ReviewOutcome = Schema.Literals(['Run', 'Ask'] as const)
export type ReviewOutcome = typeof ReviewOutcome.Type

/** A background request is never a Person's authorization; only a contained write can run. */
export const unwatchedOutcome = (review: Review): ReviewOutcome =>
  Review.match(review, {
    Reviewed: ({ contained }) => (contained >= CONTAINED_THRESHOLD ? 'Run' : 'Ask'),
    Unreviewed: () => 'Ask',
  })

/**
 * Konan, 10 November 2026: "just because a tool is destructive does not mean it's a bad thing."
 * Jev's measurements decide reviewed actions, regardless of their effect label. An action the
 * Person asked for runs inside that request; an action Vivid chose runs when Jev rates it contained.
 *
 * "Why would Jev not be able to review an action and why would it skip? What if that's the action
 * that destroys my entire life" keeps the existing fallback: an unreviewed write runs, but a
 * destructive action asks. The reviewer retries a timeout or provider failure once, with the
 * same per-attempt limit. Missing requests, oversized arguments and disabled decisions remain
 * unreviewed. Never, Company and ask-first rules are enforced by the Gate before this policy.
 */
export const reviewOutcome = (effect: ActionEffect, review: Review): ReviewOutcome =>
  Review.match(review, {
    Reviewed: ({ asked, beyond, contained }) =>
      (asked >= ASKED_THRESHOLD && beyond < BEYOND_THRESHOLD) || contained >= CONTAINED_THRESHOLD
        ? 'Run'
        : 'Ask',
    Unreviewed: () => (effect === 'destructive' ? 'Ask' : 'Run'),
  })
