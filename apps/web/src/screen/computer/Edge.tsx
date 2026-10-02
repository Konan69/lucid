import { useSyncExternalStore } from 'react'
import { split } from '../../data/split'

/** Pixels the divider moves for one arrow key. */
const STEP = 10

/**
 * The Computer's left edge, which is dragged to share the page with the Thread. It works like the
 * sidebar's: the pointer is captured so the edge follows the hand outside its thin hit area, the
 * width transition is switched off while dragging (or the edge would trail the pointer), what was
 * chosen is remembered when the hand lets go, and a double-click goes back to the starting width.
 * From the keyboard the arrows move it a step, and Home and End go to the narrowest and widest.
 *
 * The hit area is ten pixels wide and the line is one, so it is easy to catch and still reads as a
 * hairline.
 */
export function Edge() {
  const width = useSyncExternalStore(split.subscribe, split.width)
  const widest = useSyncExternalStore(split.subscribe, split.widest)
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the Computer"
      aria-valuemin={split.narrowest()}
      aria-valuemax={widest}
      aria-valuenow={width}
      title="Drag to resize. Double-click to reset."
      tabIndex={0}
      onPointerDown={(event) => {
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        document.documentElement.dataset.resizing = 'computer'
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
        const workspace = event.currentTarget.parentElement
        // The Computer is the right-hand column: its width is the distance from the pointer to the
        // right edge of the column's container.
        if (workspace !== null) split.widen(workspace.getBoundingClientRect().right - event.clientX)
      }}
      onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
      onLostPointerCapture={() => {
        delete document.documentElement.dataset.resizing
        split.keep()
      }}
      onDoubleClick={split.reset}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') split.nudge(STEP)
        else if (event.key === 'ArrowRight') split.nudge(-STEP)
        else if (event.key === 'Home') split.edge('minimum')
        else if (event.key === 'End') split.edge('maximum')
        else return
        event.preventDefault()
      }}
      className="computer-edge absolute inset-y-0 -left-1.25 z-10 w-2.5 cursor-col-resize touch-none transition-colors duration-(--dur-fast) outline-none hover:bg-wash-pressed focus-visible:bg-accent-soft"
    />
  )
}
