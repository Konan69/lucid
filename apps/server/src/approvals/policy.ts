import { Schema } from 'effect'
import type { ActionEffect } from '@vivid/contracts'

/**
 * What an action does outside Vivid if it runs, as the reviewer classifies it.
 *
 * - `contained`: creates or edits something only the Person sees and can undo.
 * - `reaches`: reaches other people, speaks in the Person's name, or spends money.
 * - `irreversible`: deletes or changes something that cannot be restored.
 */
export const Consequence = Schema.Literals(['contained', 'reaches', 'irreversible'] as const)
export type Consequence = typeof Consequence.Type

/**
 * The reviewer's answer about one proposed action. `Unreviewed` is the honest remainder: the
 * Person's request could not be read, or the decision provider failed or timed out. It is a state
 * the policy below decides on, never a silent allow or a silent refusal.
 */
export const Review = Schema.TaggedUnion({
  Reviewed: {
    /** Probability, 0 to 1, that the Person asked for this or it is a necessary step of it. */
    asked: Schema.Number,
    consequence: Consequence,
  },
  Unreviewed: {},
})
export type Review = typeof Review.Type

/**
 * At or above this, the Person asked for the action and it runs.
 *
 * Measured with `review.live.test.ts` on `typesafe/jev-1.13`, three runs of seven cases on
 * 4 Oct 2026: actions the Person asked for scored 0.88 to 0.97 (a send, a payment, and a draft
 * that is a necessary step of a reply); unasked ones scored 0.02 to 0.07, including one whose
 * rationale falsely claimed the Person asked. 0.5 sits in the middle of that empty band, so a
 * paraphrased request still runs and an unasked action is far below it. Seven cases is a small
 * sample: widen the live cases before moving this.
 */
export const ASKED_THRESHOLD = 0.5

export const ReviewOutcome = Schema.Literals(['Run', 'Ask'] as const)
export type ReviewOutcome = typeof ReviewOutcome.Type

/**
 * The server's policy over a review. The model supplies two measurements; it never authorizes.
 *
 * Default is to run (Konan, 4 Oct 2026: "when i tell it to do something i expect it to do it";
 * "the agent should ask if it needs to"):
 * - An action the Person asked for runs, including a send, a payment or a delete: the request is
 *   the authorization, and asking again is the babysitting this replaces.
 * - An action Vivid chose on its own runs when it is contained, and asks when it reaches other
 *   people, spends money or cannot be undone. A `destructive` effect is the source's own fact
 *   (HTTP method, declared hint) and outranks a `contained` classification.
 * - Unreviewed: a `write` runs, because the contract defines it as something the Person can undo
 *   and blocking it would stop work on a provider outage. A `destructive` action asks, because a
 *   send, payment or delete that nobody confirmed was asked for is the one case where a question
 *   costs less than the mistake. docs/22 said every failed review asks; this is narrower.
 */
export const reviewOutcome = (effect: ActionEffect, review: Review): ReviewOutcome =>
  Review.match(review, {
    Reviewed: ({ asked, consequence }) =>
      asked >= ASKED_THRESHOLD || (effect !== 'destructive' && consequence === 'contained')
        ? 'Run'
        : 'Ask',
    Unreviewed: () => (effect === 'destructive' ? 'Ask' : 'Run'),
  })
