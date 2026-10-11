import type { InputRequest, InputRequestId, ThreadDetail } from '@vivid/contracts'
import { Option } from 'effect'

/**
 * The decisions around a request from Vivid (an Input request, of one to four questions) that
 * are the phone's own and need no screen to make: which request a tool call in the conversation
 * stands for, and how tall the card over the composer may be. Everything both clients decide the
 * same way (which request is up, what the card holds, one try at answering, where answers go in
 * the Thread, what a send from the composer means) is `asking` in `@vivid/state`.
 * `Choices.tsx` draws the card and `screen/Chat.tsx` holds the state.
 */

/** The Input request a tool call in the conversation stands for, once the Thread's detail has it. */
export const requestOf = (
  detail: Option.Option<ThreadDetail>,
  id: InputRequestId,
): Option.Option<InputRequest> =>
  Option.flatMap(detail, (value) =>
    Option.fromUndefinedOr(value.requests.find((request) => request.id === id)),
  )

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
