import * as Schema from 'effect/Schema'

/** A late Expo receipt distinguishes transport acceptance from FCM/APNs rejection. */
export const PushAcceptance = Schema.TaggedUnion({
  Browser: {},
  Phone: { ticket: Schema.NonEmptyString, confirmed: Schema.Boolean },
})
export type PushAcceptance = typeof PushAcceptance.Type

/** Closed send outcomes keep uncertain writes distinct from definite provider refusals. */
export const PushReceipt = Schema.TaggedUnion({
  Queued: {},
  Sent: { acceptance: PushAcceptance },
  Failed: {
    reason: Schema.Literals([
      'Gone',
      'Rejected',
      'Uncertain',
      'SessionEnded',
      'AccessLost',
      'Present',
    ]),
  },
})
export type PushReceipt = typeof PushReceipt.Type

export class PushTargetGone extends Schema.TaggedError<PushTargetGone>()(
  'PushTargetGone',
  {},
  { title: 'Push destination no longer registered' },
) {}
export class PushRejected extends Schema.TaggedError<PushRejected>()(
  'PushRejected',
  {},
  { title: 'Push service rejected the notification' },
) {}
export class PushUncertain extends Schema.TaggedError<PushUncertain>()(
  'PushUncertain',
  {},
  { title: 'Push delivery may have occurred' },
) {}
export type PushSendError = PushTargetGone | PushRejected | PushUncertain
