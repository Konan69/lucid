import { Option } from 'effect'

/**
 * Where Vivid's computer floats when it is popped out of the page: a window over the app that the
 * Person drags by its bar and resizes from its corner.
 *
 * The design is T3 Code's floating preview (`apps/web/src/previewMiniPlayerStore.ts` and
 * `components/preview/previewMiniPlayerLayout.ts`: `clampPreviewMiniPlayerSize`,
 * `clampPreviewMiniPlayerPosition`, `PREVIEW_MINI_PLAYER_EDGE_GAP`). Kept from it: the window
 * stays a fixed gap inside its room on every side, it stops at that gap with no give, a size is
 * fitted before a position, it opens at the top of the trailing side, and what was chosen lives in
 * memory for the session. Changed for Vivid: there is one computer and not one preview per
 * Thread, so there is one window and no key; the sizes are larger because this window carries a
 * bar and the line of control under the screen, where the reference's is a bare picture; and
 * there is no reserved space at the bottom, because nothing of Vivid's is pinned there.
 *
 * Like `data/split.ts` it is a store outside React: a drag writes the window's place on the
 * element itself and tells React once, when the hand lets go.
 */

/** A width and a height, in CSS pixels. */
export interface Size {
  readonly width: number
  readonly height: number
}

/** The window: where its top-left corner is inside the room, and how large it is. */
export interface Box extends Size {
  readonly x: number
  readonly y: number
}

/** The room kept between the window and each side of the page (the reference's 12). */
const GAP = 12
/** Smaller than this the bar's controls and a readable screen do not both fit. */
const SMALLEST: Size = { width: 320, height: 280 }
/** How large it opens: a 16:10 screen at 456 wide, under the bar and over the line of control. */
const USUAL: Size = { width: 480, height: 420 }

const between = (value: number, least: number, most: number) =>
  Math.min(Math.max(value, least), Math.max(least, most))

/**
 * The size the window may have in a room: no smaller than `SMALLEST`, no larger than the room
 * less the gap on both sides. A room smaller than the smallest window wins, so the window never
 * hangs off the page.
 */
export const sizeWithin = (size: Size, room: Size): Size => {
  const widest = Math.max(1, room.width - GAP * 2)
  const tallest = Math.max(1, room.height - GAP * 2)
  return {
    width: Math.round(Math.min(Math.max(SMALLEST.width, size.width), widest)),
    height: Math.round(Math.min(Math.max(SMALLEST.height, size.height), tallest)),
  }
}

/** The window fitted to a room: sized first, then moved until all of it is inside the gap. */
export const boxWithin = (box: Box, room: Size): Box => {
  const size = sizeWithin(box, room)
  return {
    ...size,
    x: Math.round(between(box.x, GAP, room.width - size.width - GAP)),
    y: Math.round(between(box.y, GAP, room.height - size.height - GAP)),
  }
}

/** Where it opens the first time: the usual size, at the top of the room's right-hand side. */
const opening = (room: Size): Box => boxWithin({ ...USUAL, x: room.width, y: GAP }, room)

const same = (one: Box, other: Box) =>
  one.x === other.x && one.y === other.y && one.width === other.width && one.height === other.height

const listeners = new Set<() => void>()
let floating = false
/** What the Person last chose by dragging; nothing until they have. */
let chosen: Option.Option<Box> = Option.none()
/** The page the window floats over, as last measured. */
let room: Size = { width: 0, height: 0 }
/** What is drawn: the choice, or the opening place, fitted to the room as it is now. */
let shown: Box = opening(room)

const tell = () => {
  for (const listener of listeners) listener()
}

/** Fits what was chosen to the room there is, and tells whoever draws it when that moved it. */
const fit = () => {
  const next = Option.match(chosen, {
    onNone: () => opening(room),
    onSome: (box) => boxWithin(box, room),
  })
  if (same(next, shown)) return
  shown = next
  tell()
}

const setFloating = (next: boolean) => {
  if (next === floating) return
  floating = next
  tell()
}

export const place = {
  subscribe: (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  /** Whether the Person popped the computer out of the page. */
  isFloating: () => floating,
  float: () => setFloating(true),
  dock: () => setFloating(false),
  /** The window as drawn. The same object until it changes, so React can compare it. */
  box: () => shown,
  /** The page the window floats over, for a drag to stay inside. */
  room: () => room,
  /** Remembers where a drag or a resize left the window. */
  keep: (box: Box) => {
    chosen = Option.some(boxWithin(box, room))
    fit()
  },
  /**
   * Follows the page the window floats over, so a smaller browser window or an opened sidebar
   * brings the floating window back inside instead of leaving it off the page. Called from the
   * panel's ref, which returns this cleanup.
   */
  attach: (element: HTMLElement) => {
    const parent = element.parentElement
    if (parent === null) return () => undefined
    const measure = () => {
      room = { width: parent.clientWidth, height: parent.clientHeight }
      fit()
    }
    const observer = new ResizeObserver(measure)
    observer.observe(parent)
    measure()
    return () => observer.disconnect()
  },
}
