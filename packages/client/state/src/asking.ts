import { InputAnswer, type InputQuestion } from '@vivid/contracts'
import type { InputAnswerFailure } from '@vivid/contracts/rpc'
import { Array as Arr, Data, Match, Option } from 'effect'

/**
 * Answering a request from Vivid that carries several questions, as every client does it: one
 * question at a time, a draft kept for each, and all the answers sent together at the end.
 * Nothing here draws or sends; the phone's card (`apps/mobile/src/screen/chat/Choices.tsx`) and
 * the web's (`apps/web/src/screen/thread/Question.tsx`) are both this, told different things.
 *
 * Ported from T3 Code `apps/web/src/pendingUserInput.ts`: a draft per question
 * (`PendingUserInputDraftAnswer`), what a draft resolves to (`resolvePendingUserInputAnswer`),
 * toggling a pick (`togglePendingUserInputOptionSelection`), writing words
 * (`setPendingUserInputCustomAnswer`), the full set of answers (`buildPendingUserInputAnswers`)
 * and where the Person is in the questions (`derivePendingUserInputProgress`).
 *
 * Adaptations, and why:
 * - A draft is one of three things (`Draft`), not a bag of an optional list and an optional
 *   string. The reference keeps both and lets non-empty words outrank picks when it resolves;
 *   here picking replaces words and writing replaces picks at the moment it happens, so a draft
 *   never holds two answers and nothing has to say which one counts.
 * - An answer is the contract's `InputAnswer` (`Chosen` labels or `Written` words), not a string
 *   or a list of strings: the server checks the two differently and a client draws them
 *   differently.
 * - Questions are told apart by their place, not by an id: the contract's questions have none,
 *   and its answers are "one per question, in the questions' order". Drafts are a list in that
 *   order.
 * - The reference's attachments on an answer and its pre-filled answer (`initialAnswer`) are
 *   things Vivid's questions do not have, and are not here. Nor is moving displaced words back
 *   into the composer (`carryDisplacedCustomAnswerIntoPrompt`): that belongs to the reference's
 *   composer, which doubles as the answer field.
 * - Where the Person is (`at`) is kept with the drafts as one value (`Asking`) and moved by
 *   functions here (`advance`, `back`, `returnTo`); the reference keeps the index in each
 *   component. Both of Vivid's clients need the same moves, and a refusal has to be able to put
 *   either of them back on the question it names.
 */

/**
 * How long a question answered by a single press stays on screen, with the pressed option
 * marked, before the next question takes its place: T3 Code's auto-advance
 * (`ComposerPendingUserInputPanel.tsx`, 200 ms). Long enough to see what was pressed.
 */
export const ADVANCE_AFTER = 200

/**
 * What the Person has so far for one question.
 *
 * - `Blank`: nothing yet.
 * - `Picked`: one or more of the question's options, by label, in the order they were picked.
 * - `Wrote`: words of their own, exactly as typed.
 */
export type Draft = Data.TaggedEnum<{
  Blank: {}
  Picked: { readonly labels: Arr.NonEmptyReadonlyArray<string> }
  Wrote: { readonly words: string }
}>
export const Draft = Data.taggedEnum<Draft>()

/**
 * Where the Person is in a request's questions: which one is up (`at`, counted from nothing),
 * and the draft for each, in the questions' order.
 */
export interface Asking {
  readonly at: number
  readonly drafts: ReadonlyArray<Draft>
}

/** The start of a request: its first question up, and nothing answered. */
export const begin = (questions: ReadonlyArray<InputQuestion>): Asking => ({
  at: 0,
  drafts: questions.map(() => Draft.Blank()),
})

/** The labels a draft holds, for a client marking its rows. Words and nothing are no labels. */
export const pickedIn = (draft: Draft): ReadonlyArray<string> =>
  Draft.$match(draft, {
    Blank: () => [],
    Picked: ({ labels }) => labels,
    Wrote: () => [],
  })

