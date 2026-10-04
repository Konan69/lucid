import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * Draws what floats over the page at the end of the document instead of inside whatever asked
 * for it.
 *
 * A dialog opened from a row in the sidebar used to be drawn inside the sidebar's scrolling list,
 * and that list fades its edges with a mask. A mask clips everything drawn inside it, `fixed` or
 * not, so the dialog appeared as a dimmed strip the width of the sidebar with its buttons cut
 * off. Anything that covers the page belongs to the page.
 */
export function Layer({ children }: { children: ReactNode }) {
  return createPortal(children, document.body)
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

let floating = 0
const watchers = new Set<() => void>()
const changed = (by: 1 | -1) => {
  floating += by
  for (const watcher of watchers) watcher()
}

/**
 * Whether a floating surface is open: a dialog, Settings, a menu, the palette, notifications.
 *
 * It exists for what cannot be drawn under them. The desktop app lays a native page over part of
 * the window, above everything the document draws, so that page has to step aside while a surface
 * is open and come back when it closes. It used to look for one in the document and to hear of
 * changes only among the children of `body`, and Settings is drawn inside the app's own tree: the
 * page never heard Settings close and stayed blank. Every surface already takes the keyboard
 * through `holdFocus`, so that is where they are counted, and nothing has to be looked for.
 */
export const floatingSurfaces = {
  open: () => floating > 0,
  subscribe: (watcher: () => void) => {
    watchers.add(watcher)
    return () => {
      watchers.delete(watcher)
    }
  },
}

/**
 * Takes the keyboard for a floating surface when it opens and gives it back to whatever had it
 * when the surface closes. A field inside that asked for focus keeps it. The surface counts as
 * open for as long as it is in the document; see `floatingSurfaces`.
 */
export function holdFocus(surface: HTMLElement | null) {
  const before = document.activeElement
  if (surface === null) return undefined
  if (!surface.contains(before)) surface.focus()
  changed(1)
  return () => {
    changed(-1)
    if (before instanceof HTMLElement && before.isConnected) before.focus()
  }
}

/**
 * Counts a surface that Base UI floats (a dialog, a menu, a popover, a select) for as long as it
 * is in the document. Base UI takes the keyboard and gives it back itself, so unlike `holdFocus`
 * this only counts; see `floatingSurfaces` for who is listening.
 */
export function countSurface(surface: HTMLElement | null) {
  if (surface === null) return undefined
  changed(1)
  return () => {
    changed(-1)
  }
}

/**
 * For a floating surface whose owner draws it only while it is wanted (`{renaming && <Rename />}`).
 *
 * Base UI plays a surface out when `open` turns false, and it cannot do that for one that has
 * already left the document. So the surface is open from its first render, closes itself when it
 * is sent away (Escape, a click outside, its close button), and its owner is told only once it
 * has finished leaving. Spread the result on the root: `<Dialog {...useSurface(onClose)}>`.
 * A button that completes the task calls `onClose` itself, at once: the result is what the Person
 * wants next, not the dialog's exit.
 */
export function useSurface(onClose: () => void) {
  const [open, setOpen] = useState(true)
  // What had the keyboard when the surface was drawn. Base UI gives focus back to a surface's
  // trigger, and a surface that is drawn already open has none, so it is given back here.
  const [before] = useState(() => document.activeElement)
  return {
    open,
    onOpenChange: (next: boolean) => {
      setOpen(next)
    },
    onOpenChangeComplete: (next: boolean) => {
      if (next) return
      onClose()
      if (before instanceof HTMLElement && before.isConnected) before.focus()
    },
  }
}

/** Keeps Tab inside a modal surface: past the last control comes the first, and the reverse. */
export function keepFocusInside(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== 'Tab') return
  const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE))
  const first = controls.at(0)
  const last = controls.at(-1)
  if (first === undefined || last === undefined) return
  const edge = event.shiftKey ? first : last
  if (document.activeElement !== edge && event.currentTarget !== document.activeElement) return
  event.preventDefault()
  const next = event.shiftKey ? last : first
  next.focus()
}
