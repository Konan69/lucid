import { Effect, Schema } from 'effect'
import { IntegrationAnswerOutcome, IntegrationResponse } from './asks.js'
import { ProposedAction } from './approvals.js'
import {
  HandoffFieldId,
  HandoffId,
  InputRequestId,
  PersonSummary,
  RunId,
  ThreadId,
} from './identity.js'

/** One labelled choice, with the consequence of picking it in a line. */
export const InputOption = Schema.Struct({
  label: Schema.String,
  detail: Schema.String,
})
export interface InputOption extends Schema.Schema.Type<typeof InputOption> {}

/**
 * How many of a question's options one answer may hold. `One`: the Person picks a single option.
 * `Several`: they may pick any number of them, at least one.
 */
const InputSelection = Schema.Literals(['One', 'Several'])
type InputSelection = typeof InputSelection.Type

/**
 * One question inside an Input request. A request carries one or more of them, asked together
 * and answered together, so Vivid can ask what it needs in one stop instead of one turn each.
 *
 * The shape follows T3 Code's `UserInputQuestion` (`packages/contracts`, read through
 * `apps/web/src/pendingUserInput.ts`): a question, its options, whether several may be picked and
 * whether the Person may write their own answer. Its `header` is not carried: the card shows the
 * question's own words and its place ("1 of 3"), and a second, shorter title was one more line of
 * text for the Person to read.
 */
export const InputQuestion = Schema.Struct({
  question: Schema.String,
  options: Schema.Array(InputOption),
  selection: InputSelection,
  /** Whether the Person may write their own answer instead of choosing. */
  allowsOwnAnswer: Schema.Boolean,
}).annotate({ identifier: 'InputQuestion', title: 'Input question' })
export interface InputQuestion extends Schema.Schema.Type<typeof InputQuestion> {}

/**
 * What a Person said to one question: options they picked, by label, or words of their own.
 * The two are different things, not one string: a picked label is checked against the options and
 * written words are not, and a client draws them differently.
 */
export const InputAnswer = Schema.TaggedUnion({
  Chosen: { labels: Schema.NonEmptyArray(Schema.String) },
  Written: { words: Schema.String },
})
export type InputAnswer = typeof InputAnswer.Type

/**
 * Where an Input request stands. An answered one keeps who answered and what they said: one
 * answer per question, in the questions' order.
 */
export const InputRequestState = Schema.TaggedUnion({
  Waiting: {},
  Expired: { expiredAt: Schema.Finite },
  Answered: {
    answeredBy: PersonSummary,
    answers: Schema.NonEmptyArray(InputAnswer),
    answeredAt: Schema.Finite,
  },
  /** The Run that asked was stopped, or the Person moved the Thread on, before an answer. */
  Withdrawn: { withdrawnAt: Schema.Finite },
})
export type InputRequestState = typeof InputRequestState.Type

