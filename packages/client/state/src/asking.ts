import {
  InputAnswer,
  InputRequestState,
  type InputQuestion,
  type InputRequest,
  type InputRequestId,
  type PersonId,
} from '@vivid/contracts'
import { InputAnswerFailure } from '@vivid/contracts/rpc'
import { Array as Arr, Data, Match, Option, Order, Schema } from 'effect'
import type { ProductFailure } from './live.js'

/**
 * Answering a request from Vivid that carries several questions, as every client does it: one
 * question at a time, a draft kept for each, and all the answers sent together at the end.
 * Nothing here draws or sends; the phone's card (`apps/mobile/src/screen/chat/Choices.tsx`) and
 * the web's (`apps/web/src/screen/thread/Choices.tsx`) are both this, told different things.
 *
 * The second half of the file is what both clients decide around that card, with no screen:
 * which request's card is up over the composer, what the card holds while one leaves and the
 * next waits its turn, one try at answering and how it ends, how each row stands, what a send
 * from the composer means, and where answers go in the Thread. They were the phone's own
 * (`apps/mobile/src/screen/chat/asked.ts`) until the web took the same card on 11 October 2026.
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

const isAnswerFailure = Schema.is(InputAnswerFailure)

/**
 * The server's refusal of an answer inside whatever a send failed with, when it was one. Each of
 * those says what to do in one plain sentence (`message`) and all but one name their question
 * (`refusedAt`). Any other failure (the request was settled meanwhile, the server could not be
 * reached) is not about an answer, and a client says its own sentence for it.
 */
export const refusalIn = (failure: ProductFailure): Option.Option<InputAnswerFailure> =>
  isAnswerFailure(failure) ? Option.some(failure) : Option.none()

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

// ── The card over the composer, and the Thread around it ───────────────────────

/**
 * The request whose choices are up: the oldest one still waiting on this Person. The Thread's
 * detail lists its requests oldest first, and one question is answered at a time, so the next
 * rises only once this one is settled. A request asked of somebody else is never up here.
 */
export const upOf = (
  requests: ReadonlyArray<InputRequest>,
  me: PersonId,
): Option.Option<InputRequest> =>
  Option.fromUndefinedOr(
    requests.find(
      (request) => InputRequestState.guards.Waiting(request.state) && request.askedOf.id === me,
    ),
  )

/**
 * What the card over the composer is doing.
 *
 * - `Free`: it holds nothing. If a request is up, it is taken next.
 * - `Up`: it holds the request that is up, drawn from its newest record.
 * - `Leaving`: the request it holds is no longer the one that is up (it was answered or
 *   withdrawn). It is drawn from what was held, as it was when the Person last saw it, while it
 *   slides away; only then is the card free for the next.
 */
export type Hold = Data.TaggedEnum<{
  Free: {}
  Up: { readonly request: InputRequest }
  Leaving: { readonly request: InputRequest }
}>
export const Hold = Data.taggedEnum<Hold>()

/** Reads what the card is doing from the request it holds and the one that is up. */
export const holdOf = (held: Option.Option<InputRequest>, up: Option.Option<InputRequest>): Hold =>
  Option.match(held, {
    onNone: () => Hold.Free(),
    onSome: (request) =>
      Option.match(
        Option.filter(up, (next) => next.id === request.id),
        {
          onNone: () => Hold.Leaving({ request }),
          onSome: (current) => Hold.Up({ request: current }),
        },
      ),
  })

/**
 * One try at answering one request. `attempt` tells two tries apart, so that the end of an old
 * one is never taken for the end of the one now on its way.
 */
export interface Attempt {
  readonly attempt: number
  readonly id: InputRequestId
}

/**
 * An answer that did not go through, as the screen needs it: which try and which request it
 * was, what to say, and the question to put back up when the refusal names one.
 */
export interface Refusal {
  readonly attempt: number
  readonly id: InputRequestId
  readonly words: string
  readonly place: Option.Option<number>
}

/**
 * Reads why an answer did not go through. The server's own refusals of an answer each say what
 * to do in one plain sentence and name the question they are about (`refusalIn`); those
 * words are said as they are. Anything else (the request was settled meanwhile, the server could
 * not be reached) names no question and gets one sentence that covers them.
 */
export const refusedOf = (tried: Attempt, failure: ProductFailure): Refusal =>
  Option.match(refusalIn(failure), {
    onSome: (refusal) => ({
      ...tried,
      words: refusal.message,
      place: refusedAt(refusal),
    }),
    onNone: () => ({
      ...tried,
      words: 'That answer did not go through. It may already be answered.',
      place: Option.none(),
    }),
  })

/**
 * What is on its way after one try ended without going through: nothing, when it was that try;
 * unchanged when another has started since. A late failure for a request settled elsewhere must
 * not wake the rows and the composer of the request being answered now.
 */
