import {
  InputRequestState,
  type InputRequest,
  type InputRequestId,
  type PersonId,
  type ThreadDetail,
} from '@vivid/contracts'
import { Array as Arr, Data, Option, Order } from 'effect'

/**
 * The decisions around a question from Vivid (an Input request) that need no screen to make:
 * which request's choices are up over the composer, what the card holds while one leaves and the
 * next waits its turn, what the composer's send means meanwhile, how each row stands, and how
 * tall the card may be. `Choices.tsx` draws them and `screen/Chat.tsx` holds the state.
 */

/** The Input request a tool call in the conversation stands for, once the Thread's detail has it. */
export const requestOf = (
  detail: Option.Option<ThreadDetail>,
  id: InputRequestId,
): Option.Option<InputRequest> =>
  Option.flatMap(detail, (value) =>
    Option.fromUndefinedOr(value.requests.find((request) => request.id === id)),
  )

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
 * Whether a held request has a card to slide away. One with no choices draws none (there is
 * nothing to press: the composer is the whole answer), so it is let go at once.
 */
export const hasChoices = (request: InputRequest): boolean => request.options.length > 0

/**
 * What the composer's send means.
 *
 * - `Message`: an ordinary message in the Thread.
 * - `Answer`: the answer to the request that is up, in the Person's own words. Only a request
 *   that takes words of one's own makes the composer this: with one that does not, the composer
 *   still sends an ordinary message and the request goes on waiting.
 * - `Wait`: nothing can be sent for a moment. A request is waiting on the Person and its card is
 *   not up yet, because the card of the one before it is still sliding away (or has only just
 *   been let go). Words sent in that moment would be read as an ordinary message when the Person
 *   may mean them as the answer to the question now arriving, so they stay in the composer.
 */
export type Send = Data.TaggedEnum<{
  Message: {}
  Answer: { readonly id: InputRequestId }
  Wait: {}
}>
export const Send = Data.taggedEnum<Send>()

/**
 * Reads what the composer sends from what the card is doing and from the request that is up.
 * The two are separate on purpose: the card that is retiring says nothing about what a send
 * means. Only the request that is up does, and only once the card holds it.
 *
 * Until 11 October 2026 this read the card alone, so while one card slid away with the next
 * request already waiting, the composer sent an ordinary message and was not held.
 */
export const sendOf = (hold: Hold, up: Option.Option<InputRequest>): Send => {
  if (Hold.$is('Up')(hold)) {
    return hold.request.allowsOwnAnswer ? Send.Answer({ id: hold.request.id }) : Send.Message()
  }
  return Option.isSome(up) ? Send.Wait() : Send.Message()
}

/**
 * One try at answering one request. `attempt` tells two tries apart, so that the end of an old
 * one is never taken for the end of the one now on its way.
 */
export interface Attempt {
  readonly attempt: number
  readonly id: InputRequestId
  readonly words: string
}

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
  Answer: { readonly request: InputRequest; readonly answer: string; readonly at: number }
}>
export const Line = Data.taggedEnum<Line>()

/** An answered request as the row it becomes. */
const answerOf = (request: InputRequest): Option.Option<Extract<Line, { _tag: 'Answer' }>> =>
  InputRequestState.guards.Answered(request.state)
    ? Option.some(
        Line.Answer({ request, answer: request.state.answer, at: request.state.answeredAt }),
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
  const answers = requests.flatMap((request) => Option.toArray(answerOf(request)))
  const delivered = new Set(spoken.flatMap((said) => Option.toArray(said.answers)))
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
  for (const said of spoken) {
    const later = Option.getOrElse(said.at, () => Number.NEGATIVE_INFINITY)
    for (const line of loose) {
      const due = asked.has(line.request.id) && !placed.has(line.request.id) && line.at < later
      if (due) {
        placed.add(line.request.id)
        lines.push(line)
      }
    }
    for (const id of said.asked) asked.add(id)
    const here = Option.flatMap(said.answers, (id) =>
      Option.fromUndefinedOr(answers.find((line) => line.request.id === id)),
    )
    lines.push(Option.getOrElse(here, (): Line => Line.Said({ key: said.key })))
  }
  return [...lines, ...loose.filter((line) => !placed.has(line.request.id))]
}

/** Where the card stands: all of it over the composer, only its grabber, or slid away behind it. */
export type Stand = 'up' | 'tucked' | 'gone'

/** A card that is leaving is gone whatever the Person last did with its grabber. */
export const standOf = (leaving: boolean, tucked: boolean): Stand => {
  if (leaving) return 'gone'
  return tucked ? 'tucked' : 'up'
}

/**
 * How one row stands: on offer, the one whose answer is on its way, or standing back while
 * another answer (a row's, or the Person's own words from the composer) is.
 */
export type Standing = 'open' | 'chosen' | 'back'

export const standingOf = (label: string, sending: Option.Option<string>): Standing =>
  Option.match(sending, {
    onNone: () => 'open',
    onSome: (said) => (said === label ? 'chosen' : 'back'),
  })

/** The card is never taller than this, however large the screen. */
const TALLEST = 560
/**
 * Nor is it squeezed under this. The card's head (the grabber and the question, up to four
 * lines) is fixed and the rows scroll in what is left, so at this floor a short question leaves
 * about two rows in sight and a long one leaves the rows to be scrolled to.
 */
const SHORTEST = 160
/** What is kept clear between the top of the card and what is above it. */
const ABOVE = 12

/**
 * The keyboard's height before one has been seen: a portrait iPhone's with its suggestion bar.
 * Overestimating only costs the card height; an underestimate would put it under the bar when
 * the Person opens the keyboard to reply.
 */
export const KEYBOARD_RESERVE = 336

/**
 * The most room the card may take, so that it fits between the bar and the composer with the
 * keyboard up. The keyboard's room is reserved whether or not it is up, so the card is the same
 * height either way and opening the keyboard only moves it.
 *
 * Ported from T3 Code mobile `src/features/threads/pendingUserInputLayout.ts`
 * (`derivePendingUserInputMaxHeight`: the window less the keyboard, the header, the composer's
 * overlap and a 12-point gap, held between 160 and 560). There the composer's overlap is only
 * its bottom inset, because the questions take the composer's place; Vivid's composer stays, so
 * `composer` here is its whole height.
 */
export const tallestOf = (room: {
  readonly window: number
  readonly keyboard: number
  readonly bar: number
  readonly composer: number
}): number => {
  const available =
    room.window -
    Math.max(0, room.keyboard) -
    Math.max(0, room.bar) -
    Math.max(0, room.composer) -
    ABOVE
  return Math.min(TALLEST, Math.max(SHORTEST, available))
}
