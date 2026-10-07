import { Option, Schema } from 'effect'
import { kept } from './kept'

/**
 * How the Computer shares the page with the Thread. The Person drags the divider, and what they
 * chose is remembered as a position inside the room there is (0 is the narrowest the Computer may
 * be, 1 the widest), not as pixels: a smaller window or a hidden sidebar keeps the same feel
 * instead of restoring a width that no longer fits.
 *
 * Like the sidebar's width this is a store outside React, so the divider can move it on every
 * pointer event without a render. The width reaches the layout as `--computer-w` on the document,
 * the same way the sidebar's does.
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

let position = Option.flatMap(kept.read(key), (value) => readPosition(Number(value)))
let full = false
let width = USUAL
/** The room the Computer and the Thread share: the page beside the sidebar. */
let available = 0
const listeners = new Set<() => void>()

/** The widest the Computer may be right now, and the narrowest. */
const bounds = () => ({
  minimum: NARROWEST,
  maximum: Math.max(NARROWEST, available - READING),
})

/** Whether the room can hold both at their minimums; if not, the Computer takes the whole page. */
const roomForBoth = () => available >= NARROWEST + READING

/** Applies the remembered position to the room there is, and tells whoever draws it. */
const fit = () => {
  const { minimum, maximum } = bounds()
  width = Math.round(
    Option.match(position, {
      onNone: () => Math.min(maximum, USUAL),
      onSome: (value) => minimum + value * (maximum - minimum),
    }),
  )
  document.documentElement.style.setProperty('--computer-w', `${width}px`)
  for (const listener of listeners) listener()
}

/** Sets the width to where the pointer is, within bounds. Nothing is remembered until it is let go. */
const widen = (to: number) => {
  const { minimum, maximum } = bounds()
  const next = Math.min(maximum, Math.max(minimum, to))
  position = Option.some(maximum === minimum ? 0 : (next - minimum) / (maximum - minimum))
  fit()
}

const keep = () => {
  Option.map(position, (value) => kept.write(key, String(value)))
}

export const split = {
  subscribe: (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  width: () => width,
  /** The widest the Computer can be, so the divider can say how far it may move. */
  widest: () => bounds().maximum,
  narrowest: () => NARROWEST,
  /** Whether the Computer has the whole page: the Person asked, or there is no room for both. */
  isFull: () => full || !roomForBoth(),
  /** Whether full view is a choice. With no room for a split it is the only view. */
  canSplit: roomForBoth,
  /**
   * Follows the room beside the sidebar. It observes the Computer's own container instead of
   * guessing from the window, so a sidebar opening or being dragged is the same as a resize. Called
   * from a ref, which returns this cleanup.
   */
  attach: (element: HTMLElement | null) => {
    const parent = element === null ? null : element.parentElement
    if (parent === null) return undefined
    const measure = () => {
      available = parent.getBoundingClientRect().width
      fit()
    }
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
    widen(width + by)
    keep()
  },
  /** Jumps the divider to its narrowest or widest, and remembers it. */
  edge: (end: 'minimum' | 'maximum') => {
    widen(bounds()[end])
    keep()
  },
  /** Back to where the divider starts. */
  reset: () => {
    position = Option.none()
    kept.remove(key)
    fit()
  },
  /** Full view and back; the split chosen before is kept and returns on the way out. */
  toggleFull: () => {
    full = !split.isFull()
    fit()
  },
}