export const afterFailure = (
  pending: Option.Option<Attempt>,
  attempt: number,
): Option.Option<Attempt> => Option.filter(pending, (current) => current.attempt !== attempt)

/**
 * The tries at answering, as a client keeps them: the one on its way, and the last that did not
 * go through.
 */
export interface Tries {
  readonly pending: Option.Option<Attempt>
  readonly refused: Option.Option<Refusal>
}

/** Nothing on its way and nothing refused. */
export const untried: Tries = { pending: Option.none(), refused: Option.none() }

/**
 * What happens to a try.
 *
 * - `Began`: its answers left for the server.
 * - `Failed`: they did not go through. A try that went through is not said: it is the request's
 *   own record that takes its card away, and the try stays on its way until then.
 */
export type Tried = Data.TaggedEnum<{
  Began: { readonly tried: Attempt }
  Failed: { readonly tried: Attempt; readonly failure: ProductFailure }
}>
export const Tried = Data.taggedEnum<Tried>()

/**
 * The tries after something happened to one of them. A try that begins is the one on its way,
 * and what was last refused is forgotten. A try that failed stops being on its way only if it
 * still is the one (`afterFailure`), and is what was last refused (`refusedOf`).
 *
 * It is one pure step so that the end of a call, which arrives whenever the server answers,
 * never writes over the state of a later try: the step is told which try ended and decides from
 * that, whatever was on screen when the call began.
 */
export const triesAfter = (tries: Tries, happened: Tried): Tries =>
  Tried.$match(happened, {
    Began: ({ tried }) => ({ pending: Option.some(tried), refused: Option.none() }),
    Failed: ({ tried, failure }) => ({
      pending: afterFailure(tries.pending, tried.attempt),
      refused: Option.some(refusedOf(tried, failure)),
    }),
  })

/**
 * Whether an answer to a request may start: not while one to the same request is in flight. Two
 * presses in one moment, or a row and the composer together, are one answer.
 */
export const mayAnswer = (flying: ReadonlySet<InputRequestId>, id: InputRequestId): boolean =>
  !flying.has(id)

/**
 * One message of the conversation, as far as placing answers needs to know it.
 */
export interface Spoken {
  /** The message's own key in the list. */
  readonly key: string
  /** The requests this message raised, when it is a reply of Vivid's that asked. */
  readonly asked: ReadonlyArray<InputRequestId>
  /** The request this message is the delivered answer to, when it is that signal. */
  readonly answers: Option.Option<InputRequestId>
  /** When it was said, where the conversation stamps it (Vivid's replies; a Person's are not). */
  readonly at: Option.Option<number>
}

/** One row of the Thread: a message, or the answer to a question as a row of its own. */
export type Line = Data.TaggedEnum<{
  Said: { readonly key: string }
  Answer: {
    readonly request: InputRequest
    readonly answers: Arr.NonEmptyReadonlyArray<InputAnswer>
    readonly at: number
  }
}>
export const Line = Data.taggedEnum<Line>()

/** An answered request as the row it becomes. */
const answeredOf = (request: InputRequest): Option.Option<Extract<Line, { _tag: 'Answer' }>> =>
  InputRequestState.guards.Answered(request.state)
    ? Option.some(
        Line.Answer({ request, answers: request.state.answers, at: request.state.answeredAt }),
      )
    : Option.none()

/**
 * The rows of a Thread in the order they happened: its messages, with each answer to a question
 * of Vivid's as a row of its own where it was given.
 *
 * Where an answer goes:
 * - at the message that delivered it, when the conversation has that message (the server sends
 *   an answer to Vivid as a signal naming its request, in order with everything else);
 * - otherwise before the first message stamped later than the answer (`answeredAt`), and never
 *   before the reply that asked;
 * - otherwise at the end, which is where an answer just given belongs until its signal arrives.
 *
 * Until 11 October 2026 an answer was drawn under the reply that asked, whenever it was given,
 * so with other messages in between it landed back in the history, possibly out of sight.
 */
export const linesOf = (
  spoken: ReadonlyArray<Spoken>,
  requests: ReadonlyArray<InputRequest>,
): ReadonlyArray<Line> => {
  const answers = requests.flatMap((request) => Option.toArray(answeredOf(request)))
  const delivered = new Set(spoken.flatMap((message) => Option.toArray(message.answers)))
  // Answers with no delivering message, oldest first: placed by their time as the walk goes.
  // Sorted through Effect's `Array.sort`, never `toSorted`: the phone's JavaScript engine (Hermes)
  // does not have that method, and every Thread failed to draw on a device while this used it
  // (10 October 2026). A browser and the test runner both have it, so only the device showed it.
  const loose = Arr.sort(
    answers.filter((line) => !delivered.has(line.request.id)),
    Order.mapInput(Order.Number, (line: (typeof answers)[number]) => line.at),
  )
  const asked = new Set<InputRequestId>()
  const placed = new Set<InputRequestId>()
  const lines: Array<Line> = []
  for (const message of spoken) {
    const later = Option.getOrElse(message.at, () => Number.NEGATIVE_INFINITY)
    for (const line of loose) {
      const due = asked.has(line.request.id) && !placed.has(line.request.id) && line.at < later
      if (due) {
        placed.add(line.request.id)
        lines.push(line)
      }
    }
    for (const id of message.asked) asked.add(id)
    const here = Option.flatMap(message.answers, (id) =>
      Option.fromUndefinedOr(answers.find((line) => line.request.id === id)),
    )
    lines.push(Option.getOrElse(here, (): Line => Line.Said({ key: message.key })))
  }
  return [...lines, ...loose.filter((line) => !placed.has(line.request.id))]
}

