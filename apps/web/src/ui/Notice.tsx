import type { ReactNode } from 'react'

/**
 * One sentence about something that did not work, in the place it happened. `role="alert"` has a
 * screen reader say it when it appears, which is why this is an element in the page and never a
 * browser alert: the Person keeps what they were doing.
 */
export function Notice({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-control bg-danger-soft px-3 py-2 text-label text-danger">
      {children}
    </p>
  )
}
