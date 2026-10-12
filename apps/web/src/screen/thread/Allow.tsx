import {
  ActionTarget,
  ApprovalDecision,
  type Approval,
  type ApprovalId,
  type InputRequest,
  type PersonId,
} from '@vivid/contracts'
import { APPROVAL_EFFECT_WORDS, approvalUp, asking, type ApprovalUp } from '@vivid/state'
import { Data, Effect, Option, Result } from 'effect'
import { ChevronRight, Ellipsis, Shield } from 'lucide-react'
import { useCallback, useId, useReducer, useRef, useState } from 'react'
import { act } from '../../data/app'
import { changing } from '../../data/live'
import { Button } from '../../ui/button'
import { cn } from '../../ui/cn'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../ui/dropdownmenu'
import { useAsking, type Asking } from './asking'
import { Exactly } from './Cards'
import { Attached, Raised, SURFACE } from './Choices'

/**
 * Something Vivid wants to do and will not do without a yes, as a banner attached to the top of
 * the composer while it waits on the Person looking at it. What it asked is also Vivid's words
 * in the conversation (`AskedFirst`, `Cards.tsx`), which is what stays once the banner has gone.
 *
 * It is a port of T3 Code web's pending-approval banner, read from its `origin/main`:
 * `components/chat/ComposerBanner.tsx` (`Root` with `variant="warning"` and
 * `density="spacious"`, `Row` with `layout="approval"`, `Icon`, `Content`, `Actions`),
 * `components/chat/ComposerPendingApprovalPanel.tsx`,
 * `components/chat/ComposerPendingApprovalActions.tsx`, and the `activePendingApproval` branch
 * of `components/chat/ChatComposer.tsx`. Kept from it:
 * - It is on the attachment and surface a question's banner is on (`Attached`, `SURFACE`,
 *   `Choices.tsx`), in the warning variant: 12 px of padding, the edge and a faint tint in the
 *   approval colour (`asked-surface` with `data-asks="approval"`, `styles/motion.css`).
 * - One row of three columns, tops aligned: a shield, 16 px, in the approval colour; the words;
 *   the buttons, beside the words and centred on them. In a banner narrower than 560 px the
 *   buttons drop under the words, at the end (`asked-row`, a container query).
 * - The words are a column 4 px apart. First a small muted line: what kind of action it is, in
 *   medium weight and the approval colour, then where it lands, cut short, and at the far end
 *   "1/3" when more than one is waiting on this Person. Then what is to be approved.
 * - The buttons: decline, as a control; approve, as the one filled action; and an ellipsis menu
 *   that opens upward from its end with the rest. Nothing can be pressed while a decision is on
 *   its way.
 * - While an Approval is up it takes the place of a question's banner (`useAsks`).
 *
 * Adapted, and why:
 * - The reference's label is the kind of request ("Command approval") and its second line is
 *   the command itself. A Vivid Approval says what it would do in one sentence
 *   (`action.summary`), so that is the second line, in up to three lines and never cut to one;
 *   and the label is how much the action can change (`APPROVAL_EFFECT_WORDS`). The reference's
 *   app name is the account the action uses, when it uses one.
 * - Exactly what would be sent is the reference's detail box (80 px at most, scrolling,
 *   focusable). Here it is closed until "Details" is pressed: the sentence is what a Person
 *   reads, and every field of an action shown at once is what made the card this replaces a
 *   developer's tool.
 * - There are three answers, not four: Vivid has no "cancel" apart from "Don't allow", so the
 *   menu holds one item, "Always allow".
 * - The banner arrives and leaves by the fold a question's banner uses (`asked-attachment`); the
 *   reference's is simply there.
 * - A decision that did not go through is said over the banner, as a question's refusal is.
 * - The buttons are the app's small size (28 px), as the composer's "Next question" is; the
 *   reference's are 24 px.
 */

/**
 * One try at deciding one Approval. `attempt` tells two tries apart, so that the end of an old
 * one is never taken for the end of the one now on its way.
 */
interface Attempt {
  readonly attempt: number
  readonly id: ApprovalId
}

/**
 * Where deciding stands, for the whole Thread: one Approval is decided at a time.
 *
 * - `Still`: nothing has been pressed.
 * - `Sending`: a decision left for the server. It stays so when the server takes it: it is the
 *   Approval's own record that takes its banner away, not the call returning, so buttons that
 *   woke up between the two could not be pressed a second time.
 * - `Refused`: the server did not take it. The Approval was decided somewhere else, or what it
 *   would do changed; the record on screen is the newer one and can be decided again.
 */
