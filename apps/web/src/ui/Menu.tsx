import type { ReactNode } from 'react'
import { cn } from './cn'

const SIDE = {
  below: 'top-full mt-1 left-0',
  'below-end': 'top-full mt-1 right-0',
  above: 'bottom-full mb-1 left-0',
} satisfies Record<string, string>

/**
 * A small floating list anchored to the thing that opened it. Whoever renders it owns whether it
 * is open; a click anywhere else closes it, through a backdrop that covers the page, so there is
 * no document listener to add and remove.
 */
export function Menu({
  open,
  onClose,
  side = 'below',
  className,
  children,
}: {
  open: boolean
  onClose: () => void
  side?: keyof typeof SIDE
  className?: string
  children: ReactNode
}) {
  if (!open) return null
  return (
    <>
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        onClick={onClose}
        className="fixed inset-0 z-40 cursor-default"
      />
      <div
        role="menu"
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose()
        }}
        className={cn(
          'absolute z-50 min-w-56 animate-rise-in rounded-panel p-1 smooth-shadow-ring-lg glass',
          SIDE[side],
          className,
        )}
      >
        {children}
      </div>
    </>
  )
}

/** One choice in a menu. `tone` marks the one that cannot be undone. */
export function MenuItem({
  icon,
  children,
  hint,
  tone = 'plain',
  selected = false,
  onSelect,
}: {
  icon?: ReactNode
  children: ReactNode
  hint?: ReactNode
  tone?: 'plain' | 'danger'
  selected?: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className={cn(
        'flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-row px-2.5 text-left text-label transition-colors duration-(--dur-fast) outline-none select-none',
        tone === 'danger'
          ? 'text-danger hover:bg-danger-soft focus-visible:bg-danger-soft'
          : 'text-ink-2 hover:bg-wash-hover hover:text-ink focus-visible:bg-wash-hover',
        selected && 'text-ink',
      )}
    >
      {icon !== undefined && (
        <span className="inline-flex size-4 shrink-0 items-center justify-center">{icon}</span>
      )}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint !== undefined && <span className="text-meta font-meta text-ink-4">{hint}</span>}
    </button>
  )
}

/** A hairline between groups of choices. */
export function MenuDivider() {
  return <div role="separator" className="h-px bg-line-2 m-1" />
}

/** A quiet label above a group of choices. */
export function MenuLabel({ children }: { children: ReactNode }) {
  return <p className="px-2.5 pt-1.5 pb-1 text-meta font-meta text-ink-4">{children}</p>
}
