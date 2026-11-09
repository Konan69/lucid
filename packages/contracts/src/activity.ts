import { SendToThreadRequest } from './threads.js'
import { DecideApprovalRequest } from './approvals.js'
import { ApprovalId } from './identity.js'
import { Schema } from 'effect'

/** An installation's ActivityKit token is distinct from its Expo notification address. */
export const ActivityToken = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32,1024}$/u))
export const ActivityRegistration = Schema.TaggedUnion({
  Start: { installation: Schema.NonEmptyString, token: ActivityToken },
  Update: { installation: Schema.NonEmptyString, token: ActivityToken },
})
export type ActivityRegistration = typeof ActivityRegistration.Type

/** Only server-observed work appears here; a timer never implies invented progress. */
export const ActivitySnapshot = Schema.Struct({
  title: Schema.String,
  status: Schema.String,
  activeCount: Schema.Int,
  updatedAt: Schema.Finite,
  startedAt: Schema.NullOr(Schema.Finite),
  approval: Schema.NullOr(
    Schema.Struct({
      id: ApprovalId,
      digest: Schema.String,
      summary: Schema.String,
      review: Schema.Boolean,
    }),
  ),
})
export type ActivitySnapshot = typeof ActivitySnapshot.Type

/** Native actions retain the full approval digest and reply idempotency key. */
export const ActivityAction = Schema.TaggedUnion({
  Reply: { request: SendToThreadRequest },
  Approval: { request: DecideApprovalRequest },
})

/** Registration cannot succeed while the server has no ActivityKit sending authority. */
export class ActivityUnavailable extends Schema.TaggedError<ActivityUnavailable>()(
  'ActivityUnavailable',
  {},
  { title: 'Live Activities unavailable' },
) {}