/** The words a draft holds, for a client's field. Picks and nothing are no words. */
export const writtenIn = (draft: Draft): string =>
  Draft.$match(draft, {
    Blank: () => '',
    Picked: () => '',
    Wrote: ({ words }) => words,
  })

/**
 * A draft after one of the question's options was pressed. Under `One` the pressed option is the
 * draft, whatever it held. Under `Several` the option is added, or taken out when it was already
 * there, and a draft left with none is blank again. Pressing an option always replaces words.
 */
export const toggle = (question: InputQuestion, draft: Draft, label: string): Draft => {
  if (question.selection === 'One') return Draft.Picked({ labels: [label] })
  const held = pickedIn(draft)
  const next = held.includes(label) ? held.filter((one) => one !== label) : [...held, label]
  return Arr.isReadonlyArrayNonEmpty(next) ? Draft.Picked({ labels: next }) : Draft.Blank()
}

/**
 * A draft after the Person typed in the question's own-answer field. Words that are more than
 * spaces replace whatever was picked; clearing the field clears words and leaves picks alone, as
 * the reference does, so emptying a field never throws away a pick made before it.
 */
export const write = (draft: Draft, words: string): Draft => {
  if (words.trim().length > 0) return Draft.Wrote({ words })
  return Draft.$is('Picked')(draft) ? draft : Draft.Blank()
}

/**
 * The answer a draft comes to, when it is one the question takes.
 *
 * Picks count only where they name an option the question offers, and under `One` only the
 * first of them, so a draft cannot become an answer the server would refuse. Words count only
 * where the question takes words of the Person's own, and are sent without the spaces round
 * them.
 */
export const answerOf = (question: InputQuestion, draft: Draft): Option.Option<InputAnswer> =>
  Draft.$match(draft, {
    Blank: () => Option.none(),
    Wrote: ({ words }) =>
      question.allowsOwnAnswer && words.trim().length > 0
        ? Option.some(InputAnswer.cases.Written.make({ words: words.trim() }))
        : Option.none(),
    Picked: ({ labels }) => {
      const offered = labels.filter((label) =>
        question.options.some((option) => option.label === label),
      )
      const counted = question.selection === 'One' ? offered.slice(0, 1) : offered
      return Arr.isReadonlyArrayNonEmpty(counted)
        ? Option.some(InputAnswer.cases.Chosen.make({ labels: counted }))
        : Option.none()
    },
  })

/** The draft for one question, by its place. A place past the end holds nothing. */
const draftAt = (asking: Asking, place: number): Draft =>
  Option.getOrElse(Arr.get(asking.drafts, place), () => Draft.Blank())

/** The same drafts with one of them replaced. */
const withDraft = (asking: Asking, place: number, draft: Draft): Asking => ({
  at: asking.at,
  drafts: asking.drafts.map((held, index) => (index === place ? draft : held)),
})

/**
 * Every question's answer, in the questions' order, once every question has one: what is sent.
 * Nothing while any question is still unanswered.
 */
export const answersOf = (
  questions: Arr.NonEmptyReadonlyArray<InputQuestion>,
  asking: Asking,
): Option.Option<Arr.NonEmptyReadonlyArray<InputAnswer>> =>
  Option.flatMap(
    Option.all(questions.map((question, place) => answerOf(question, draftAt(asking, place)))),
    (answers) => (Arr.isArrayNonEmpty(answers) ? Option.some(answers) : Option.none()),
  )

/** What a client draws from where the Person is. */
export interface Progress {
  /** The place of the question that is up, counted from nothing and never past the last. */
  readonly at: number
  /** How many questions the request carries. */
  readonly of: number
  readonly question: InputQuestion
  readonly draft: Draft
  /** The answer the question that is up has so far, when its draft comes to one. */
  readonly answer: Option.Option<InputAnswer>
  /** How many of the request's questions have an answer. */
  readonly answered: number
  /** There is a question before this one to go back to. */
  readonly first: boolean
  /** Moving on from this question sends the answers. */
  readonly last: boolean
  /** The question that is up has an answer, so the Person may move on from it. */
  readonly canAdvance: boolean
}

