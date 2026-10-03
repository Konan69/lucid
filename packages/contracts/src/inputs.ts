import { Schema } from 'effect'
import { InputRequestId, PersonSummary, RunId, ThreadId } from './identity.js'

/** One labelled choice, with the consequence of picking it in a line. */
export const InputOption = Schema.Struct({
  label: Schema.String,
  detail: Schema.String,
})
export interface InputOption extends Schema.Schema.Type<typeof InputOption> {}

/** Where an Input request stands. An answered one keeps who answered and what they said. */
export const InputRequestState = Schema.TaggedUnion({
  Waiting: {},
  Answered: { answeredBy: PersonSummary, answer: Schema.String, answeredAt: Schema.Number },
  /** The Run that asked was stopped, or the Person moved the Thread on, before an answer. */
  Withdrawn: { withdrawnAt: Schema.Number },
})
export type InputRequestState = typeof InputRequestState.Type

/** A durable question that a Run could not safely answer alone. */
export const InputRequest = Schema.Struct({
  id: InputRequestId,
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  question: Schema.String,
  options: Schema.Array(InputOption),
  /** Whether the Person may write their own answer instead of choosing one. */
  allowsOwnAnswer: Schema.Boolean,
  askedOf: PersonSummary,
  state: InputRequestState,
  createdAt: Schema.Number,
}).annotate({ identifier: 'InputRequest', title: 'Input request' })
export interface InputRequest extends Schema.Schema.Type<typeof InputRequest> {}

/** What Vivid supplies when it asks. The Thread and the Person asked come from the Run. */
export const AskInputRequest = Schema.Struct({
  question: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(400)),
  options: Schema.Array(InputOption).check(Schema.isMaxLength(4)),
  allowsOwnAnswer: Schema.Boolean,
})
export interface AskInputRequest extends Schema.Schema.Type<typeof AskInputRequest> {}

export const AnswerInputRequest = Schema.Struct({
  id: InputRequestId,
  answer: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4000)),
})
export interface AnswerInputRequest extends Schema.Schema.Type<typeof AnswerInputRequest> {}

export const InputRequestResponse = Schema.Struct({ request: InputRequest })
export const InputRequestListResponse = Schema.Struct({ requests: Schema.Array(InputRequest) })

/** What a Thread shows in place of a tool result while a question is open. */
export const InputRequestMessage = Schema.Struct({
  kind: Schema.Literal('input-request'),
  requestId: InputRequestId,
  question: Schema.String,
}).annotate({ identifier: 'InputRequestMessage', title: 'Input request message' })
export interface InputRequestMessage extends Schema.Schema.Type<typeof InputRequestMessage> {}
