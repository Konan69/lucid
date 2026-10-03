import { LiveState } from '@vivid/state'
import type { ReactNode } from 'react'
import { Notice } from '../../ui/Notice'

/** A titled group of settings in a raised panel. */
export function Section({
  title,
  detail,
  action,
  children,
}: {
  title: string
  detail?: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="mb-6">
      <div className="mb-2 flex items-end gap-3 px-1">
        <div className="min-w-0 flex-1">
          <h3 className="text-label font-title text-ink">{title}</h3>
          {detail !== undefined && <p className="text-label text-ink-3">{detail}</p>}
        </div>
        {action}
      </div>
      <div className="divide-y divide-line-1 overflow-hidden rounded-card bg-surface-3 smooth-shadow-ring-xs">
        {children}
      </div>
    </section>
  )
}

/** One setting: what it is on the left, the control on the right. */
export function Row({
  label,
  detail,
  children,
}: {
  label: ReactNode
  detail?: ReactNode
  children?: ReactNode
}) {
  return (
    // On a narrow window the control goes under what it controls: beside it, the explanation is
    // squeezed into a column a few words wide.
    <div className="flex min-h-14 flex-col gap-2 px-4 py-2.5 sm:flex-row sm:items-center sm:gap-4">
      <div className="min-w-0 flex-1">
        <div className="truncate text-label text-ink">{label}</div>
        {detail !== undefined && <div className="text-label text-pretty text-ink-3">{detail}</div>}
      </div>
      {children !== undefined && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  )
}

/** The sentence a section shows when there is nothing in it yet. */
export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-6 text-center text-label text-ink-3">{children}</p>
}

/** A refusal from the server, said once, under the thing that was refused. */
export function Refusal({ message }: { message: string | null }) {
  if (message === null) return null
  return (
    <p
      role="alert"
      className="mb-3 rounded-control bg-danger-soft px-3 py-2 text-label text-danger"
    >
      {message}
    </p>
  )
}

/**
 * What a section draws before its data is `Ready`: its own outline while the first result is on
 * its way, or the server's sentence when the Person may not see it. The outline is still, and it is
 * the shape of what is coming, so the pane never sits blank and never jumps when the rows arrive.
 */
export function Awaiting<Value>({ state }: { state: LiveState<Value> }) {
  return LiveState.$match(state, {
    Ready: () => null,
    Failed: ({ failure }) => <Notice>{failure.message}</Notice>,
    Loading: () => (
      <div aria-hidden className="mb-6">
        <div className="mb-2 flex flex-col gap-1.5 p-1">
          <i className="h-3 w-24 rounded-full bg-wash-hover" />
          <i className="h-3 w-64 rounded-full bg-wash-hover" />
        </div>
        <div className="divide-y divide-line-1 rounded-card bg-surface-3 smooth-shadow-ring-xs">
          {['w-40', 'w-56', 'w-32'].map((width) => (
            <div key={width} className="flex h-14 items-center px-4">
              <i className={`h-3 rounded-full bg-wash-hover ${width}`} />
            </div>
          ))}
        </div>
      </div>
    ),
  })
}
