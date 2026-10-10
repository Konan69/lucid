import { Option } from 'effect'
import { create } from 'zustand'

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
 * Like the reference and `data/split.ts` it is a Zustand store. A drag writes the window's place
 * on the element itself and changes the store once, when the hand lets go.
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

interface Place {
  /** Whether the Person popped the computer out of the page. */
  readonly floating: boolean
  /** What the Person last chose by dragging; nothing until they have. */
  readonly chosen: Option.Option<Box>
  /** The page the window floats over, as last measured. */
  readonly room: Size
}

export const usePlace = create<Place>()(() => ({
  floating: false,
  chosen: Option.none(),
  room: { width: 0, height: 0 },
}))

/**
 * The window as drawn: the choice, or the opening place, fitted to the room as it is now. It is
 * worked out each time and so is a new object each time; a screen reads it through `useShallow`,
 * which draws again only when one of its four numbers moved.
 */
export const placeBox = (state: Place): Box =>
  Option.match(state.chosen, {
    onNone: () => opening(state.room),
    onSome: (box) => boxWithin(box, state.room),
  })

export const place = {
  isFloating: () => usePlace.getState().floating,
  float: () => usePlace.setState({ floating: true }),
  dock: () => usePlace.setState({ floating: false }),
  /** The window as drawn, for a drag to start from. */
  box: () => placeBox(usePlace.getState()),
  /** The page the window floats over, for a drag to stay inside. */
  room: () => usePlace.getState().room,
  /** Remembers where a drag or a resize left the window. */
  keep: (box: Box) =>
    usePlace.setState((was) => ({ chosen: Option.some(boxWithin(box, was.room)) })),
  /**
   * Follows the page the window floats over, so a smaller browser window or an opened sidebar
   * brings the floating window back inside instead of leaving it off the page. Called from the
   * panel's ref, which returns this cleanup.
   */
  attach: (element: HTMLElement) => {
    const parent = element.parentElement
    if (parent === null) return () => undefined
    const measure = () =>
      usePlace.setState({ room: { width: parent.clientWidth, height: parent.clientHeight } })
    const observer = new ResizeObserver(measure)
    observer.observe(parent)
    measure()
    return () => observer.disconnect()
  },
}
