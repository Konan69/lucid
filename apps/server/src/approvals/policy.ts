import { Schema } from 'effect'
import type { ActionEffect } from '@vivid/contracts'

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

/**
 * At or above this, an action Vivid chose on its own is contained and runs. Same live runs:
 * a draft and a label on the Person's own mail scored 0.95 to 1.00; every send, payment and
 * delete scored 0.00 to 0.12. 0.5 is the middle of that band.
 */
export const CONTAINED_THRESHOLD = 0.5

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
 * - Unreviewed: a `write` runs and a `destructive` action asks. DECIDED BY KONAN, 4 Oct 2026:
 *   "an unreviewd always asked is bad"; decisions can be switched off (`VIVID_DECISIONS`,
 *   `decisions/model.ts`) and Vivid must then still do what it is told without an Approval for
 *   every write. The risk was stated to him and accepted: the `write` label does not prove an
 *   action can be undone (a tool whose source declares nothing defaults to `write`, and
 *   `connections/effects.ts` files a send under `write`), so with no review an unasked send on a
 *   Person's own Integration runs. Do not change this back to "always ask" without his say-so.
 *   The Person's own signed-in browser follows the same table as their own Integrations.
 *   DECIDED BY KONAN, 4 Oct 2026: "I don't need approval for writing my browser". A write there
 *   is reviewed when decisions are on and runs when no review was made; a destructive action,
 *   a Never or Ask rule, and a personal target in a shared Thread still ask or refuse.
 *   Rules and a personal Integration used in a shared Thread are decided in `gate.ts` before
 *   any review. With decisions switched off no rule can be judged, so a Person who has a Never
 *   or Ask rule is asked about every action that is not a read, and a Never rule asks where it
 *   would have refused; a Person with no rule, or only Allow rules, is not asked.
 */
export const reviewOutcome = (effect: ActionEffect, review: Review): ReviewOutcome =>
  Review.match(review, {
    Reviewed: ({ asked, beyond, contained }) =>
      (asked >= ASKED_THRESHOLD && beyond < BEYOND_THRESHOLD) ||
      (effect !== 'destructive' && contained >= CONTAINED_THRESHOLD)
        ? 'Run'
        : 'Ask',
    Unreviewed: () => (effect === 'destructive' ? 'Ask' : 'Run'),
  })
