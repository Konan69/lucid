import type {
  Approval,
  ApprovalId,
  InputRequest,
  InputRequestId,
  ThreadDetail,
} from '@vivid/contracts'
import type { ApprovalUp } from '@vivid/state'
import { Data, Option } from 'effect'

/**
 * The decisions around what Vivid asks of the Person (an Input request, of one to four
 * questions, and an Approval) that are the phone's own and need no screen to make: which record
 * a tool call in the conversation stands for, how tall the banner over the composer may be, what
 * the Approval's banner holds, and one try at deciding an Approval. Everything both clients
 * decide the same way about a request (which is up, what the card holds, one try at answering,
 * where answers go in the Thread, what a send from the composer means) is `asking` in
 * `@vivid/state`, and which Approval is up is `approvalUp` there.
 * `Choices.tsx` and `Allow.tsx` draw the banners and `screen/Chat.tsx` holds the state.
 */

/** The Input request a tool call in the conversation stands for, once the Thread's detail has it. */
export const requestOf = (
  detail: Option.Option<ThreadDetail>,
  id: InputRequestId,
): Option.Option<InputRequest> =>
  Option.flatMap(detail, (value) =>
    Option.fromUndefinedOr(value.requests.find((request) => request.id === id)),
  )

/** The Approval a tool call in the conversation stands for, once the Thread's detail has it. */
export const approvalOf = (
  detail: Option.Option<ThreadDetail>,
  id: ApprovalId,
): Option.Option<Approval> =>
  Option.flatMap(detail, (value) =>
    Option.fromUndefinedOr(value.approvals.find((approval) => approval.id === id)),
  )

/**
 * What the Approval's banner over the composer is doing, as a question's is (`asking.Hold`,
 * `@vivid/state`, which holds an Input request and nothing else).
 *
 * - `Free`: it holds nothing. If an Approval is up, it is taken next.
 * - `Up`: it holds the Approval that is up, drawn from its newest record, with how many are
 *   waiting on this Person now.
 * - `Leaving`: the Approval it holds is no longer the one that is up (it was decided here or on
 *   another device, ran out or was withdrawn). It is drawn from what was held, as it was when
 *   the banner took it, while it slides away; only then is the banner free for the next.
 */
export type ApprovalHold = Data.TaggedEnum<{
  Free: {}
  Up: { readonly up: ApprovalUp }
  Leaving: { readonly up: ApprovalUp }
}>
export const ApprovalHold = Data.taggedEnum<ApprovalHold>()

/** Reads what the banner is doing from the Approval it holds and the one that is up. */
export const approvalHoldOf = (
  held: Option.Option<ApprovalUp>,
  up: Option.Option<ApprovalUp>,
): ApprovalHold =>
  Option.match(held, {
    onNone: () => ApprovalHold.Free(),
    onSome: (was) =>
      Option.match(
        Option.filter(up, (next) => next.approval.id === was.approval.id),
        {
          onNone: () => ApprovalHold.Leaving({ up: was }),
          onSome: (current) => ApprovalHold.Up({ up: current }),
        },
      ),
  })

/**
 * Where the last decision made on this phone stands.
 *
 * - `Idle`: none has been made.
 * - `Flying`: it is on its way. `attempt` tells two tries apart, so that the end of an old one
 *   is never taken for the end of the one now on its way. A decision the server took stays
 *   here: it is the Approval's own record that takes its banner away, not the call returning,
 *   so buttons that woke up between the two could not be pressed a second time.
 * - `Refused`: it did not go through.
 */
export type Deciding = Data.TaggedEnum<{
  Idle: {}
  Flying: { readonly attempt: number; readonly id: ApprovalId }
  Refused: { readonly id: ApprovalId }
}>
export const Deciding = Data.taggedEnum<Deciding>()

/**
 * Where deciding stands after one try ended without going through: refused, when it was that
 * try; unchanged when another has started since. An Approval can be settled somewhere else while
 * a decision from here is in flight, and the next may be decided before the first call comes
 * back refused; that late refusal must not wake the buttons of the one being decided now, nor be
 * said about it.
 */
export const refusedAfter = (now: Deciding, attempt: number): Deciding =>
  Deciding.$is('Flying')(now) && now.attempt === attempt ? Deciding.Refused({ id: now.id }) : now

/** A decision about this Approval is on its way. */
export const isDeciding = (now: Deciding, id: ApprovalId): boolean =>
  Deciding.$is('Flying')(now) && now.id === id

/** The last decision about this Approval did not go through. */
export const wasRefused = (now: Deciding, id: ApprovalId): boolean =>
  Deciding.$is('Refused')(now) && now.id === id

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
