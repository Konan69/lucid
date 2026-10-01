import type { ReactNode } from 'react'
import { cn } from './cn'
import { holdFocus, keepFocusInside, Layer } from './Layer'

const WIDTH = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-xl' } satisfies Record<string, string>

/**
 * A modal for one decision: name a Company, rename a Thread, confirm a deletion. It dims what is
 * behind it, closes on Escape or a click outside, and holds its content in a panel that looks like
 * every other raised surface in Vivid. It is deliberately not a general window: anything with
 * more than one decision in it belongs on a screen.
 */
export function Dialog({
  title,
  description,
  width = 'sm',
  onClose,
  children,
}: {
  title: string
  description?: string
  width?: keyof typeof WIDTH
  onClose: () => void
  children: ReactNode
}) {
  return (
    <Layer>
      <div
        role="presentation"
        className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-scrim p-4 backdrop-blur-scrim"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose()
          keepFocusInside(event)
        }}
      >
        <div
          ref={holdFocus}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          tabIndex={-1}
          className={cn(
            'w-full animate-rise-in rounded-panel bg-surface-1 p-5 smooth-shadow-ring-lg outline-none',
            WIDTH[width],
          )}
        >
          <h2 className="text-dialog font-title text-ink">{title}</h2>
          {description !== undefined && (
            <p className="mt-1 text-label font-meta text-ink-3">{description}</p>
          )}
          <div className="mt-4">{children}</div>
        </div>
      </div>
    </Layer>
  )
}

/** The row of actions that closes a dialog: the way out on the left of the thing it does. */
export function DialogActions({ children }: { children: ReactNode }) {
  return <div className="mt-5 flex justify-end gap-2">{children}</div>
}

/** The single text field most dialogs are made of. */
export function DialogField({
  label,
  value,
  onChange,
  placeholder,
  maxLength = 120,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  maxLength?: number
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-label text-ink-2">{label}</span>
      <input
        required
        // A dialog exists to take this one answer; the cursor belongs in it.
        // oxlint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(event) => onChange(event.currentTarget.value)}
        className="h-9 rounded-control bg-well px-3 text-body text-ink ring-line outline-none placeholder:text-ink-4 focus-visible:ring-2 focus-visible:ring-ring"
      />
    </label>
  )
}
