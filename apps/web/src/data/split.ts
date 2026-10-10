import { Option, Schema } from 'effect'
import { create } from 'zustand'
import { kept } from './kept'

/**
 * How the Computer shares the page with the Thread. The Person drags the divider, and what they
 * chose is remembered as a position inside the room there is (0 is the narrowest the Computer may
 * be, 1 the widest), not as pixels: a smaller window or a hidden sidebar keeps the same feel
 * instead of restoring a width that no longer fits.
 *
 * Like the sidebar's width this is a Zustand store, as T3 Code web keeps its interface state
 * (`apps/web/src/rightPanelStore.ts`), so the divider can move it on every pointer event and only
 * what reads the width is drawn again. The width reaches the layout as `--computer-w` on the
 * document, the same way the sidebar's does. The position is read from the browser once, when the
 * store is made, and written only when the divider is let go (`keep`), as the number it always
 * was.
 */

/** Narrower than this a page or the computer's screen is not usable. */
const NARROWEST = 320
/** What the Thread always keeps: a line of reading and the composer under it. */
const READING = 352
/** Where the divider starts, when there is room. */
const USUAL = 600

const key = 'vivid.computer.split'
const Position = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
const readPosition = Schema.decodeUnknownOption(Position)

interface Split {
  /** Where the divider was put, inside the room there is. Nothing until the Person has moved it. */
  readonly position: Option.Option<number>
  /** The Person asked for the Computer to have the whole page. */
  readonly full: boolean
  /** The room the Computer and the Thread share: the page beside the sidebar. */
  readonly available: number
}

export const useSplit = create<Split>()(() => ({
  position: Option.flatMap(kept.read(key), (value) => readPosition(Number(value))),
  full: false,
  available: 0,
}))

/** The widest the Computer may be in this room, and the narrowest. */
const bounds = (state: Split) => ({
  minimum: NARROWEST,
  maximum: Math.max(NARROWEST, state.available - READING),
})

/** The widest the Computer can be, so the divider can say how far it may move. */
export const splitWidest = (state: Split) => bounds(state).maximum

/** Whether full view is a choice: the room can hold both at their minimums. If not, it is the only view. */
export const canSplit = (state: Split) => state.available >= NARROWEST + READING

/** Whether the Computer has the whole page: the Person asked, or there is no room for both. */
export const splitFull = (state: Split) => state.full || !canSplit(state)

/** The Computer's width: the remembered position applied to the room there is. */
export const splitWidth = (state: Split) => {
  const { minimum, maximum } = bounds(state)
  return Math.round(
    Option.match(state.position, {
      onNone: () => Math.min(maximum, USUAL),
      onSome: (value) => minimum + value * (maximum - minimum),
    }),
  )
}

// The width is a token (`--computer-w`) on the document, written each time the store changes, so
// the layout follows the divider without a render. Nothing is written before the room has been
// measured: until then the token keeps the value the stylesheet gives it.
useSplit.subscribe((state) =>
  document.documentElement.style.setProperty('--computer-w', `${splitWidth(state)}px`),
)

/** Sets the width to where the pointer is, within bounds. Nothing is remembered until it is let go. */
const widen = (to: number) => {
  const { minimum, maximum } = bounds(useSplit.getState())
  const next = Math.min(maximum, Math.max(minimum, to))
  useSplit.setState({
    position: Option.some(maximum === minimum ? 0 : (next - minimum) / (maximum - minimum)),
  })
}

const keep = () => {
  Option.map(useSplit.getState().position, (value) => kept.write(key, String(value)))
}

export const split = {
  narrowest: () => NARROWEST,
  /** The two a press reads at the moment it happens, where nothing is drawn from the answer. */
  isFull: () => splitFull(useSplit.getState()),
  canSplit: () => canSplit(useSplit.getState()),
  /**
   * Follows the room beside the sidebar. It observes the Computer's own container instead of
   * guessing from the window, so a sidebar opening or being dragged is the same as a resize. Called
   * from a ref, which returns this cleanup.
   */
  attach: (element: HTMLElement | null) => {
    const parent = element === null ? null : element.parentElement
    if (parent === null) return undefined
    const measure = () => useSplit.setState({ available: parent.getBoundingClientRect().width })
    const observer = new ResizeObserver(measure)
    observer.observe(parent)
    measure()
    return () => {
      observer.disconnect()
      delete document.documentElement.dataset.resizing
    }
  },
  widen,
  keep,
  /** Moves the divider from the keyboard, and remembers it. */
  nudge: (by: number) => {
    widen(splitWidth(useSplit.getState()) + by)
    keep()
  },
  /** Jumps the divider to its narrowest or widest, and remembers it. */
  edge: (end: 'minimum' | 'maximum') => {
    widen(bounds(useSplit.getState())[end])
    keep()
  },
  /** Back to where the divider starts. */
  reset: () => {
    useSplit.setState({ position: Option.none() })
    kept.remove(key)
  },
  /** Full view and back; the split chosen before is kept and returns on the way out. */
  toggleFull: () => {
    useSplit.setState((was) => ({ full: !splitFull(was) }))
  },
}
