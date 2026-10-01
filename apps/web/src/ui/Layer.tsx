import type { KeyboardEvent, ReactNode } from 'react'
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

/**
 * Takes the keyboard for a floating surface when it opens and gives it back to whatever had it
 * when the surface closes. A field inside that asked for focus keeps it.
 */
export function holdFocus(surface: HTMLElement | null) {
  const before = document.activeElement
  if (surface !== null && !surface.contains(before)) surface.focus()
  return () => {
    if (before instanceof HTMLElement && before.isConnected) before.focus()
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
