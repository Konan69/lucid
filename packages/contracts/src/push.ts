import * as Schema from 'effect/Schema'
import { NotificationId } from './identity.js'
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
export const NotifyPersonRequest = Schema.Struct({
  title: Schema.NonEmptyString.check(Schema.isMaxLength(100)),
  body: Schema.NonEmptyString.check(Schema.isMaxLength(280)),
})
export const NotifyPersonOutcome = Schema.TaggedUnion({
  Disabled: {},
  Created: { notificationId: NotificationId, push: PushOutcome },
})
export type NotifyPersonOutcome = typeof NotifyPersonOutcome.Type

/** The same payload is used by the browser worker and the phone tap handler. */
export const PushPayload = Schema.Struct({
  notificationId: NotificationId,
  title: Schema.String,
  body: Schema.String,
  opens: NotificationOpens,
})
export interface PushPayload extends Schema.Schema.Type<typeof PushPayload> {}
