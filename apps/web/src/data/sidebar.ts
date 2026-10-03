import { Option } from 'effect'
import { instantly } from '../ui/motion'
import { kept } from './kept'
import { router } from './route'

/**
 * Whether the sidebar is showing. Kept outside React as an external store so the keyboard
 * shortcut can live at module scope rather than in an effect.
 *
 * It is two different things by width. On a wide window it is a column beside the page, and
 * hiding it is a preference: a Person who hides it means it, so it is remembered between visits.
 * On a narrow one there is no room beside the page, so it is a drawer over it: closed until asked
 * for, closed again as soon as the Person goes somewhere, and never remembered.
 */

const key = 'vivid.sidebar'
const wide = matchMedia('(min-width: 48rem)')
let pinned = !Option.contains(kept.read(key), 'hidden')
let drawn = false
const listeners = new Set<() => void>()

const tell = () => {
  for (const listener of listeners) listener()
}

const set = (open: boolean) => {
  if (wide.matches) {
    pinned = open
    kept.write(key, open ? 'shown' : 'hidden')
  } else {
    drawn = open
  }
  tell()
}

// ── Width ────────────────────────────────────────────────────────────────────
// How wide the column is, is the Person's to choose: long shared Thread titles want room on a
// large display, and a small window wants it back. The choice is remembered, and never allowed
// to squeeze the page beside it below a readable column.

const widthKey = 'vivid.sidebar.width'
/** Narrower than this, a Thread's title and time no longer fit on a row. */
const NARROWEST = 208
const USUAL = 268
/** What is always left for the page: a full line of reading and the composer. */
const READING = 640

let wanted = Option.getOrElse(
  Option.filter(Option.map(kept.read(widthKey), Number), (width) => width >= NARROWEST),
  () => USUAL,
)

/** The width that can be had right now: what was asked for, within what the window allows. */
const fitting = () =>
  Math.round(Math.min(Math.max(wanted, NARROWEST), Math.max(NARROWEST, innerWidth - READING)))

// The width is a token (`--sidebar-w`); the choice overrides it on the document itself, so the
// column, its inner layout and anything else that reads the token agree without a render.
const applyWidth = () => {
  // A drawer on a narrow window keeps the width Vivid gives it: the choice is about a column.
  if (wide.matches) document.documentElement.style.setProperty('--sidebar-w', `${fitting()}px`)
  else document.documentElement.style.removeProperty('--sidebar-w')
}
applyWidth()
// A window made smaller takes room back from the sidebar; made larger, it gives the choice back.
addEventListener('resize', applyWidth)

export const sidebar = {
  /** Sets the width while the edge is being dragged. Nothing is remembered until it is let go. */
  widen: (to: number) => {
    wanted = to
    applyWidth()
  },
  /** Nudges the width from the keyboard, and remembers it. */
  nudge: (by: number) => {
    wanted = fitting() + by
    applyWidth()
    kept.write(widthKey, String(fitting()))
  },
  /** Remembers the width as it now stands. */
  keepWidth: () => {
    wanted = fitting()
    kept.write(widthKey, String(wanted))
  },
  /** Back to the width Vivid starts with. */
  usualWidth: () => {
    wanted = USUAL
    applyWidth()
    kept.remove(widthKey)
  },
  subscribe: (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  isOpen: () => (wide.matches ? pinned : drawn),
  toggle: () => set(!sidebar.isOpen()),
  show: () => set(true),
  hide: () => set(false),
  /**
   * Puts the drawer away once something in it has been chosen. A column beside the page stays:
   * hiding that is a preference, and choosing something in it is not asking for it to go.
   */
  tuck: () => {
    if (!wide.matches && drawn) set(false)
  },
}

// Crossing the width changes which of the two it is, so whoever draws it must look again.
wide.addEventListener('change', () => {
  drawn = false
  applyWidth()
  tell()
})

// A drawer has done its job once the Person has chosen where to go.
router.subscribe(sidebar.tuck)

// ⌘B / Ctrl+B toggles the sidebar, the shortcut every editor-shaped app has trained people on.
// From the keyboard it is there or gone at once: the button slides it, because a hand on the
// pointer is watching it go, and a hand on the keys is already on to the next thing.
addEventListener('keydown', (event) => {
  if (event.key.toLocaleLowerCase() !== 'b' || !(event.metaKey || event.ctrlKey)) return
  event.preventDefault()
  instantly(sidebar.toggle)
})
