import * as Schema from 'effect/Schema'
import { ApprovalId, NotificationId } from './identity.js'
import { NotificationOpens } from './notifications.js'

/** Random product identity; ownership and session authority never enter provider payloads. */
export const PushTargetId = Schema.NonEmptyString.pipe(Schema.brand('PushTargetId'))
export type PushTargetId = typeof PushTargetId.Type

const publicKey = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{87}$/u))
const authKey = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{22}$/u))

/** A browser subscription and a native Expo token have different, complete credentials. */
export const PushDestination = Schema.TaggedUnion({
  Browser: {
    endpoint: Schema.String.check(Schema.isPattern(/^https:\/\/[^\s]+$/u)),
    keys: Schema.Struct({ p256dh: publicKey, auth: authKey }),
  },
  Phone: {
    token: Schema.String.check(Schema.isPattern(/^(?:Expo|Exponent)PushToken\[[A-Za-z0-9_-]+\]$/u)),
  },
})
export type PushDestination = typeof PushDestination.Type

/** Credentials are readable only by their signed-in owner, never by model tools. */
export const PushTarget = Schema.Struct({
  id: PushTargetId,
  destination: PushDestination,
  createdAt: Schema.Finite,
})
export interface PushTarget extends Schema.Schema.Type<typeof PushTarget> {}
export const RegisterPushTargetRequest = Schema.Struct({ destination: PushDestination })
export const PushTargetResponse = Schema.Struct({ target: PushTarget })
export const PushTargetListResponse = Schema.Struct({ targets: Schema.Array(PushTarget) })
export const PushKeyResponse = Schema.Struct({ publicKey })

/** A provider's acceptance is evidence of sending, never proof that the device displayed it. */
export const PushOutcome = Schema.TaggedUnion({
  Present: {},
  NoTargets: {},
  Attempted: { accepted: Schema.Finite, failed: Schema.Finite, uncertain: Schema.Finite },
})
export type PushOutcome = typeof PushOutcome.Type

/** Model input contains words only; the acting Thread and recipient come from server authority. */
const PreviewUrl = Schema.String.check(Schema.isPattern(/^https:\/\/[^\s]+$/u))

export const NotifyPersonRequest = Schema.Struct({
  previewUrl: Schema.optionalKey(PreviewUrl),
  title: Schema.NonEmptyString.check(Schema.isMaxLength(100)),
  body: Schema.NonEmptyString.check(Schema.isMaxLength(280)),
})
export const NotifyPersonOutcome = Schema.TaggedUnion({
  Created: { notificationId: NotificationId, push: PushOutcome },
})
export type NotifyPersonOutcome = typeof NotifyPersonOutcome.Type

/**
 * Whether a pushed notice makes a sound. Only what the Person is waiting on and what is urgent is
 * `Audible`; a Feed post Vivid made on its own arrives `Quiet` (Konan, 27 October 2026: "Feed posts
 * appear silently"). The server decides it from the notice's kind (`push/delivery.ts`).
 */
export const PushSound = Schema.Literals(['Audible', 'Quiet'] as const)
export type PushSound = typeof PushSound.Type

/**
 * What a Person can answer from the notification itself, without opening Vivid. The server reads
 * it from the Approval the notice is about, at the moment it pushes, so one already answered
 * elsewhere is pushed as `Nothing`.
 *
 * - `Nothing`: a notice to open, with no answer of its own.
 * - `Approval`: Allow or Decline, sent as `DecideApproval` quoting `digest`, exactly as the Feed
 *   and Notifications send it.
 * - `Draft`: a send the Person may edit first (`draftOf`), so it is never allowed blind: Review
 *   opens it, and Decline answers it where it stands.
 */
export const PushAsk = Schema.TaggedUnion({
  Nothing: {},
  Approval: { approvalId: ApprovalId, digest: Schema.String },
  Draft: { approvalId: ApprovalId, digest: Schema.String },
})
export type PushAsk = typeof PushAsk.Type

/**
 * The notification category each answerable ask is pushed under. The phone registers each with
 * its buttons at launch (`apps/mobile/src/data/notifying.ts`), and the server names it in the
 * message (`push/adapter.ts`); the browser worker reads the ask itself.
 */
export const PUSH_CATEGORY = {
  Approval: 'vivid.approval',
  Draft: 'vivid.draft',
} as const satisfies Record<Exclude<PushAsk['_tag'], 'Nothing'>, string>

/**
 * A button on an answerable notification, by the identifier the platform hands back when it is
 * pressed. `review` opens Vivid at the notice; the other two decide.
 */
export const PushAnswer = Schema.Literals(['allow', 'decline', 'review'] as const)
export type PushAnswer = typeof PushAnswer.Type

/** The same payload is used by the browser worker and the phone tap handler. */
export const PushPayload = Schema.Struct({
  notificationId: NotificationId,
  previewUrl: Schema.optionalKey(Schema.NullOr(PreviewUrl)),
  title: Schema.String,
  body: Schema.String,
  opens: NotificationOpens,
  sound: PushSound,
  asks: PushAsk,
})
export interface PushPayload extends Schema.Schema.Type<typeof PushPayload> {}