/** Reads where the Person is into what a client draws. */
export const progressOf = (
  questions: Arr.NonEmptyReadonlyArray<InputQuestion>,
  asking: Asking,
): Progress => {
  const at = Math.max(0, Math.min(asking.at, questions.length - 1))
  const question = Option.getOrElse(Arr.get(questions, at), () => Arr.headNonEmpty(questions))
  const draft = draftAt(asking, at)
  const answer = answerOf(question, draft)
  return {
    at,
    of: questions.length,
    question,
    draft,
    answer,
    answered: questions.filter((one, place) => Option.isSome(answerOf(one, draftAt(asking, place))))
      .length,
    first: at === 0,
    last: at === questions.length - 1,
    canAdvance: Option.isSome(answer),
  }
}

/** The Person pressed one of the options of the question that is up. */
export const press = (
  questions: Arr.NonEmptyReadonlyArray<InputQuestion>,
  asking: Asking,
  label: string,
): Asking => {
  const { at, question, draft } = progressOf(questions, asking)
  return withDraft(asking, at, toggle(question, draft, label))
}

/** The Person typed in the own-answer field of the question that is up. */
export const type = (
  questions: Arr.NonEmptyReadonlyArray<InputQuestion>,
  asking: Asking,
  words: string,
): Asking => {
  const { at, draft } = progressOf(questions, asking)
  return withDraft(asking, at, write(draft, words))
}

/**
 * What moving on from the question that is up comes to.
 *
 * - `Stay`: it has no answer yet, so nothing moves.
 * - `Next`: the next question is up, with every draft kept.
 * - `Send`: it was the last, and every question has an answer: these are sent.
 */
export type Step = Data.TaggedEnum<{
  Stay: {}
  Next: { readonly asking: Asking }
  Send: { readonly answers: Arr.NonEmptyReadonlyArray<InputAnswer> }
}>
export const Step = Data.taggedEnum<Step>()

/**
 * Moves on from the question that is up. On the last question it sends only when every question
 * has an answer; if an earlier one has lost its answer it stays, which no path here produces
 * (a question is left only once answered) but which must not send a short list.
 */
export const advance = (
  questions: Arr.NonEmptyReadonlyArray<InputQuestion>,
  asking: Asking,
): Step => {
  const progress = progressOf(questions, asking)
  if (!progress.canAdvance) return Step.Stay()
  if (!progress.last) return Step.Next({ asking: { at: progress.at + 1, drafts: asking.drafts } })
  return Option.match(answersOf(questions, asking), {
    onNone: () => Step.Stay(),
    onSome: (answers) => Step.Send({ answers }),
  })
}

/** Goes back to the question before, with every draft kept. On the first it stays. */
export const back = (asking: Asking): Asking => ({
  at: Math.max(0, asking.at - 1),
  drafts: asking.drafts,
})

/** Puts a question up by its place, with every draft kept: where a refusal sends the Person. */
export const returnTo = (asking: Asking, place: number): Asking => ({
  at: Math.max(0, place),
  drafts: asking.drafts,
})

/**
 * The question a refused answer was about, by its place, when the refusal names one. A count
 * that did not match names none: it is about the request as a whole.
 */
export const refusedAt = (failure: InputAnswerFailure): Option.Option<number> =>
  Match.value(failure).pipe(
    Match.tag('InputAnswerCountMismatch', () => Option.none<number>()),
    Match.orElse((named) => Option.some(named.questionIndex)),
  )

/**
 * One answer as words, for where a settled request is drawn: the picked labels in the order
 * they were picked, or the words that were written.
 */
export const said = (answer: InputAnswer): string =>
  InputAnswer.match(answer, {
    Chosen: ({ labels }) => labels.join(', '),
    Written: ({ words }) => words,
  })
