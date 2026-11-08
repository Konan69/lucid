import { ApprovalInvalidation, ApprovalState, type Approval, type PersonId } from '@vivid/contracts'
import { Array as Arr, Option } from 'effect'

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

/**
 * What an Approval that changed under its ask says where it was, on every surface: what changed,
 * in the Person's words, and nothing to press. When the work is still wanted, Vivid asks again with
 * a fresh one, which appears as a new ask beside it.
 */
export const changedLine = (reason: ApprovalInvalidation) =>
  ApprovalInvalidation.match(reason, {
    ContentChanged: ({ version }) =>
      version === null
        ? 'The document was removed after this was asked.'
        : 'The document changed after this was asked.',
    ConnectionChanged: ({ generation }) =>
      generation === null
        ? 'The integration was removed after this was asked.'
        : 'The integration changed after this was asked.',
    AuthorityChanged: () => 'No longer yours to answer.',
    RunStopped: () => 'Stopped before it was answered.',
    Superseded: () => 'This changed after it was asked.',
  })
