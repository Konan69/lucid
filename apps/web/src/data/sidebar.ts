import { Option } from 'effect'
import { create } from 'zustand'
import { instantly } from '../ui/motion'
import { kept } from './kept'

/**
 * Whether the sidebar is showing, and how wide it is. A Zustand store, as T3 Code web keeps its
 * interface state (`apps/web/src/rightPanelStore.ts`), changed by plain functions (`sidebar`
 * below) so the keyboard shortcut can live at module scope rather than in an effect.
 *
 * It is two different things by width. On a wide window it is a column beside the page, and
 * hiding it is a preference: a Person who hides it means it, so it is remembered between visits.
 * On a narrow one there is no room beside the page, so it is a drawer over it: closed until asked
 * for, closed again as soon as the Person goes somewhere, and never remembered.
 *
 * What is remembered is read from the browser once, when the store is made, and written by the
 * function that changes it, under the names and in the words it always was (`vivid.sidebar` is
 * `shown` or `hidden`, `vivid.sidebar.width` is a number of pixels).
 */

const key = 'vivid.sidebar'
const widthKey = 'vivid.sidebar.width'
const wide = matchMedia('(min-width: 48rem)')

/** Narrower than this, a Thread's title and time no longer fit on a row. */
const NARROWEST = 208
const USUAL = 268
/** What is always left for the page: a full line of reading and the composer. */
const READING = 640

interface Sidebar {
  /** Whether the window is wide enough for a column. Follows `wide`, so a selector can read it. */
  readonly wide: boolean
  /** The column beside the page is showing. The Person's preference, remembered. */
  readonly pinned: boolean
  /** The drawer over the page is out. Never remembered. */
  readonly drawn: boolean
  /** The width asked for, in pixels. What is drawn is `fitting`, this within what the window allows. */
  readonly wanted: number
}

export const useSidebar = create<Sidebar>()(() => ({
  wide: wide.matches,
  pinned: !Option.contains(kept.read(key), 'hidden'),
  drawn: false,
  wanted: Option.getOrElse(
    Option.filter(Option.map(kept.read(widthKey), Number), (width) => width >= NARROWEST),
    () => USUAL,
  ),
}))

/** Whether the sidebar is showing: the column on a wide window, the drawer on a narrow one. */
export const sidebarShown = (state: Sidebar) => (state.wide ? state.pinned : state.drawn)

const set = (open: boolean) => {
  if (wide.matches) {
    useSidebar.setState({ pinned: open })
    kept.write(key, open ? 'shown' : 'hidden')
  } else {
    useSidebar.setState({ drawn: open })
  }
}

// ── Width ────────────────────────────────────────────────────────────────────
// How wide the column is, is the Person's to choose: long shared Thread titles want room on a
// large display, and a small window wants it back. The choice is remembered, and never allowed
// to squeeze the page beside it below a readable column.

/** Asks for a width. Nothing is drawn or remembered by this alone. */
const want = (wanted: number) => useSidebar.setState({ wanted })

/** The width that can be had right now: what was asked for, within what the window allows. */
const fitting = () =>
  Math.round(
    Math.min(
      Math.max(useSidebar.getState().wanted, NARROWEST),
      Math.max(NARROWEST, innerWidth - READING),
    ),
  )

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
    want(to)
    applyWidth()
  },
  /** Nudges the width from the keyboard, and remembers it. */
  nudge: (by: number) => {
    want(fitting() + by)
    applyWidth()
    kept.write(widthKey, String(fitting()))
  },
  /** Remembers the width as it now stands. */
  keepWidth: () => {
    want(fitting())
    kept.write(widthKey, String(useSidebar.getState().wanted))
  },
  /** Back to the width Vivid starts with. */
  usualWidth: () => {
    want(USUAL)
    applyWidth()
    kept.remove(widthKey)
  },
  toggle: () => set(!sidebarShown(useSidebar.getState())),
  show: () => set(true),
  hide: () => set(false),
  /**
   * Puts the drawer away once something in it has been chosen. A column beside the page stays:
   * hiding that is a preference, and choosing something in it is not asking for it to go.
   */
  tuck: () => {
    if (!wide.matches && useSidebar.getState().drawn) set(false)
  },
}

// Crossing the width changes which of the two it is, so whoever draws it must look again.
wide.addEventListener('change', () => {
  useSidebar.setState({ wide: wide.matches, drawn: false })
  applyWidth()
})

// ⌘B / Ctrl+B toggles the sidebar, the shortcut every editor-shaped app has trained people on.
// From the keyboard it is there or gone at once: the button slides it, because a hand on the
// pointer is watching it go, and a hand on the keys is already on to the next thing.
addEventListener('keydown', (event) => {
  if (event.key.toLocaleLowerCase() !== 'b' || !(event.metaKey || event.ctrlKey)) return
  event.preventDefault()
  instantly(sidebar.toggle)
})
