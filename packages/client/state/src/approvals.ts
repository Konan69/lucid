import { ApprovalState, type Approval, type PersonId } from '@vivid/contracts'
import { Array as Arr, Option } from 'effect'

/** Every surface names the action's effect identically, independently of its native chip paint. */
export const APPROVAL_EFFECT_WORDS = {
  read: 'Only reads',
  write: 'Changes something',
  destructive: 'Sends, deletes or pays',
} as const satisfies Record<Approval['action']['effect'], string>

/** The Approval that is up over the composer, and how many are waiting on this Person with it. */
export interface ApprovalUp {
  readonly approval: Approval
  /** Every Approval in the Thread still waiting on this Person, the one that is up included. */
  readonly waiting: number
}

/**
 * The Approval that is up over the composer: the oldest one still pending that this Person must
 * decide. The Thread's detail lists its Approvals oldest first and one is decided at a time, so
 * the next rises once this one is settled, as a question's does (`asking.upOf`). One asked of
 * somebody else is never up here; the Thread says who it is waiting on. T3 Code shows the first
 * pending approval and "1/n" the same way (`ComposerPendingApprovalPanel.tsx`, `pendingCount`).
 */
export const approvalUp = (
  approvals: ReadonlyArray<Approval>,
  me: PersonId,
): Option.Option<ApprovalUp> => {
  const mine = approvals.filter(
    (approval) => ApprovalState.guards.Pending(approval.state) && approval.askedOf.id === me,
  )
  return Option.map(Arr.head(mine), (approval) => ({ approval, waiting: mine.length }))
}