export type Deciding = Data.TaggedEnum<{
  Still: {}
  Sending: { readonly tried: Attempt }
  Refused: { readonly tried: Attempt }
}>
export const Deciding = Data.taggedEnum<Deciding>()

/** What happens to a try: it left for the server, or the server did not take it. */
export type Tried = Data.TaggedEnum<{
  Began: { readonly tried: Attempt }
  Failed: { readonly tried: Attempt }
}>
export const Tried = Data.taggedEnum<Tried>()

/**
 * Where deciding stands after something happened to a try. A try that begins is the one on its
 * way. A try that failed is refused only if it still is the one on its way: the end of a call
 * arrives whenever the server answers, and the end of an older try must not wake the buttons of
 * the Approval being decided now, or say a refusal about it.
 */
export const decidingAfter = (deciding: Deciding, happened: Tried): Deciding =>
  Tried.$match(happened, {
    Began: ({ tried }) => Deciding.Sending({ tried }),
    Failed: ({ tried }) =>
      Deciding.$is('Sending')(deciding) && deciding.tried.attempt === tried.attempt
        ? Deciding.Refused({ tried })
        : deciding,
  })

/** What is said when a decision did not go through. The record on screen is already the newer. */
const REFUSED = 'This was already decided, or it changed. Look again.'

/**
 * What the banner over the composer is doing: nothing, showing the Approval that is up, or
 * folding away one that no longer is. It is `asking.Hold` (`@vivid/state`) for an Approval.
 */
export type Hold = Data.TaggedEnum<{
  Free: {}
  Up: { readonly up: ApprovalUp }
  Leaving: { readonly up: ApprovalUp }
}>
export const Hold = Data.taggedEnum<Hold>()

/**
 * Reads what the banner is doing from the Approval it holds and the one that is up. While they
 * are the same Approval the banner shows the server's newest record of it and the newest count
 * of those waiting; once they differ it keeps what it held until it has folded away.
 */
const holdOf = (held: Option.Option<ApprovalUp>, up: Option.Option<ApprovalUp>): Hold =>
  Option.match(held, {
    onNone: () => Hold.Free(),
    onSome: (kept) =>
      Option.match(
        Option.filter(up, (next) => next.approval.id === kept.approval.id),
        {
          onNone: () => Hold.Leaving({ up: kept }),
          onSome: (current) => Hold.Up({ up: current }),
        },
      ),
  })

/**
 * The Approval whose banner is up over the composer, and deciding it. It is `useAsking`
 * (`asking.ts`) for an Approval, and keeps state the same way.
 *
 * `up` is the Approval that should be up (`approvalUp`, `@vivid/state`). The banner holds one
 * at a time and lets go of it only once it has folded away, so the next one's banner arrives
 * after the last has settled (`holdOf`). What it holds follows `up` while rendering, which is
 * React's own way to follow a value without an effect: a free banner takes what is up.
 *
 * Each press is one `Attempt`, and what ends is that attempt and nothing else (`decidingAfter`):
 * the state is one value moved by what happens to a try, never set from the far side of the
 * call. One Approval also takes one decision at a time. Which have a call in flight is kept in
 * a ref, read when a press happens and never while rendering, because two presses can land
 * before React has drawn the first.
 *
 * The decision quotes the digest of the record it was pressed on, so a banner drawn from an
 * older proposal cannot allow a newer one: the server refuses it, and that is said.
 */
export function useAllowing(up: Option.Option<ApprovalUp>) {
  const [held, setHeld] = useState(up)
  const [deciding, tried] = useReducer(decidingAfter, Deciding.Still())
  const flying = useRef(new Set<ApprovalId>())
  const attempts = useRef(0)
  const hold = holdOf(held, up)
  if (Hold.$is('Free')(hold) && Option.isSome(up)) setHeld(up)
  // One function for the life of the Thread: the banner is handed it, and is not drawn again for
  // a function that only looks new.
  const release = useCallback(() => setHeld(Option.none()), [])

  /** Sends one decision on one Approval, as that Approval's record stood when it was pressed. */
  const decide = useCallback((approval: Approval, decision: ApprovalDecision) => {
    const { id, digest } = approval
    if (flying.current.has(id)) return
    flying.current.add(id)
    attempts.current += 1
    const attempt: Attempt = { attempt: attempts.current, id }
    tried(Tried.Began({ tried: attempt }))
    void act(
      Effect.gen(function* () {
        const result = yield* changing((client) => client.DecideApproval({ id, digest, decision }))
        flying.current.delete(id)
        if (Result.isFailure(result)) tried(Tried.Failed({ tried: attempt }))
      }),
    )
  }, [])

  return {
    hold,
    /** A decision on this Approval is on its way, or was taken and its record is yet to say so. */
    sending: (id: ApprovalId) => Deciding.$is('Sending')(deciding) && deciding.tried.id === id,
    /** What to say when the last decision on this Approval did not go through. */
    refusalOf: (id: ApprovalId): Option.Option<string> =>
      Deciding.$is('Refused')(deciding) && deciding.tried.id === id
        ? Option.some(REFUSED)
        : Option.none(),
    decide,
    release,
  }
}

