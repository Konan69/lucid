import {
  ApprovalChanged,
  ApprovalDecided,
  ApprovalDecision,
  ApprovalExpired,
  DecideApprovalRequest,
  PushAsk,
  PushPayload,
  type PushAnswer,
} from '@vivid/contracts'
import { Option, Schema } from 'effect'
import type { ProductFailure } from './live.js'

/**
 * Answering an Approval away from its Thread: what the server's refusal means to the Person, and
 * the decision a button on a notification sends. The Feed and Notifications (`allowing.ts`), the
 * phone's notification buttons (`apps/mobile/src/data/notifying.ts`) and the browser's
 * (`apps/web/src/worker/main.ts`) all read it here, so a refusal says the same thing wherever the
 * Person pressed.
 *
 * It imports nothing but the contracts, so the browser's service worker can take it on its own
 * (`@vivid/state/responding`) without the session's machines and atoms.
 */

/** Why the server did not take a decision, as far as the Person needs to know. */
export const Refusal = Schema.Literals(['Changed', 'Expired', 'Decided', 'Failed'])
export type Refusal = typeof Refusal.Type

/** The refusal a failed `DecideApproval` call is, by the server's typed answer. */
export const refusalOf = (failure: ProductFailure): Refusal => {
  if (failure instanceof ApprovalChanged) return 'Changed'
  if (failure instanceof ApprovalExpired) return 'Expired'
  if (failure instanceof ApprovalDecided) return 'Decided'
  return 'Failed'
}

/** Each refusal in the Person's words: beside the card, or as a notification of its own. */
export const refusalWords: Readonly<Record<Refusal, string>> = {
  Changed: 'What this was for changed, so nothing was sent. Vivid will ask again.',
  Expired: 'This ran out, so nothing was sent.',
  Decided: 'This was already answered, so nothing changed.',
  Failed: 'That did not go through. Try again.',
}

/**
 * The decision a notification's button sends, or none when the button opens Vivid instead. A
 * draft is never allowed from its notification: only Decline answers it there, and Review opens
 * it to read and edit first (owner, 27 October 2026: "wants to send, needs a draft to send").
 */
export const requestOf = (
  ask: PushAsk,
  answer: PushAnswer,
): Option.Option<DecideApprovalRequest> => {
  if (PushAsk.guards.Nothing(ask) || answer === 'review') return Option.none()
  if (answer === 'allow' && PushAsk.guards.Draft(ask)) return Option.none()
  return Option.some(
    DecideApprovalRequest.make({
      id: ask.approvalId,
      digest: ask.digest,
      decision:
        answer === 'allow'
          ? ApprovalDecision.cases.AllowOnce.make({})
          : ApprovalDecision.cases.Deny.make({}),
    }),
  )
}

/**
 * The notice told again after its answer was refused: the same notice, opened as before, with
 * nothing left to answer from it, so the refusal's own notification carries no buttons.
 */
export const answeredOf = (payload: PushPayload): PushPayload =>
  PushPayload.make({
    notificationId: payload.notificationId,
    title: payload.title,
    body: payload.body,
    opens: payload.opens,
    sound: payload.sound,
    asks: PushAsk.cases.Nothing.make({}),
  })
