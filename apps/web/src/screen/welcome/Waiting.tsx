import type { SignInBrowser } from '@vivid/desktop/bridge'
import { useId, type ReactNode } from 'react'
import { Handing, type Why } from '../../data/signin'
import { Button } from '../../ui/button'
import { cn } from '../../ui/cn'
import { GoogleMark } from './Google'

/**
 * What each way a hand-off can stop short means to a Person who was signing in with Google, and
 * what to do about it. Every one of them leads to the same two buttons, so the words only have to
 * say what happened: nothing here was typed or approved, and nothing was changed.
 */
const ENDINGS = {
  failed: {
    title: 'Google sign-in did not finish',
    detail: 'Nothing changed. Try again when you are ready.',
  },
  expired: {
    title: 'This sign-in ran out',
    detail: 'It waits five minutes for you to choose an account. Start again when you are ready.',
  },
  refused: {
    title: 'Vivid could not finish signing you in',
    detail: 'Try again in a moment.',
  },
  unreachable: {
    title: 'Can’t reach Vivid',
    detail: 'Check your connection and try again.',
  },
} as const satisfies Record<Why, { title: string; detail: string }>

/**
 * The one sentence that says what to do, there before the browser covers the window and on coming
 * back. It is true whether the browser has opened yet or not, so it never argues with the line
 * under it.
 */
const HANDING = 'Choose your Google account in your browser and Vivid signs you in here.'

/** What the status line says, and whether it is said as a fault. */
interface Now {
  readonly tone: 'quiet' | 'danger'
  readonly words: string
}

/** Said while the shell is still being asked to open the browser. */
const OPENING: Now = { tone: 'quiet', words: 'Opening your browser…' }

/**
 * What is happening with the browser once the shell has answered. A browser that did not open is
 * said as a fault, with what to do about it: the button under it.
 */
const BROWSER = {
  opened: { tone: 'quiet', words: 'Waiting for you to choose an account.' },
  unopened: { tone: 'danger', words: 'Your browser did not open. Open it again.' },
} as const satisfies Record<SignInBrowser, Now>

/**
 * Said while the window trades Google's answer for a session. It promises nothing: the server has
 * not answered yet, and when it refuses the next thing shown is a card that says why. An earlier
 * card said "you are in" here, before that was known.
 */
const FINISHING: Now = { tone: 'quiet', words: 'Signing you in…' }

/**
 * Which of the card's two buttons can be pressed. Both are always drawn, in the same places, so
 * the card is one height from the press on "Continue with Google" until the app starts or an
 * ending replaces it; a button that cannot be used yet, or any more, rests instead of leaving.
 *
 * - `cancel`: the shell is still being asked to open the browser, so there is nothing to reopen.
 * - `both`: the browser has been asked for, and can be asked for again.
 * - `neither`: the trade is under way (see `Waiting`, below, for why it has no way out).
 */
type Ways = 'cancel' | 'both' | 'neither'

/**
 * Takes the keyboard to the card when it replaces the form. The button that was pressed is gone
 * with the form, and focus left on nothing would start the next Tab from the top of the window.
 * It is a constant, so React calls it once, when the card is first put on the page.
 */
const focusCard = (card: HTMLElement | null) => {
  if (card !== null) card.focus()
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
 * way back to the form under it. "Try again" is always a new attempt, because a code is good once
 * and there is no step to repeat.
 */
function Stopped({ why, onAgain, onBack }: { why: Why; onAgain: () => void; onBack: () => void }) {
  return (
    <Card title={ENDINGS[why].title} mark={false}>
      <p role="alert" className="text-label text-pretty text-ink-3">
        {ENDINGS[why].detail}
      </p>
      <Button onClick={onAgain} className="mt-1 w-full">
        Try again
      </Button>
      <Button variant="ghost" onClick={onBack} className="w-full">
        Back
      </Button>
    </Card>
  )
}

/**
 * A hand-off on its way: the one sentence that says what to do, what is happening now, and two
 * ways out. Nothing here is filled in the primary colour, because nothing here is the next step:
 * that is in the browser.
 *
 * Both buttons are there from the start and only rest (`ways`), so the card is the same height
 * while opening, while waiting and while finishing, and nothing moves under the pointer. A resting
 * button is the shared `Button` disabled: faded, and without the pointer cursor.
 */
function Going({
  now,
  ways,
  onReopen,
  onCancel,
}: {
  now: Now
  ways: Ways
  onReopen: () => void
  onCancel: () => void
}) {
  return (
    <Card title="Continue with Google" mark>
      <p className="text-label text-pretty text-ink-2">{HANDING}</p>
      {/* One line that changes with the hand-off. A fault interrupts; the rest wait their turn. */}
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
        disabled={ways !== 'both'}
        onClick={onReopen}
        className="mt-1 w-full"
      >
        Open the browser again
      </Button>
      <Button variant="ghost" disabled={ways === 'neither'} onClick={onCancel} className="w-full">
        Cancel
      </Button>
    </Card>
  )
}

/**
 * The welcome's card while the desktop app signs in with Google. The window cannot show Google's
 * sign-in itself, so the Person's browser opens on Google's account list and this window waits
 * (`data/handoff.ts`). They choose an account there and nothing else: no code is shown or typed
 * and nothing is approved. The window then signs itself in and starts again, so there is nothing
 * to press here on success.
 *
 * It is this screen's own card: the same panel the form sits in, the same buttons, nothing new.
 * It takes the form's place rather than covering it, because while this runs the form is not a
 * choice.
 *
 * Every state that can last has a way out. `Finishing` has none and needs none: it is one request
 * that ends within fifteen seconds, in the app or in a card that says why not, and stopping it
 * half way could leave a window signed in behind a form that says it is not. So it is the waiting
 * card with both buttons resting and one line changed, not a card of its own: this is the moment
 * the window comes back to the front, and a card that changed size or title then would be the
 * first thing the Person saw. It also does not say the Person is in. Only the server's answer
 * decides that, and when it is yes the app starts and this card is gone.
 */
export function Waiting({
  state,
  onReopen,
  onAgain,
  onCancel,
}: {
  state: Handing
  onReopen: () => void
  onAgain: () => void
  onCancel: () => void
}) {
  return Handing.$match(state, {
    Opening: () => <Going now={OPENING} ways="cancel" onReopen={onReopen} onCancel={onCancel} />,
    Waiting: ({ browser }) => (
      <Going now={BROWSER[browser]} ways="both" onReopen={onReopen} onCancel={onCancel} />
    ),
    Finishing: () => (
      <Going now={FINISHING} ways="neither" onReopen={onReopen} onCancel={onCancel} />
    ),
    Ended: ({ why }) => <Stopped why={why} onAgain={onAgain} onBack={onCancel} />,
  })
}
