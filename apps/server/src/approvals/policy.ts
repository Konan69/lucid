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
 * The reviewer's answer about one proposed action. `Unreviewed` is the honest remainder: there
 * was no request to judge against, the arguments were too long to show whole, or the decision
 * provider failed or timed out. It is a state the policy below decides on, never a silent allow
 * or a silent refusal.
 */
export const Review = Schema.TaggedUnion({
  Reviewed: {
    /** Probability, 0 to 1, that the Person asked for this or it is a necessary step of it. */
    asked: Schema.Number,
    /** Probability, 0 to 1, that the action reaches someone or something the request did not name. */
    beyond: Schema.Number,
    consequence: Consequence,
  },
  Unreviewed: {},
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
export const ASKED_THRESHOLD = 0.5

/**
 * At or above this, the action reaches someone or something the request did not name, and being
 * asked for no longer lets it run. `asked` alone missed this: "Email Dami the NDA" with a hidden
 * second recipient scored asked 0.93. Same live runs: actions that matched their request scored
 * 0.09 to 0.14, the hidden recipient 0.94 to 0.95. 0.5 is the middle of that band.
 */
export const BEYOND_THRESHOLD = 0.5

export const ReviewOutcome = Schema.Literals(['Run', 'Ask'] as const)
export type ReviewOutcome = typeof ReviewOutcome.Type

/**
 * The server's policy over a review. The model supplies three measurements; it never authorizes.
 *
 * Default is to run (Konan, 4 Oct 2026: "when i tell it to do something i expect it to do it";
 * "the agent should ask if it needs to"):
 * - An action the Person asked for runs, including a send, a payment or a delete: the request is
 *   the authorization, and asking again is the babysitting this replaces. It must stay inside
 *   the request: one that also reaches a recipient or account the Person did not name asks.
 * - An action Vivid chose on its own runs when it is contained, and asks when it reaches other
 *   people, spends money or cannot be undone. A `destructive` effect is the source's own fact
 *   (HTTP method, declared hint) and outranks a `contained` classification.
 * - Unreviewed asks. An earlier version let an unreviewed `write` run because the contract calls
 *   a write undoable, but the label does not prove that: a tool whose source declares nothing
 *   defaults to `write` (`connections/executor.ts`), and `connections/effects.ts` files a send
 *   or a post under `write`. With the provider down or unconfigured, an unasked email would have
 *   run with nobody looking. A question during an outage costs less than that.
 */
export const reviewOutcome = (effect: ActionEffect, review: Review): ReviewOutcome =>
  Review.match(review, {
    Reviewed: ({ asked, beyond, consequence }) =>
      (asked >= ASKED_THRESHOLD && beyond < BEYOND_THRESHOLD) ||
      (effect !== 'destructive' && consequence === 'contained')
        ? 'Run'
        : 'Ask',
    Unreviewed: () => 'Ask',
  })