/** What `useAllowing` answers with: what the banner is given. */
export type Allowing = ReturnType<typeof useAllowing>

/**
 * Everything Vivid is asking of this Person over the composer, one banner at a time: an
 * Approval first, then a question (the reference shows its pending approval in place of its
 * pending question, `ChatComposer.tsx`).
 *
 * While an Approval is up, or its banner is still folding away, no question is up as far as the
 * Thread is concerned: its banner is not drawn, the composer's button does not move on from it
 * and the composer says "Message Vivid". The question is not withdrawn by that, and where the
 * Person was in it is kept (`useAsking`); its banner rises when the last Approval has settled
 * and gone. The other way round, an Approval that arrives while a question's banner is up is
 * held at once but drawn only when that banner has folded away (`Asks`), so two banners are
 * never over the composer together. One that is settled before it was ever drawn is let go of
 * here and now: a banner says it has gone when its fold ends, and one that was never on screen
 * has no fold to end, so it would hold the place over the composer for good.
 */
export function useAsks(
  approvals: ReadonlyArray<Approval>,
  requests: ReadonlyArray<InputRequest>,
  me: PersonId,
) {
  const up = approvalUp(approvals, me)
  const allowing = useAllowing(up)
  const first = Option.isSome(up) || !Hold.$is('Free')(allowing.hold)
  const asked = useAsking(first ? Option.none() : asking.upOf(requests, me))
  const undrawn = !asking.Hold.$is('Free')(asked.hold)
  if (undrawn && Hold.$is('Leaving')(allowing.hold)) allowing.release()
  return { allowing, asked }
}

/**
 * The one banner over the composer (`useAsks`): a question's while that banner holds anything,
 * its last fold included, and otherwise the Approval's, when one is held.
 */
export function Asks({ allowing, asked }: { allowing: Allowing; asked: Asking }) {
  return asking.Hold.$is('Free')(asked.hold) ? (
    <Allowed allowing={allowing} />
  ) : (
    <Raised asking={asked} />
  )
}

/**
 * The banner over the composer, for what it holds (`useAllowing`): the Approval that is up, or
 * the one folding away. It is keyed by the Approval, so each one's banner arrives, with its
 * details closed and its menu shut.
 */
export function Allowed({ allowing }: { allowing: Allowing }) {
  const drawn = Hold.$match(allowing.hold, {
    Free: () => Option.none(),
    Up: ({ up }) => Option.some({ up, leaving: false }),
    Leaving: ({ up }) => Option.some({ up, leaving: true }),
  })
  if (Option.isNone(drawn)) return null
  const { approval, waiting } = drawn.value.up
  const { leaving } = drawn.value
  return (
    <Attached
      key={approval.id}
      leaving={leaving}
      refusal={allowing.refusalOf(approval.id)}
      onGone={allowing.release}
    >
      <Allow
        approval={approval}
        waiting={waiting}
        // An Approval that has just been settled, here or anywhere else, cannot be decided; nor
        // can one whose decision is on its way.
        held={leaving || allowing.sending(approval.id)}
        onDecide={(decision) => allowing.decide(approval, decision)}
      />
    </Attached>
  )
}

/** The account an action uses, when it uses one: a step on the Computer uses none. */
const accountOf = (target: ActionTarget): Option.Option<string> =>
  ActionTarget.match(target, {
    Connection: ({ account }) => Option.some(account),
    Browser: () => Option.none(),
    Desktop: () => Option.none(),
  })

/**
 * The banner's surface and its one row (`asked-row`: the reference's `Row layout="approval"`):
 * the shield in a column as wide as a question's mark (28 px, 24 from the `sm` width up), the
 * words, and the buttons.
 *
 * The first line never wraps: the kind of action is short and kept whole, the account gives way
 * (it is said in full under "Details"), and the count keeps the far end. What Vivid would do
 * wraps, to three lines at most; a string with no place to break (an address, a link) breaks
 * anywhere, and it takes its direction from its own first strong letter, so an Arabic sentence
 * starts at the right in a banner that reads left to right.
 */
