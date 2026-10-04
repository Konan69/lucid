import { Pairing, spellCode, type Ending } from '@vivid/state'
import { Option } from 'effect'
import { useId } from 'react'
import { Button } from '../../ui/button'
import { cn } from '../../ui/cn'
import { GoogleMark } from './Google'

/**
 * What each way the exchange can end means to a Person who was signing in with Google. The words
 * are the phone's (`ENDINGS` in `apps/mobile/src/screen/door/Google.tsx`), said of this app
 * instead of a phone: nobody was asked to type a code here, so "this code ran out" would name a
 * thing they never held.
 */
const ENDINGS = {
  unreachable: {
    title: 'Can’t reach Vivid',
    detail: 'Check your connection and try again.',
  },
  expired: {
    title: 'This sign-in ran out',
    detail: 'It waits a few minutes for you to approve this app. Start again when you are ready.',
  },
  denied: {
    title: 'This app was not let in',
    detail: 'It was not approved in the browser. Start again to approve it.',
  },
  refused: {
    title: 'Vivid could not start a sign-in',
    detail: 'Try again in a moment.',
  },
} as const satisfies Record<Ending, { title: string; detail: string }>

/**
 * What the card says for a state that is still on its way: its heading, the one sentence that
 * says what to do, and under the code what is happening right now. The sentence is the same
 * while the browser is opening and while it is open, so it can be read before the browser
 * covers it and is still there on coming back.
 */
const HANDING =
  'Your browser opens. Sign in with Google there, approve this app, then come back here.'
const SAID = {
  Asking: { title: 'Continue with Google', lead: HANDING, now: 'Opening your browser…' },
  Waiting: {
    title: 'Continue with Google',
    lead: HANDING,
    now: 'Waiting for you to approve this app. The browser shows this code.',
  },
  Approved: {
    title: 'You are in',
    lead: 'This app was approved in your browser.',
    now: 'Opening Vivid…',
  },
} as const

/** The dots drawn where the code will be, so the card is the same size before it arrives. */
const NO_CODE = '····-····'

/**
 * Takes the keyboard to the card when it replaces the form. The button that was pressed is gone
 * with the form, and focus left on nothing would start the next Tab from the top of the window.
 * It is a constant, so React calls it once, when the card is first put on the page.
 */
const focusCard = (card: HTMLElement | null) => {
  if (card !== null) card.focus()
}

/**
 * The code this window is waiting on, in the fixed-width face and in two halves, the way the
 * approval page in the browser shows it. That match is how a Person knows the app being let in
 * is this one. Before the code arrives the same box holds dots, so nothing below it moves.
 */
function Code({ code }: { code: Option.Option<string> }) {
  return (
    <p
      // The dots stand for nothing; a screen reader is told what is happening by the status line.
      aria-hidden={Option.isNone(code)}
      className={cn(
        'rounded-control bg-well px-4 py-5 text-center font-mono text-page tracking-widest tabular-nums select-all',
        Option.isSome(code) ? 'text-ink' : 'text-ink-4',
      )}
    >
      {Option.getOrElse(code, () => NO_CODE)}
    </p>
  )
}

/**
 * The welcome's card while the desktop app signs in with Google. The window cannot show Google's
 * sign-in itself, so it hands the Person to their browser and waits (`data/handoff.ts`): there
 * they sign in with Google and approve this app, and the window then signs itself in and starts
 * again, so there is nothing to press here on success.
 *
 * It is the phone's Google step (`apps/mobile/src/screen/door/Google.tsx`) drawn as this
 * screen's own card: the same panel the form sits in, the same buttons, nothing new. It takes
 * the form's place rather than covering it, because while this runs the form is not a choice.
 *
 * - On its way (`Asking`, `Waiting`, `Approved`): the one sentence that says what to do, the
 *   code, what is happening now, and two ways out: open the browser again, for a Person who
 *   closed it, and cancel. Nothing here is filled in the primary colour, because nothing here is
 *   the next step: that is in the browser. "Open the browser again" is there from the start and
 *   rests until there is a code, so the card does not change height under the pointer.
 * - Ended: why, and one filled button to start again, with the way back to the form under it.
 */
export function Waiting({
  state,
  onReopen,
  onAgain,
  onCancel,
}: {
  state: Pairing
  onReopen: () => void
  onAgain: () => void
  onCancel: () => void
}) {
  const title = useId()
  if (Pairing.$is('Ended')(state)) {
    const ending = ENDINGS[state.why]
    return (
      <section
        ref={focusCard}
        tabIndex={-1}
        aria-labelledby={title}
        className="flex animate-rise-in flex-col gap-3 rounded-panel bg-surface-3 p-6 edge outline-none"
      >
        <h2 id={title} className="text-dialog font-title text-balance text-ink">
          {ending.title}
        </h2>
        <p role="alert" className="text-label text-pretty text-ink-3">
          {ending.detail}
        </p>
        <Button onClick={onAgain} className="mt-1 w-full">
          Try again
        </Button>
        <Button variant="ghost" onClick={onCancel} className="w-full">
          Back
        </Button>
      </section>
    )
  }
  const said = SAID[state._tag]
  const code = Pairing.$is('Waiting')(state)
    ? Option.some(spellCode(state.userCode))
    : Option.none()
  return (
    <section
      ref={focusCard}
      tabIndex={-1}
      aria-labelledby={title}
      className="flex animate-rise-in flex-col gap-3 rounded-panel bg-surface-3 p-6 edge outline-none"
    >
      <h2
        id={title}
        className="flex items-center gap-2 text-dialog font-title text-balance text-ink"
      >
        <GoogleMark />
        {said.title}
      </h2>
      <p className="text-label text-pretty text-ink-2">{said.lead}</p>
      <Code code={code} />
      {/* One line that changes with the exchange, so a screen reader hears each step once. */}
      <p role="status" className="text-label text-pretty text-ink-3">
        {said.now}
      </p>
      <Button
        variant="outline"
        disabled={Option.isNone(code)}
        onClick={onReopen}
        className="w-full"
      >
        Open the browser again
      </Button>
      <Button
        variant="ghost"
        // Once approved the window is signing itself in; there is nothing left to cancel.
        disabled={Pairing.$is('Approved')(state)}
        onClick={onCancel}
        className="w-full"
      >
        Cancel
      </Button>
    </section>
  )
}