/**
 * Where the phone's banner stands: all of it over the composer, closed to its head row (`tucked`),
 * or slid away behind the composer.
 */
export type Stand = 'up' | 'tucked' | 'gone'

/** A banner that is leaving is gone whether the Person had it open or closed. */
export const standOf = (leaving: boolean, tucked: boolean): Stand => {
  if (leaving) return 'gone'
  return tucked ? 'tucked' : 'up'
}

/**
 * What is kept of where the Person is in one request's questions: the drafts and the question
 * that is up (`Asking`), and the last refused try this already took account of.
 */
export interface Kept {
  readonly id: InputRequestId
  readonly drafting: Asking
  readonly heeded: Option.Option<number>
}

/**
 * Where the Person is in a request's questions, as the card and the composer both read it:
 * what is kept for that request, or its start when nothing is; and, when the last try was
 * refused over a question and that has not been taken account of yet, that question put back up
 * with every pick kept. Reading it this way puts the card back without anything having to be
 * written when the refusal arrives.
 */
export const draftingOf = (
  request: InputRequest,
  kept: Option.Option<Kept>,
  refusal: Option.Option<Refusal>,
): Asking => {
  const mine = Option.filter(kept, (one) => one.id === request.id)
  const drafting = Option.match(mine, {
    onNone: () => begin(request.questions),
    onSome: (one) => one.drafting,
  })
  const heeded = Option.flatMap(mine, (one) => one.heeded)
  return Option.match(
    Option.filter(refusal, (one) => one.id === request.id && !Option.contains(heeded, one.attempt)),
    {
      onNone: () => drafting,
      onSome: (one) =>
        Option.match(one.place, {
          onNone: () => drafting,
          onSome: (place) => returnTo(drafting, place),
        }),
    },
  )
}

/**
 * What a send from the composer means while a request may be up.
 *
 * - `Message`: an ordinary message in the Thread. This is what it nearly always is, a waiting
 *   request or not: the server withdraws the request when it takes the message, and Vivid reads
 *   it right after its own questions, so it both skips them and answers in the Person's words.
 * - `Answer`: the words are the answer to the question that is up, and nothing else. Only a
 *   question that offers no options and takes words of the Person's own makes the composer
 *   this: the card has nothing to press for it, and an ordinary message there would throw away
 *   what was picked for the questions before it. `drafting` holds the words; `step` is what
 *   moving on from the question comes to (the next question, or every answer to send).
 */
export type Reply = Data.TaggedEnum<{
  Message: {}
  Answer: { readonly drafting: Asking; readonly step: Step }
}>
export const Reply = Data.taggedEnum<Reply>()

/**
 * Reads what a send from the composer means. `up` is the request whose card is up and where the
 * Person is in it; with none up (no request, or its card is leaving) it is a message.
 */
export const replyOf = (
  up: Option.Option<{ readonly request: InputRequest; readonly drafting: Asking }>,
  words: string,
): Reply =>
  Option.match(up, {
    onNone: () => Reply.Message(),
    onSome: ({ request, drafting }) => {
      const { question } = progressOf(request.questions, drafting)
      if (question.options.length > 0 || !question.allowsOwnAnswer) return Reply.Message()
      const written = type(request.questions, drafting, words)
      return Reply.Answer({ drafting: written, step: advance(request.questions, written) })
    },
  })

/**
 * How one row stands: on offer, chosen (it is in the draft of the question that is up), or
 * standing back because the answers are on their way and nothing more can be chosen.
 */
export type Standing = 'open' | 'chosen' | 'back'

/** A chosen row stays chosen while the answers are on their way; the others stand back. */
export const standingOf = (chosen: boolean, busy: boolean): Standing => {
  if (chosen) return 'chosen'
  return busy ? 'back' : 'open'
}

/**
 * What an answered request says in the Thread, as the bubble of whoever answered: one line for
 * each question, in the questions' order. A question's picked options are joined with commas;
 * words written for it (from the composer, for a question with no options) are given as they are. A
 * request of one question is that one line.
 */
export const repliedWords = (answers: Arr.NonEmptyReadonlyArray<InputAnswer>): string =>
  answers.map(said).join('\n')
