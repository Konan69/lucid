import * as Arr from 'effect/Array'
import * as Effect from 'effect/Effect'
import { InputAnswer, type AnswerInputRequest, type InputQuestion } from '@vivid/contracts'
import {
  InputAnswerCountMismatch,
  InputAnswerEmptyWords,
  InputAnswerRepeatedLabel,
  InputAnswerSeveralForbidden,
  InputAnswerUnknownLabel,
  InputAnswerWrittenForbidden,
  type InputAnswerFailure,
} from '@vivid/contracts/rpc'

/** Validate choices independently of free-answer permission; that permission never admits invented labels. */
const chosen = Effect.fn('Inputs.validateChosen')(function* (
  question: InputQuestion,
  labels: readonly [string, ...string[]],
  context: { readonly id: AnswerInputRequest['id']; readonly questionIndex: number },
) {
  if (labels.some((label) => !question.options.some((option) => option.label === label)))
    return yield* new InputAnswerUnknownLabel({
      ...context,
      message: 'Choose only options offered for this question.',
    })
  if (new Set(labels).size !== labels.length)
    return yield* new InputAnswerRepeatedLabel({
      ...context,
      message: 'Choose each option only once.',
    })
  if (question.selection === 'One' && labels.length > 1)
    return yield* new InputAnswerSeveralForbidden({
      ...context,
      message: 'Choose one option for this question.',
    })
  return labels.join(', ')
})

/** Reject whitespace-only words, retaining every character of an otherwise valid written answer. */
const written = Effect.fn('Inputs.validateWritten')(function* (
  question: InputQuestion,
  words: string,
  context: { readonly id: AnswerInputRequest['id']; readonly questionIndex: number },
) {
  if (!question.allowsOwnAnswer)
    return yield* new InputAnswerWrittenForbidden({
      ...context,
      message: 'Choose an offered option for this question.',
    })
  if (words.trim().length === 0)
    return yield* new InputAnswerEmptyWords({
      ...context,
      message: 'Write an answer for this question.',
    })
  return words
})

/**
 * Count first, then validate every ordered pair before the store may write. Each answer carries
 * the question it answers, without ids or positions: an answer can reach Vivid in the middle of
 * other work, or after other questions, so it must say what it answers. Codex does the same with
 * `AnsweredQuestion` (`codex-rs/context-fragments/src/answered_question.rs`, openai/codex
 * b5115cdd), whose plain form quotes the question with `> `; the runtime escapes `>` inside a signal
 * (it reached the model as `&gt;`), so each pair is two labelled lines instead, the question kept
 * to one line. The complete text is persisted in the owed signal, so replay cannot change it.
 */
export const answerText = Effect.fn('Inputs.answerText')(function* (
  questions: readonly [InputQuestion, ...InputQuestion[]],
  request: AnswerInputRequest,
) {
  if (questions.length !== request.answers.length)
    return yield* new InputAnswerCountMismatch({
      id: request.id,
      expected: questions.length,
      received: request.answers.length,
      message: 'Every question needs one answer.',
    })
  const lines = yield* Effect.forEach(
    Arr.zip(questions, request.answers),
    ([question, answer], questionIndex): Effect.Effect<string, InputAnswerFailure> =>
      InputAnswer.match(answer, {
        Chosen: ({ labels }) => chosen(question, labels, { id: request.id, questionIndex }),
        Written: ({ words }) => written(question, words, { id: request.id, questionIndex }),
      }).pipe(
        Effect.map(
          (text) => `Question: ${question.question.replace(/[\r\n]+/gu, ' ')}\nAnswer: ${text}`,
        ),
      ),
  )
  return lines.join('\n\n')
})
