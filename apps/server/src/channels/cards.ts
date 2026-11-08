import {
  ApprovalDecision,
  ApprovalState,
  InputAnswer,
  InputRequestState,
  InvalidRequest,
  type InputQuestion,
  type InputRequest,
  type PersonId,
  type ThreadId,
} from '@vivid/contracts'
import { Array as Arr, Effect } from 'effect'
import type { DatabaseInfrastructureError } from '../database/client.ts'
import type { Actor } from '../auth/access.ts'
import { ApprovalStore, inThread as approvalsInThread } from '../approvals/store.ts'
import { approvalKey } from '../approvals/signal.ts'
import { InputStore, inThread as inputsInThread } from '../inputs/store.ts'
import { answerKey } from '../inputs/answers.ts'

/** Number options independently for each question; semicolons keep the ordered answers together. */
const questionText = (question: InputQuestion, index: number) => {
  let instruction = 'Choose one number.'
  if (question.options.length === 0) instruction = 'Type your answer.'
  else if (question.selection === 'Several')
    instruction = 'Choose one or more numbers, separated by commas.'
  return [
    `${index + 1}. ${question.question}`,
    ...question.options.map((option, choice) => `${choice + 1}) ${option.label}: ${option.detail}`),
    instruction,
    question.allowsOwnAnswer ? 'Or type your own answer.' : '',
  ]
    .filter((line) => line.length > 0)
    .join('\n')
}

/** The copied prefix identifies which request the Person is answering, without guessing from recency. */
const requestText = (request: InputRequest) =>
  [
    ...request.questions.map(questionText),
    `Reply with answer ${request.id}: followed by your answers in question order, separated by semicolons.`,
  ].join('\n\n')

/** A stable command names the same stored request even when several questions are waiting. */
export const channelCards = Effect.fn('Channels.cards')(function* (
  threadId: ThreadId,
  personId: PersonId,
) {
  const requests = yield* inputsInThread(threadId)
  const approvals = yield* approvalsInThread(threadId)
  return [
    ...requests
      .filter(
        (request) =>
          request.askedOf.id === personId && InputRequestState.guards.Waiting(request.state),
      )
      .map(requestText),
    ...approvals
      .filter(
        (approval) =>
          approval.askedOf.id === personId && ApprovalState.guards.Pending(approval.state),
      )
      .map((approval) =>
        [
          approval.action.summary,
          approval.action.rationale,
          '1) Allow once\n2) Refuse',
          `Reply with approve ${approval.id} ${approval.digest}: 1 or 2.`,
        ].join('\n\n'),
      ),
  ].join('\n\n')
})

/** Numeric choices become exact stored labels; the Input store validates count and selection rules. */
const answerFor = (
  question: InputQuestion,
  words: string,
): Effect.Effect<InputAnswer, InvalidRequest> => {
  if (question.options.length === 0 || !/^\d+(?:\s*,\s*\d+)*$/u.test(words))
    return Effect.succeed(InputAnswer.cases.Written.make({ words }))
  const choices = words.split(',').map((number) => question.options[Number(number.trim()) - 1])
  if (choices.some((choice) => choice === undefined))
    return Effect.fail(new InvalidRequest({ message: 'Choose one of the numbered options.' }))
  const labels = choices.flatMap((choice) => (choice === undefined ? [] : [choice.label]))
  return Arr.isArrayNonEmpty(labels)
    ? Effect.succeed(InputAnswer.cases.Chosen.make({ labels }))
    : Effect.fail(new InvalidRequest({ message: 'Choose one of the numbered options.' }))
}

/** The linked Person answers a named request in this private Thread through the usual guarded store. */
export const answerChannelCard = Effect.fn('Channels.answerCard')(function* (
  actor: Actor,
  threadId: ThreadId,
  text: string,
  route: (key: string) => Effect.Effect<void, DatabaseInfrastructureError>,
) {
  const answer = /^answer ([^\s:]+):\s*([\s\S]+)$/iu.exec(text)
  if (answer !== null) {
    const requests = yield* (yield* InputStore).inThread(threadId)
    const request = requests.find(
      (value) => value.id === answer[1] && value.askedOf.id === actor.person.id,
    )
    if (request === undefined)
      return yield* new InvalidRequest({ message: 'That question is not in this conversation.' })
    const words = answer[2]
    if (words === undefined)
      return yield* new InvalidRequest({ message: 'Write an answer after the colon.' })
    const parts = words.split(';').map((part) => part.trim())
    if (parts.length !== request.questions.length)
      return yield* new InvalidRequest({
        message: 'Answer every question, separated by semicolons.',
      })
    const answers = yield* Effect.forEach(Arr.zip(request.questions, parts), ([question, part]) =>
      answerFor(question, part),
    )
    if (!Arr.isArrayNonEmpty(answers))
      return yield* new InvalidRequest({ message: 'Write an answer.' })
    yield* route(answerKey(request.id))
    yield* (yield* InputStore).answer(actor, { id: request.id, answers })
    return true
  }
  const approval = /^approve ([^\s:]+) ([^\s:]+):\s*([12])\s*$/iu.exec(text)
  if (approval === null) return false
  const approvals = yield* (yield* ApprovalStore).inThread(threadId)
  const request = approvals.find(
    (value) => value.id === approval[1] && value.askedOf.id === actor.person.id,
  )
  const digest = approval[2]
  if (request === undefined || digest === undefined)
    return yield* new InvalidRequest({ message: 'That approval is not in this conversation.' })
  yield* route(approvalKey(request.id))
  yield* (yield* ApprovalStore).decide(actor, {
    id: request.id,
    digest,
    decision:
      approval[3] === '1'
        ? ApprovalDecision.cases.AllowOnce.make({})
        : ApprovalDecision.cases.Deny.make({}),
  })
  return true
})
