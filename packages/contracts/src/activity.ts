import { SendToThreadRequest } from './threads.js'
import { DecideApprovalRequest } from './approvals.js'
import { ApprovalId, ThreadId } from './identity.js'
import { Schema } from 'effect'

/** An installation's ActivityKit token is distinct from its Expo notification address. */
export const ActivityToken = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32,1024}$/u))

/**
 * The update address of the one Live Activity an installation shows. The app starts that card
 * itself, in the foreground, where it can see the token at once; the server never starts one by
 * push. T3 Code's relay arrived at the same rule after push-to-start wakes proved too unreliable
 * to hand the token back (`apps/mobile/src/features/agent-awareness/remoteRegistration.ts`
 * `refreshActiveLiveActivityRemoteRegistration`), and Vivid hit it as a stack of cards, one per
 * Run, none ever updated or ended.
 *
 * Tagged `Card`: a binary that still sends push-to-start (`Start`) or old update (`Update`)
 * registrations is refused rather than read as this one, since its card cannot draw this content.
 */
export const ActivityRegistration = Schema.TaggedStruct('Card', {
  installation: Schema.NonEmptyString,
  token: ActivityToken,
})
export type ActivityRegistration = typeof ActivityRegistration.Type

/**
 * What one Thread on the card is doing. `Working` and `Approval` are live; `Done` and `Failed`
 * are Runs that ended in the last few minutes and stay on the card so the Person sees the outcome.
 */
const ActivityPhase = Schema.Literals(['Working', 'Approval', 'Done', 'Failed'])

export const ActivityRow = Schema.Struct({
  thread: ThreadId,
  title: Schema.String,
  phase: ActivityPhase,
  /**
   * One line under the title, or none. Working: what Vivid said the step it is on is for (every
   * tool call carries a `summary`), so the card reads "Checking your calendar for next week".
   * Done or Failed: the first sentence of the reply that ended it. None while waiting on the
   * Person (the approval's own words show then), or when the server has not seen one.
   */
  line: Schema.NullOr(Schema.String),
})
export type ActivityRow = typeof ActivityRow.Type

/**
 * The card's whole content, sent on every update. Only server-observed work appears; there is no
 * step text, because the server does not know one and a card must never invent progress.
 * The native side decodes exactly this shape (`targets/controls/_shared/Attributes.swift`).
 */
export const ActivitySnapshot = Schema.Struct({
  /** Live rows first (waiting on the Person, then working), then recent outcomes; at most three. */
  rows: Schema.Array(ActivityRow),
  /** Threads Vivid is working in or waiting on. Zero means the card is ending. */
  activeCount: Schema.Int,
  updatedAt: Schema.Finite,
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
