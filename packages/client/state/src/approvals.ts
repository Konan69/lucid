import {
  ActionTarget,
  ApprovalInvalidation,
  ApprovalState,
  type ActionEffect,
  type Approval,
  type PersonId,
} from '@vivid/contracts'
import { Array as Arr, Option, Predicate, Schema } from 'effect'

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

const isText = Predicate.isString
const isTexts = Schema.is(Schema.Array(Schema.String))
const isFields = Schema.is(Schema.JsonObject)

/**
 * Which fields of an Integration action are which part of a message, by the names services give
 * them, compared case-blind. The first name an action uses wins. A message needs a recipient and
 * words; the subject and the attachments are read when there are any. `channel` is a recipient:
 * a post to a channel is sent to people as much as an email is.
 */
const NAMES = {
  to: ['to', 'recipient', 'recipients', 'recipient_email', 'to_email', 'to_address', 'channel'],
  subject: ['subject'],
  body: ['body', 'message', 'text', 'content', 'message_body', 'body_text', 'plain_text', 'html'],
  attachments: ['attachments', 'attachment', 'attachment_name', 'files', 'file', 'filename'],
} as const

/** One field of a draft: the key it is sent under, and its words as the Person edits them. */
export interface DraftField {
  readonly key: string
  readonly text: string
}

/**
 * A send read as the message it is: who it goes to, the subject, what is attached and the words.
 * `list` says the recipients were sent as a list, so edited text goes back as one; `input` is the
 * whole action input as asked, every other field of which is sent unchanged.
 */
export interface Draft {
  readonly account: string
  readonly to: DraftField & { readonly list: boolean }
  readonly subject: Option.Option<DraftField>
  readonly body: DraftField
  /** What is attached, by name; read only, as it was asked. */
  readonly attachments: ReadonlyArray<string>
  readonly input: Schema.JsonObject
}

/** The first field of `input` whose name is one of `names`, with its key as it was sent. */
const fieldNamed = (input: Schema.JsonObject, names: ReadonlyArray<string>) =>
  Arr.findFirst(Object.entries(input), ([key]) => names.includes(key.toLowerCase()))

/** The names of what is attached: words, a list of words, or files that say their own name. */
const attachedNames = (value: Schema.Json): ReadonlyArray<string> =>
  (Array.isArray(value) ? value : [value]).flatMap((each) => {
    if (isText(each)) return each === '' ? [] : [each]
    if (isFields(each)) {
      const name = Object.entries(each).find(([key]) => key === 'name' || key === 'filename')
      return name !== undefined && isText(name[1]) ? [name[1]] : []
    }
    return []
  })

/**
 * The Approval as a draft to send, when what it asks is an Integration action that sends words to
 * someone: a recipient as words or a list of words, and words to send. Anything else is decided
 * as the action it is. The owner, 27 October 2026: "wants to send, needs a draft to send".
 */
export const draftOf = (approval: Approval): Option.Option<Draft> => {
  const target = approval.action.target
  if (!ActionTarget.guards.Connection(target)) return Option.none()
  const input = target.input
  if (!isFields(input)) return Option.none()
  const to = fieldNamed(input, NAMES.to)
  const body = fieldNamed(input, NAMES.body)
  if (Option.isNone(to) || Option.isNone(body)) return Option.none()
  const [toKey, toValue] = to.value
  const [bodyKey, bodyValue] = body.value
  const list = isTexts(toValue)
  if (!(list || isText(toValue)) || !isText(bodyValue)) return Option.none()
  return Option.some({
    account: target.account,
    to: { key: toKey, list, text: list ? toValue.join(', ') : toValue },
    subject: Option.flatMap(fieldNamed(input, NAMES.subject), ([key, value]) =>
      isText(value) ? Option.some({ key, text: value }) : Option.none(),
    ),
    body: { key: bodyKey, text: bodyValue },
    attachments: Option.match(fieldNamed(input, NAMES.attachments), {
      onNone: () => [],
      onSome: ([, value]) => attachedNames(value),
    }),
    input,
  })
}

/** What the Person wrote into a draft's three fields. */
export interface DraftWords {
  readonly to: string
  readonly subject: string
  readonly body: string
}

/** The draft's own words, before anything is typed. */
export const draftWords = (draft: Draft): DraftWords => ({
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
export const editedInput = (draft: Draft, words: DraftWords): Option.Option<Schema.JsonObject> => {
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
