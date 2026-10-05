import { Option } from 'effect'
import type { KeyboardEvent, PointerEvent } from 'react'
import { boxWithin, place, type Box } from './place'

/**
 * The hand on the popped-out computer: dragging it by its bar and resizing it from its corner.
 *
 * Ported from T3 Code's floating preview (`apps/web/src/components/preview/
 * ThreadPreviewMiniPlayer.tsx`: `handlePointerDown`, `handlePointerMove`, `endDrag`,
 * `handleResizePointerDown`, `handleResizePointerMove`, `endResize`). Kept: the pointer is
 * captured so the window follows the hand outside the bar, only the main button starts it, a
 * press on a control in the bar is that control's and never a drag, every move is fitted to the
 * room before it is drawn, and a resize is fitted as a size and then as a position.
 *
 * Changed for Vivid: the reference writes each move to its store and lets React lay the window
 * out with `left` and `top`. Here a move is written on the element and drawn as `translate`,
 * which moves the window without laying anything out, and React hears once, when the hand lets
 * go. A resize does change `width` and `height`; a resize is a layout whatever writes it.
 */

/** A drag in progress: the pointer that started it, where it started, and the window so far. */
interface Reach {
  readonly pointer: number
  readonly x: number
  readonly y: number
  readonly from: Box
  readonly last: Box
}

/** There is one window and one pointer on it at a time, so one reach is all there is. */
let reach: Option.Option<Reach> = Option.none()

/** What a drag does to the window it started from, given how far the pointer has gone. */
type Change = (from: Box, right: number, down: number) => Box
const moved: Change = (from, right, down) => ({ ...from, x: from.x + right, y: from.y + down })
const sized: Change = (from, right, down) => ({
  ...from,
  width: from.width + right,
  height: from.height + down,
})

/** Things in the bar that take a press themselves. */
const CONTROLS = 'button, input, a, [role="tab"], [role="radio"], [role="menuitem"]'

/** The floating window an element is in; nothing when the computer is not popped out. */
const windowOf = (element: Element) => element.closest<HTMLElement>('[data-view="popout"]')

/**
 * Puts the window where a drag has it, on the element, without waiting for React. These are the
 * same four properties the panel sets when it renders; they are registered as not inherited
 * (`styles/index.css`), so a move restyles the window alone and nothing inside it.
 */
const draw = (floated: HTMLElement, box: Box) => {
  floated.style.setProperty('--float-x', `${box.x}px`)
  floated.style.setProperty('--float-y', `${box.y}px`)
  floated.style.setProperty('--float-w', `${box.width}px`)
  floated.style.setProperty('--float-h', `${box.height}px`)
}

/** The pointer handlers for one kind of drag. Spread onto the element the hand takes hold of. */
const handlers = (change: Change) => ({
  onPointerDown: (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || windowOf(event.currentTarget) === null) return
    // A second finger does not take the window from the first.
    if (Option.isSome(reach)) return
    if (event.target instanceof Element && event.target !== event.currentTarget) {
      // A press on a tab, a view or the close button is theirs.
      const control = event.target.closest(CONTROLS)
      if (control !== null && control !== event.currentTarget) return
    }
    const from = place.box()
    reach = Option.some({
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      from,
      last: from,
    })
    event.currentTarget.setPointerCapture(event.pointerId)
    // The same switch the divider uses, so no width transition trails the hand. The capture
    // above is what keeps the moves from the screen under the pointer.
    document.documentElement.dataset.resizing = 'computer'
    event.preventDefault()
  },
  onPointerMove: (event: PointerEvent<HTMLElement>) => {
    const floated = windowOf(event.currentTarget)
    if (Option.isNone(reach) || reach.value.pointer !== event.pointerId || floated === null) return
    const { from, x, y } = reach.value
    const last = boxWithin(change(from, event.clientX - x, event.clientY - y), place.room())
    reach = Option.some({ ...reach.value, last })
    draw(floated, last)
  },
  onPointerUp: (event: PointerEvent<HTMLElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  },
  // Letting go, a cancelled touch and a capture taken away all end here, so what was reached is
  // always remembered and the switch is always put back.
  onLostPointerCapture: () => {
    delete document.documentElement.dataset.resizing
    Option.map(reach, (ended) => place.keep(ended.last))
    reach = Option.none()
  },
})

/** Spread on the panel's bar: popped out, the bar is what the window is dragged by. */
export const grip = handlers(moved)

const corner = handlers(sized)

/** Pixels the corner moves for one arrow key. */
const STEP = 16

const STEPS = new Map([
  ['ArrowRight', { right: STEP, down: 0 }],
  ['ArrowLeft', { right: -STEP, down: 0 }],
  ['ArrowDown', { right: 0, down: STEP }],
  ['ArrowUp', { right: 0, down: -STEP }],
])

/** Resizes from the keyboard: the arrows grow and shrink the window a step at a time. */
const nudge = (event: KeyboardEvent<HTMLElement>) => {
  const by = STEPS.get(event.key)
  if (by === undefined) return
  event.preventDefault()
  place.keep(sized(place.box(), by.right, by.down))
}

/**
 * The corner the popped-out window is resized from. It is a button so the keyboard reaches it,
 * and its mark is the two short lines a window's corner has always had (the reference draws the
 * same mark: `after:border-b after:border-r`). It is 16 px square, which stops short of the
 * control at the end of the line under the screen.
 */
export function Corner() {
  return (
    <button
      type="button"
      aria-label="Resize. Arrow keys change the size."
      {...corner}
      onKeyDown={nudge}
      className="absolute right-0 bottom-0 z-10 size-4 cursor-nwse-resize touch-none rounded-br-panel opacity-50 transition-opacity duration-(--dur-fast) outline-none after:absolute after:right-1 after:bottom-1 after:size-2 after:border-r after:border-b after:border-ink-on-color hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
    />
  )
}