function Allow({
  approval,
  waiting,
  held,
  onDecide,
}: {
  approval: Approval
  /** How many Approvals are waiting on this Person in the Thread, this one included. */
  waiting: number
  /** Nothing can be decided just now (`Allowed`). */
  held: boolean
  onDecide: (decision: ApprovalDecision) => void
}) {
  const { action } = approval
  const account = accountOf(action.target)
  return (
    <section aria-label="Vivid asks first" data-asks="approval" className={SURFACE}>
      <div className="asked-row">
        <span aria-hidden className="flex w-7 flex-none justify-center pt-0.5 text-approve sm:w-6">
          <Shield className="size-4" />
        </span>
        <div data-asked="content" className="flex min-w-0 flex-col items-start gap-1">
          <p className="flex w-full min-w-0 items-center gap-2 text-meta text-ink-3">
            <span data-asked="effect" className="shrink-0 font-title text-approve">
              {APPROVAL_EFFECT_WORDS[action.effect]}
            </span>
            {Option.isSome(account) && (
              <span data-asked="account" className="min-w-0 truncate">
                {account.value}
              </span>
            )}
            {waiting > 1 && (
              <span
                data-asked="count"
                aria-label={`The first of ${waiting} waiting on you`}
                className="ml-auto shrink-0 tabular-nums"
              >
                1/{waiting}
              </span>
            )}
          </p>
          <p data-asked="summary" dir="auto" className="line-clamp-3 w-full wrap-anywhere text-ink">
            {action.summary}
          </p>
          <Details target={action.target} />
        </div>
        <div data-asked="actions" className="flex flex-wrap items-center justify-end gap-1.5">
          <Answers held={held} onDecide={onDecide} />
        </div>
      </div>
    </section>
  )
}

/**
 * Exactly what would be done (`Exactly`, `Cards.tsx`), closed until asked for: a small quiet
 * button, and the reference's detail box, which is 80 px tall at most and scrolls. The box can
 * take the keyboard's focus, as the reference's can, so it can be scrolled without a pointer.
 * Closed, it stays in the document for the button to name, and is `hidden`.
 */
function Details({ target }: { target: ActionTarget }) {
  const [open, setOpen] = useState(false)
  const box = useId()
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={box}
        onClick={() => setOpen((shown) => !shown)}
        className="-ml-1 inline-flex cursor-pointer items-center gap-1 rounded-row px-1 py-0.5 text-meta font-meta text-ink-3 transition-colors duration-(--dur-fast) hover:bg-wash-hover hover:text-ink focus-visible:bg-wash-hover focus-visible:text-ink"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            'size-3.5 shrink-0 transition-transform duration-(--dur-fast)',
            open && 'rotate-90',
          )}
        />
        Details
      </button>
      <div
        id={box}
        hidden={!open}
        role="group"
        aria-label="Exactly what Vivid would do"
        // A box that scrolls must be reachable from the keyboard to be scrolled from it.
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        className="max-h-20 w-full overflow-auto rounded-row focus-visible:-outline-offset-2"
      >
        <Exactly target={target} />
      </div>
    </>
  )
}

/**
 * The three answers, after the reference's: decline as a control, approve as the one filled
 * action, and the rest behind an ellipsis that opens upward from its end. "Allow" is for this
 * once; "Always allow" also writes the Person's rule, so the same kind of action does not ask
 * again (`ApprovalDecision`, `packages/contracts`).
 *
 * The menu is drawn outside the banner (a portal), where the banner being `inert` does not
 * reach. So it is open only while something can be decided: an Approval that is settled
 * somewhere else while the menu is open takes the menu with it, and its item sends nothing.
 */
function Answers({
  held,
  onDecide,
}: {
  held: boolean
  onDecide: (decision: ApprovalDecision) => void
}) {
  const [menu, setMenu] = useState(false)
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={held}
        onClick={() => onDecide(ApprovalDecision.cases.Deny.make({}))}
      >
        Don’t allow
      </Button>
      <Button
        size="sm"
        disabled={held}
        onClick={() => onDecide(ApprovalDecision.cases.AllowOnce.make({}))}
      >
        Allow
      </Button>
      <DropdownMenu open={menu && !held} onOpenChange={(next) => setMenu(next)}>
        <DropdownMenuTrigger
          disabled={held}
          render={<Button variant="outline" size="icon-sm" aria-label="More ways to answer" />}
        >
          <Ellipsis />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end" className="min-w-40">
          <DropdownMenuItem
            onClick={() => {
              if (!held) onDecide(ApprovalDecision.cases.AlwaysAllow.make({}))
            }}
          >
            Always allow
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
