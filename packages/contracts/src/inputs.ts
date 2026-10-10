import { Schema } from 'effect'
import { InputRequestId, PersonSummary, RunId, ThreadId } from './identity.js'

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
export const InputSelection = Schema.Literals(['One', 'Several'])
export type InputSelection = typeof InputSelection.Type

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
  askedOf: PersonSummary,
  state: InputRequestState,
  createdAt: Schema.Finite,
}).annotate({ identifier: 'InputRequest', title: 'Input request' })
export interface InputRequest extends Schema.Schema.Type<typeof InputRequest> {}

/** The most questions one request may carry. T3 Code's and Claude Code's question tools allow four. */
export const INPUT_QUESTIONS_MOST = 4

/** One question as Vivid supplies it. */
export const AskInputQuestion = Schema.Struct({
  question: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(400)),
  options: Schema.Array(InputOption).check(Schema.isMaxLength(6)),
  selection: InputSelection,
  allowsOwnAnswer: Schema.Boolean,
})
export interface AskInputQuestion extends Schema.Schema.Type<typeof AskInputQuestion> {}

/** What Vivid supplies when it asks. The Thread and the Person asked come from the Run. */
export const AskInputRequest = Schema.Struct({
  questions: Schema.NonEmptyArray(AskInputQuestion).check(
    Schema.isMaxLength(INPUT_QUESTIONS_MOST),
  ),
})
export interface AskInputRequest extends Schema.Schema.Type<typeof AskInputRequest> {}

/** One answer per question, in the questions' order; the server refuses any other count. */
export const AnswerInputRequest = Schema.Struct({
  id: InputRequestId,
  answers: Schema.NonEmptyArray(InputAnswer).check(Schema.isMaxLength(INPUT_QUESTIONS_MOST)),
})
export interface AnswerInputRequest extends Schema.Schema.Type<typeof AnswerInputRequest> {}

export const InputRequestResponse = Schema.Struct({ request: InputRequest })
export const InputRequestListResponse = Schema.Struct({ requests: Schema.Array(InputRequest) })

/** What a Thread shows in place of a tool result while a request is open: the questions' words. */
export const InputRequestMessage = Schema.Struct({
  kind: Schema.Literal('input-request'),
  requestId: InputRequestId,
  questions: Schema.NonEmptyArray(Schema.String),
}).annotate({ identifier: 'InputRequestMessage', title: 'Input request message' })
export interface InputRequestMessage extends Schema.Schema.Type<typeof InputRequestMessage> {}