/** A durable stop where a Run asks the Person what it could not safely decide alone. */
export const InputRequest = Schema.Struct({
  id: InputRequestId,
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  questions: Schema.NonEmptyArray(InputQuestion),
  integration: Schema.NullOr(ProposedAction).pipe(
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  askedOf: PersonSummary,
  integrationOutcome: Schema.NullOr(IntegrationAnswerOutcome).pipe(
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  state: InputRequestState,
  createdAt: Schema.Finite,
}).annotate({ identifier: 'InputRequest', title: 'Input request' })
export interface InputRequest extends Schema.Schema.Type<typeof InputRequest> {}

/** The most questions one request may carry. T3 Code's and Claude Code's question tools allow four. */
export const INPUT_QUESTIONS_MOST = 4

/** One question as Vivid supplies it. */
const AskInputQuestion = Schema.Struct({
  question: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(400)),
  options: Schema.Array(InputOption).check(Schema.isMaxLength(6)),
  selection: InputSelection,
  allowsOwnAnswer: Schema.Boolean,
})
interface AskInputQuestion extends Schema.Schema.Type<typeof AskInputQuestion> {}

/** What Vivid supplies when it asks. The Thread and the Person asked come from the Run. */
export const AskInputRequest = Schema.Struct({
  questions: Schema.NonEmptyArray(AskInputQuestion).check(Schema.isMaxLength(INPUT_QUESTIONS_MOST)),
})
export interface AskInputRequest extends Schema.Schema.Type<typeof AskInputRequest> {}

/** One answer per question, in the questions' order; the server refuses any other count. */
export const AnswerInputRequest = Schema.Struct({
  id: InputRequestId,
  answers: Schema.NonEmptyArray(InputAnswer).check(Schema.isMaxLength(INPUT_QUESTIONS_MOST)),
})
export interface AnswerInputRequest extends Schema.Schema.Type<typeof AnswerInputRequest> {}

export const InputRequestResponse = Schema.Struct({ request: InputRequest })

/**
 * What only the Person can do on the Computer, so Vivid hands them that one step and carries on.
 * `SignIn`, `Code` and `Payment` may be prepared as a form; `Captcha` and `TakeControl` are done
 * on the Computer's live screen, as can any of the others when a field cannot be prepared.
 *
 * The shape follows Grok Bot's secure handoff and write-only fill
 * (`~/ref/system-prompts-mined/mined/grok-bot-skills.md`, M10): fields are found on the page
 * before the Person is asked, the Person's values are typed into them privately, and Vivid is told
 * only what happened to each field. Its CAPTCHA policy is not taken: the Person completes one.
 */
export const HandoffKind = Schema.Literals(['SignIn', 'Code', 'Captcha', 'Payment', 'TakeControl'])
export type HandoffKind = typeof HandoffKind.Type
/** The kinds a form can carry: a CAPTCHA or taking control has no field to type into. */
export const HandoffFormKind = HandoffKind.pick(['SignIn', 'Code', 'Payment'])
export type HandoffFormKind = typeof HandoffFormKind.Type

/** What a field holds, so a client can offer the right keyboard. Every value is entered unseen. */
export const HandoffFieldPurpose = Schema.Literals([
  'Text',
  'Password',
  'Code',
  'CardNumber',
  'CardExpiry',
  'CardCode',
])
export type HandoffFieldPurpose = typeof HandoffFieldPurpose.Type

/** One field Vivid found on the page: its accessible label as the page names it. */
export const HandoffField = Schema.Struct({
  id: HandoffFieldId,
  label: Schema.String,
  purpose: HandoffFieldPurpose,
})
export interface HandoffField extends Schema.Schema.Type<typeof HandoffField> {}

/**
 * Where the step is, as a Person reads it: the page's origin and its address without query or
 * fragment, which may carry a session or a reset token.
 */
export const HandoffPage = Schema.Struct({ origin: Schema.String, address: Schema.String })
export interface HandoffPage extends Schema.Schema.Type<typeof HandoffPage> {}

/**
 * Why a field was not typed into. `TargetChanged`: the page is no longer the one prepared (another
 * address, another tab), even if a field there has the same label. `TargetUnavailable`: no single
 * editable field with that label is on the page. `UnsupportedField`: the field is there but cannot
 * be typed into privately.
 */
export const HandoffRefusalReason = Schema.Literals([
  'TargetChanged',
  'TargetUnavailable',
  'UnsupportedField',
])
export type HandoffRefusalReason = typeof HandoffRefusalReason.Type

/**
 * What happened to one field's value. `Filled` is the Computer's receipt that it was typed, not
 * that the site accepted it. `OutcomeUnknown`: the typing was sent and its answer was lost, so it
 * may be in the field; it is never typed again by itself.
 */
export const HandoffFieldResult = Schema.TaggedUnion({
  Filled: {},
  Refused: { reason: HandoffRefusalReason },
  OutcomeUnknown: {},
})
export type HandoffFieldResult = typeof HandoffFieldResult.Type

/** One field's result. It never holds the value, its length or any part of it. */
export const HandoffFieldReceipt = Schema.Struct({
  fieldId: HandoffFieldId,
  result: HandoffFieldResult,
})
export interface HandoffFieldReceipt extends Schema.Schema.Type<typeof HandoffFieldReceipt> {}

/** Who finished the step and when; the step is over and Vivid has been told. */
const completed = { completedBy: PersonSummary, completedAt: Schema.Finite }

/**
 * Where a form stands. `Applying`: a fill is being typed now, so a second one is refused.
 * `Ready`: at least one fill was typed, and the Person finishes on the live screen. A field that
 * was refused may be filled again from `Ready`; its latest result is the one kept.
 */
export const HandoffFormState = Schema.TaggedUnion({
  Waiting: {},
  Applying: {},
  Ready: { fields: Schema.NonEmptyArray(HandoffFieldReceipt) },
  Completed: { ...completed, fields: Schema.NonEmptyArray(HandoffFieldReceipt) },
  /** The Person withdrew it, or wrote to Vivid instead, before finishing. */
  Withdrawn: { withdrawnAt: Schema.Finite },
})
export type HandoffFormState = typeof HandoffFormState.Type

/** Where a live-screen step stands. `Ready`: the Person has taken the screen. */
export const HandoffScreenState = Schema.TaggedUnion({
  Waiting: {},
  Ready: {},
  Completed: completed,
  Withdrawn: { withdrawnAt: Schema.Finite },
})
export type HandoffScreenState = typeof HandoffScreenState.Type

const handoffIdentity = {
  id: HandoffId,
  threadId: ThreadId,
  /** The Run that prepared it. The work continues in the Thread, not necessarily in this Run. */
  runId: RunId,
  /** Only this Person may enter values or finish it, on their own Computer. */
  askedOf: PersonSummary,
  page: HandoffPage,
  /** Vivid's sentence for the step, as the Person reads it. */
  summary: Schema.String,
  createdAt: Schema.Finite,
}

/**
 * One step on the Computer only the Person can do. An Input request in product words, kept apart
 * from questions because its values are secrets: an answer is stored and read back to Vivid, and a
 * handoff's values never are. A form carries the fields found on the page; a live-screen step has
 * none, and neither can carry the other's state.
 */
export const HandoffRequest = Schema.TaggedUnion({
  Form: {
    ...handoffIdentity,
    kind: HandoffFormKind,
    fields: Schema.NonEmptyArray(HandoffField),
    state: HandoffFormState,
  },
  Screen: { ...handoffIdentity, kind: HandoffKind, state: HandoffScreenState },
})
export type HandoffRequest = typeof HandoffRequest.Type

/** The most fields one form may carry: a sign-in, a code or a card fits in five. */
export const HANDOFF_FIELDS_MOST = 6

/** A field as Vivid asks for it: the label it read on the page and what it holds. */
const PrepareHandoffField = Schema.Struct({
  label: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
  purpose: HandoffFieldPurpose,
})
interface PrepareHandoffField extends Schema.Schema.Type<typeof PrepareHandoffField> {}

const prepareSummary = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(400))

