import {
  InputRequestState,
  type InputRequest,
  type InputRequestId,
  type PersonId,
  type ThreadDetail,
} from '@vivid/contracts'
import { Data, Option } from 'effect'

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
 */
export type Send = Data.TaggedEnum<{
  Message: {}
  Answer: { readonly id: InputRequestId }
}>
export const Send = Data.taggedEnum<Send>()

/** Reads what the composer sends from what the card is doing. A card that is leaving asks nothing. */
export const sendOf = (hold: Hold): Send =>
  Hold.$is('Up')(hold) && hold.request.allowsOwnAnswer
    ? Send.Answer({ id: hold.request.id })
    : Send.Message()

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
/** Nor is it squeezed under this: two rows and the grabber stay reachable, and the rest scrolls. */
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
