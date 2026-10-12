import type { InputRequest, InputRequestId, ThreadDetail } from '@vivid/contracts'
import { Option } from 'effect'

/**
 * The decisions around a request from Vivid (an Input request, of one to four questions) that
 * are the phone's own and need no screen to make: which request a tool call in the conversation
 * stands for, and how tall the banner over the composer may be. Everything both clients decide the
 * same way (which request is up, what the card holds, one try at answering, where answers go in
 * the Thread, what a send from the composer means) is `asking` in `@vivid/state`.
 * `Choices.tsx` draws the banner and `screen/Chat.tsx` holds the state.
 */

/** The Input request a tool call in the conversation stands for, once the Thread's detail has it. */
export const requestOf = (
  detail: Option.Option<ThreadDetail>,
  id: InputRequestId,
): Option.Option<InputRequest> =>
  Option.flatMap(detail, (value) =>
    Option.fromUndefinedOr(value.requests.find((request) => request.id === id)),
  )

/** The banner is never taller than this, however large the screen. */
const TALLEST = 560
/**
 * Nor is it squeezed under this. The banner's head (the question, up to two lines) is fixed and
 * the rows scroll in what is left, so at this floor a short question leaves about two rows in
 * sight and a long one leaves the rows to be scrolled to.
 */
const SHORTEST = 160
/** What is kept clear between the top of the banner and what is above it. */
const ABOVE = 12

/**
 * The room kept for the keyboard while it is up: a portrait iPhone's with its suggestion bar.
 * The app is told that the keyboard is up, not how tall it is (`data/keyboard.ts`).
 * Overestimating only costs the banner height; an underestimate would put it under the bar.
 */
export const KEYBOARD_RESERVE = 336

/**
 * The room the keyboard takes from the banner: its reserve while it is up, and none while it is
 * down. Until 11 October 2026 the reserve was kept whether or not the keyboard was up, so that
 * opening it only moved the card; with the keyboard down that cut the card to about half the
 * room it had, and a question with five options scrolled on a screen that could show them all.
 */
export const keyboardRoomOf = (showing: boolean): number => (showing ? KEYBOARD_RESERVE : 0)

/**
 * The most room the banner may take, so that it fits between the bar and the composer, over the
 * keyboard when that is up (`keyboardRoomOf`).
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