/**
 * What Vivid supplies to hand a step over. The page is the one its Computer shows now; the
 * Thread, Run and Person asked come from the Run.
 */
export const PrepareHandoffRequest = Schema.TaggedUnion({
  Form: {
    kind: HandoffFormKind,
    summary: prepareSummary,
    fields: Schema.NonEmptyArray(PrepareHandoffField).check(
      Schema.isMaxLength(HANDOFF_FIELDS_MOST),
    ),
  },
  Screen: { kind: HandoffKind, summary: prepareSummary },
})
export type PrepareHandoffRequest = typeof PrepareHandoffRequest.Type

/** A field Vivid named that could not be prepared, with why. */
const HandoffFieldRefusal = Schema.Struct({
  label: Schema.String,
  reason: HandoffRefusalReason,
})
interface HandoffFieldRefusal extends Schema.Schema.Type<typeof HandoffFieldRefusal> {}

/**
 * What Vivid hears back when it hands a step over. Every refusal is an answer it can act on:
 * fields that cannot be prepared are handed over on the live screen instead.
 */
export const PrepareHandoffOutcome = Schema.TaggedUnion({
  Prepared: { handoff: HandoffRequest },
  FieldsRefused: { fields: Schema.NonEmptyArray(HandoffFieldRefusal) },
  /** A step is handed over only from a Run working in its Thread. */
  RunRequired: {},
  /** One step at a time is handed over on a Computer; this one already waits on the Person. */
  Busy: {},
  Unavailable: { reason: Schema.String },
})
export type PrepareHandoffOutcome = typeof PrepareHandoffOutcome.Type

/** Begin, finish or withdraw one handoff. */
export const HandoffIdRequest = Schema.Struct({ id: HandoffId })
export interface HandoffIdRequest extends Schema.Schema.Type<typeof HandoffIdRequest> {}

/**
 * One value the Person typed. Redacted in every process; encoded only on the way to the server and
 * from there to the Computer's browser, and never stored.
 */
export const HandoffValue = Schema.Struct({
  fieldId: HandoffFieldId,
  value: Schema.RedactedFromValue(Schema.String.check(Schema.isMaxLength(4096))),
})
export interface HandoffValue extends Schema.Schema.Type<typeof HandoffValue> {}

/** Values for some or all of a form's fields, each field at most once. */
export const FillHandoffRequest = Schema.Struct({
  id: HandoffId,
  values: Schema.NonEmptyArray(HandoffValue).check(Schema.isMaxLength(HANDOFF_FIELDS_MOST)),
})
export interface FillHandoffRequest extends Schema.Schema.Type<typeof FillHandoffRequest> {}

export const HandoffResponse = Schema.Struct({ handoff: HandoffRequest })

/** Typed answers to an existing Integration Input request use its saved schema and continuation. */
export const AnswerIntegrationInputRequest = Schema.Struct({
  id: InputRequestId,
  response: IntegrationResponse,
})
export type AnswerIntegrationInputRequest = typeof AnswerIntegrationInputRequest.Type
export const AnswerIntegrationInputResponse = Schema.Struct({
  request: InputRequest,
  outcome: IntegrationAnswerOutcome,
})

export type AnswerIntegrationInputResponse = typeof AnswerIntegrationInputResponse.Type
