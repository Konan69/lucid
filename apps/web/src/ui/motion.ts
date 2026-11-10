import { Effect } from 'effect'

/**
 * Vivid's motion on the web, by name.
 *
 * Every animated thing in the app uses one of these and nothing else, so two menus can never open
 * at different speeds. The numbers themselves are CSS custom properties (`@vivid/tokens` and
 * `styles/motion.css`); this file names them, says where each came from, and plays them from an
 * event handler when CSS alone cannot (something leaving, something sliding between two places).
 *
 * Sources:
 * - Grok Bot 0.30 (`refs/grok-bot-0.30/motion/motion.ts`, `easings.json`): `easeOutExpo` is its
 *   dominant curve; its durations are fast 100, base 200, slow 250; its transitions are all
 *   named-property lists at .1s or .15s, never `all`.
 * - T3 Code mobile (`SegmentedControl.tsx`: `LinearTransition.duration(200)`;
 *   `ConnectionEnvironmentRow.tsx`: layout 250 ms, `FadeIn` 200 ms, `FadeOut` 150 ms).
 * - `.agents/skills/animate`: press `scale(0.97)`, entrances from 0.95 to 0.97, exits faster
 *   than entrances, a 30 to 80 ms stagger.
 *
 * What decides whether something moves at all is how often it is seen: nothing done from the
 * keyboard, and nothing done a hundred times a day, animates. `byKeyboard` and `instantly` exist
 * for that.
 *
 * There is no spring here. A spring is for something a finger drags and lets go of, and the web
 * app has no such thing yet: its two drags (the sidebar's edge, the Computer's) follow the pointer
 * and stop where they are left. When one arrives, port Grok Bot's snappy spring
 * (`SPRINGS[1]`: stiffness 500, damping 25, mass 1).
 */
const MOTION = {
  /** Something arriving in a column: a Message, a card, a row. Class `motion-enter`. */
  enter: { duration: '--dur-enter', easing: '--ease-out-expo' },
  /** Something leaving because the Person sent it away. Faster than it came. */
  exit: { duration: '--dur-exit', easing: '--ease-out' },
  /** A menu or popover opening from its trigger. Class `motion-pop`. */
  pop: { duration: '--dur-fast', easing: '--ease-out' },
  /** A menu closing. */
  popExit: { duration: '--dur-pop-exit', easing: '--ease-out' },
  /** A control giving under the hand. Class `motion-press`. */
  press: { duration: '--dur-fast', easing: '--ease-out' },
  /** Something already on screen going to a new place: a row reordered, a list closing up. */
  layout: { duration: '--dur-layout', easing: '--ease-in-out' },
  /** Rows folding away where they stand, as an answered question closes. Class `motion-fold`. */
  fold: { duration: '--dur-base', easing: '--ease-out' },
  /** A progress ring's arc growing to a new count. Class `motion-arc`. */
  arc: { duration: '--dur-base', easing: '--ease-out' },
  /** The mark under the chosen option of a segmented control going to the next one. */
  slide: { duration: '--dur-base', easing: '--ease-in-out' },
} as const satisfies Record<string, { duration: `--${string}`; easing: `--${string}` }>

export type MotionName = keyof typeof MOTION

/** How a look that is leaving ends: nearly its own size, and gone. Never shrunk to nothing. */
const GONE = { opacity: 0, scale: 0.98 } as const

const SYSTEM_STILL = matchMedia('(prefers-reduced-motion: reduce)')

/** Whether this Person has asked their system for less motion. */
export const still = () => SYSTEM_STILL.matches

/** A CSS time (`240ms`, `0.2s`) in milliseconds. */
const milliseconds = (time: string) =>
  time.trim().endsWith('ms') ? Number.parseFloat(time) : Number.parseFloat(time) * 1000

/**
 * The duration and curve of a named motion, for the Web Animations API. They are read from the
 * document when asked for, so the stylesheet stays the one place a number is written.
 */
export function timing(name: MotionName) {
  const styles = getComputedStyle(document.documentElement)
  const { duration, easing } = MOTION[name]
  return {
    duration: milliseconds(styles.getPropertyValue(duration)),
    easing: styles.getPropertyValue(easing).trim(),
  }
}

/**
 * Whether a click came from the keyboard. Enter or Space on a button arrives as a click with no
 * pointer behind it (`detail` counts pointer presses, and is 0). What the keyboard does happens
 * at once: someone moving that fast is not watching it happen.
 */
export const byKeyboard = (event: { readonly detail: number }) => event.detail === 0

/**
 * Makes one change with every transition off, for a change made from the keyboard. Transitions
 * come back two frames later: one for the change to be drawn, one so none of it is caught
 * half-way.
 */
export function instantly(change: () => void) {
  const root = document.documentElement
  root.dataset.motion = 'off'
  change()
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      delete root.dataset.motion
    }),
  )
}

const leaving = new WeakSet<Element>()

/** How long an element that was played out may stay in the document before it is shown again. */
const STAYED_AFTER_MS = 250

/**
 * Plays something off the screen, then says it is gone. It is for a surface the Person sends away
 * (a click outside a menu, Escape on a dialog, "done" on a row): React would remove it at once,
 * so whoever closes it waits for this first.
 *
 * It fades and gives 2% of its size, from wherever it is now, so closing a menu that is still
 * opening does not jump. `how: 'fade'` is for what fills the window (a scrim): shrinking that
 * would show the page round its edges. Under reduced motion everything only fades. Asked twice
 * of one element, the second call returns at once: the first is already on its way.
 *
 * This describes the leaving; whoever closes the surface starts it (`act` in `data/app.ts`), and
 * the animation begins in that same turn.
 */
export function leave(
  element: Element,
  name: 'exit' | 'popExit',
  how: 'shrink' | 'fade' = 'shrink',
) {
  return Effect.gen(function* () {
    if (leaving.has(element)) return
    leaving.add(element)
    const end = still() || how === 'fade' ? { opacity: GONE.opacity } : GONE
    // `forwards` holds the last frame until React takes the element out, so it cannot flash back.
    const playing = element.animate([end], { ...timing(name), fill: 'forwards' })
    // A cancelled animation rejects; the surface is still to be closed, so either way it is over.
    yield* Effect.promise(() => playing.finished.catch(() => undefined))
    // Whoever asked now takes the element out. If it is still here a moment later (the server
    // refused, the owner chose to keep it open) it must not stay invisible: it is put back.
    setTimeout(() => {
      if (!element.isConnected) return
      playing.cancel()
      leaving.delete(element)
    }, STAYED_AFTER_MS)
  })
}

/**
 * Moves a mark from where it was to where it now is: the thumb of a segmented control, a
 * highlight. The mark is already drawn in its new place; this plays it from the old one, as a
 * transform, so nothing is laid out again while it travels.
 */
export function slide(mark: Element, from: DOMRect) {
  if (still()) return
  const to = mark.getBoundingClientRect()
  if (to.width === 0 || from.width === 0) return
  const start = {
    translate: `${from.left - to.left}px ${from.top - to.top}px`,
    scale: `${from.width / to.width} ${from.height / to.height}`,
  }
  // `opacity` is held at 1 for the journey: the mark may belong to an option React has not yet
  // drawn as chosen, and it must be seen from the first frame of the click.
  const at = { transformOrigin: '0 0', opacity: 1 }
  mark.animate(
    [
      { ...start, ...at },
      { translate: '0 0', scale: '1 1', ...at },
    ],
    timing('slide'),
  )
}
