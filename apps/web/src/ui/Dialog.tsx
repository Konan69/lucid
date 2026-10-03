import { useRef, type ReactNode } from 'react'
import { cn } from './cn'
import { holdFocus, keepFocusInside, Layer } from './Layer'
import { leave } from './motion'

const WIDTH = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-xl' } satisfies Record<string, string>

/**
 * A modal for one decision: name a Company, rename a Thread, confirm a deletion. It dims what is
 * behind it, closes on Escape or a click outside, and holds its content in a panel that looks like
 * every other raised surface in Vivid. It is deliberately not a general window: anything with
 * more than one decision in it belongs on a screen.
 *
 * It grows from just under its size as the page dims (`motion-dialog`); it is in the middle of
 * the window because nothing on the page opened onto it. Sent away by a click outside it fades
 * back out, faster, before its owner is told; Escape closes it at once, as the keyboard always does. A button inside it closes it at once: the
 * button giving under the hand is the answer there, and the result is what the Person wants next.
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
  const scrim = useRef<HTMLDivElement>(null)
  /** Plays the dialog out, the panel and the dimming together, then tells its owner. */
  const dismiss = () => {
    const dimming = scrim.current
    const panel = dimming === null ? null : dimming.firstElementChild
    if (dimming === null || panel === null) {
      onClose()
      return
    }
    void leave(panel, 'exit')
    void leave(dimming, 'exit', 'fade').then(onClose)
  }
  return (
    <Layer>
      <div
        ref={scrim}
        role="presentation"
        className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-scrim p-4 backdrop-blur-scrim"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) dismiss()
        }}
        onKeyDown={(event) => {
          // The keyboard is answered at once: Escape plays no exit.
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
            // Never taller than the window: a long form scrolls inside the panel, so its actions
            // cannot end up below the fold where the page itself does not scroll.
            'max-h-full w-full motion-dialog overflow-y-auto rounded-dialog bg-surface-3 p-6 lift-lg outline-none',
            WIDTH[width],
          )}
        >
          <h2 className="text-dialog font-title text-ink">{title}</h2>
          {description !== undefined && (
            <p className="mt-1 text-label font-meta text-ink-3">{description}</p>
          )}
          <div className="mt-5">{children}</div>
        </div>
      </div>
    </Layer>
  )
}

/** The row of actions that closes a dialog: the way out on the left of the thing it does. */
export function DialogActions({ children }: { children: ReactNode }) {
  return <div className="mt-6 flex justify-end gap-2">{children}</div>
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
        className="h-10 rounded-control bg-well px-3 text-body text-ink edge outline-none edge-field placeholder:text-ink-3 focus-visible:edge-accent"
      />
    </label>
  )
}
