import {
  ApprovalInvalidation,
  ApprovalState,
  type ActionEffect,
  type Approval,
  type SendDraft,
  type PersonId,
} from '@vivid/contracts'
import { Array as Arr, Option, Schema } from 'effect'

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
    ExternalStateChanged: ({ source }) =>
      source === 'BrowserPage'
        ? 'The price or terms changed after you said yes.'
        : 'The mail or its conversation changed after you said yes.',
  })

/**
 * How much the action can change, in a few words beside it: Needs you and Notifications show the
 * risk with the action, where the Person decides without the Thread around it.
 */
export const riskWords = (effect: ActionEffect): string =>
  ({ read: 'Only reads', write: 'Makes a change', destructive: 'Can’t be undone' })[effect]

/** What the Person wrote into a draft's three fields. */
export interface DraftWords {
  readonly to: string
  readonly subject: string
  readonly body: string
}

/** The draft's own words, before anything is typed. */
export const draftWords = (draft: SendDraft): DraftWords => ({
  to: draft.to.text,
  subject: Option.match(draft.subject, { onNone: () => '', onSome: (field) => field.text }),
  body: draft.body.text,
})

/**
 * The input to send for a draft as the Person left it, or none when they changed nothing, so an
 * untouched draft is sent as the action that was asked (`AllowOnce`) and an edited one as
 * `AllowEdited`. Recipients sent as a list go back as a list, split at commas, semicolons and
 * spaces. Only the three fields change; every other field is sent as it was asked.
 */
export const editedInput = (
  draft: SendDraft,
  words: DraftWords,
): Option.Option<Schema.JsonObject> => {
  const asked = draftWords(draft)
  if (asked.to === words.to && asked.subject === words.subject && asked.body === words.body)
    return Option.none()
  const recipients = words.to.split(/[\s,;]+/u).filter((each) => each !== '')
  const written: ReadonlyArray<readonly [string, Schema.Json]> = [
    [draft.to.key, draft.to.list ? recipients : words.to.trim()],
    [draft.body.key, words.body],
    ...Option.toArray(Option.map(draft.subject, (field) => [field.key, words.subject] as const)),
  ]
  // Later entries win, so the three fields replace what was asked and every other field stays.
  return Option.some(Object.fromEntries([...Object.entries(draft.input), ...written]))
}
