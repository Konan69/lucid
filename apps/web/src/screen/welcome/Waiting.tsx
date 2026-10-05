import { spellCode, type Ending } from '@vivid/state'
import { Option } from 'effect'
import { useId, type ReactNode } from 'react'
import { Handing, type Opened } from '../../data/pairing'
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

/** The one sentence that says what to do, there before the browser covers it and on coming back. */
const HANDING =
  'Your browser opens. Sign in with Google there, approve this app, then come back here.'

/**
 * What is happening with the browser, under the code. A browser that did not open is said as a
 * fault, with what to do about it: the button under it.
 */
const BROWSER = {
  opening: { tone: 'quiet', words: 'Opening your browser…' },
  opened: {
    tone: 'quiet',
    words: 'Waiting for you to approve this app. The browser shows this code.',
  },
  unopened: { tone: 'danger', words: 'Your browser did not open. Open it again.' },
} as const satisfies Record<Opened, { tone: 'quiet' | 'danger'; words: string }>

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
 * The card itself: the welcome's own panel, with a heading that names it. Every state of the
 * hand-off is drawn in this one element, so it arrives once (`animate-rise-in`) and the keyboard
 * stays in it while what it says changes.
 */
function Card({ title, mark, children }: { title: string; mark: boolean; children: ReactNode }) {
  const id = useId()
  return (
    <section
      ref={focusCard}
      tabIndex={-1}
      aria-labelledby={id}
      className="flex animate-rise-in flex-col gap-3 rounded-panel bg-surface-3 p-6 edge outline-none"
    >
      <h2 id={id} className="flex items-center gap-2 text-dialog font-title text-balance text-ink">
        {mark && <GoogleMark />}
        {title}
      </h2>
      {children}
    </section>
  )
}

/**
 * A hand-off that stopped short: what happened, one filled button for the way forward, and the
 * way back to the form under it.
 */
function Stopped({
  title,
  detail,
  onAgain,
  back,
  onBack,
}: {
  title: string
  detail: string
  onAgain: () => void
  back: string
  onBack: () => void
}) {
  return (
    <Card title={title} mark={false}>
      <p role="alert" className="text-label text-pretty text-ink-3">
        {detail}
      </p>
      <Button onClick={onAgain} className="mt-1 w-full">
        Try again
      </Button>
      <Button variant="ghost" onClick={onBack} className="w-full">
        {back}
      </Button>
    </Card>
  )
}

/**
 * A hand-off on its way: the one sentence that says what to do, the code, what is happening now,
 * and two ways out. Nothing here is filled in the primary colour, because nothing here is the
 * next step: that is in the browser. "Open the browser again" is there from the start and rests
 * until there is a code, so the card does not change height under the pointer.
 */
function Going({
  code,
  now,
  onReopen,
  onCancel,
}: {
  code: Option.Option<string>
  now: (typeof BROWSER)[Opened]
  onReopen: () => void
  onCancel: () => void
}) {
  return (
    <Card title="Continue with Google" mark>
      <p className="text-label text-pretty text-ink-2">{HANDING}</p>
      <Code code={Option.map(code, spellCode)} />
      {/* One line that changes with the exchange. A fault interrupts; the rest wait their turn. */}
      <p
        role={now.tone === 'danger' ? 'alert' : 'status'}
        className={cn(
          'text-label text-pretty',
          now.tone === 'danger' ? 'text-danger' : 'text-ink-3',
        )}
      >
        {now.words}
      </p>
      <Button
        variant="outline"
        disabled={Option.isNone(code)}
        onClick={onReopen}
        className="w-full"
      >
        Open the browser again
      </Button>
      <Button variant="ghost" onClick={onCancel} className="w-full">
        Cancel
      </Button>
    </Card>
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
 * Every state has a way out. While the approved session is being made this window's own
 * (`Adopting`) that is Cancel, and if that step gets no answer (`Unfinished`) the card says so and
 * offers it again, with the approval it already has; it never rests on "You are in" over a
 * window that is not.
 */
export function Waiting({
  state,
  onReopen,
  onAgain,
  onRetry,
  onCancel,
}: {
  state: Handing
  onReopen: () => void
  onAgain: () => void
  onRetry: () => void
  onCancel: () => void
}) {
  return Handing.$match(state, {
    Asking: () => (
      <Going code={Option.none()} now={BROWSER.opening} onReopen={onReopen} onCancel={onCancel} />
    ),
    Waiting: ({ userCode, browser }) => (
      <Going
        code={Option.some(userCode)}
        now={BROWSER[browser]}
        onReopen={onReopen}
        onCancel={onCancel}
      />
    ),
    Adopting: () => (
      <Card title="You are in" mark={false}>
        <p role="status" className="text-label text-pretty text-ink-3">
          This app was approved in your browser. Opening Vivid…
        </p>
        <Button variant="ghost" onClick={onCancel} className="w-full">
          Cancel
        </Button>
      </Card>
    ),
    Unfinished: () => (
      <Stopped
        title="That did not finish"
        detail="This app was approved, but Vivid did not answer in time. Try again."
        onAgain={onRetry}
        back="Cancel"
        onBack={onCancel}
      />
    ),
    Ended: ({ why }) => (
      <Stopped
        title={ENDINGS[why].title}
        detail={ENDINGS[why].detail}
        onAgain={onAgain}
        back="Back"
        onBack={onCancel}
      />
    ),
  })
}
