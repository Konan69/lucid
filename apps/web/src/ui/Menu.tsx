import type { KeyboardEvent, ReactNode } from 'react'
import { cn } from './cn'

const SIDE = {
  below: 'top-full mt-1 left-0',
  'below-end': 'top-full mt-1 right-0',
  above: 'bottom-full mb-1 left-0',
} satisfies Record<string, string>

const PLATE = 'z-50 min-w-56 animate-rise-in rounded-panel p-1 smooth-shadow-ring-lg glass'

/**
 * Moves through a menu's choices with the arrow keys and leaves it with Escape. The choices are
 * read from the menu as it is on screen, so a menu never has to register its items.
 */
function steer(event: KeyboardEvent<HTMLDivElement>, onClose: () => void) {
  if (event.key === 'Escape') {
    onClose()
    return
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  event.preventDefault()
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'))
  const at = items.findIndex((item) => item === document.activeElement)
  const step = event.key === 'ArrowDown' ? 1 : -1
  const next = items[(at + step + items.length) % items.length]
  if (next !== undefined) next.focus()
}

/** The layer under an open menu: a click anywhere else, with either button, closes it. */
function Backdrop({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      aria-label="Close"
      tabIndex={-1}
      onClick={onClose}
      onContextMenu={(event) => {
        event.preventDefault()
        onClose()
      }}
      className="fixed inset-0 z-40 cursor-default"
    />
  )
}

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
      <Backdrop onClose={onClose} />
      <div
        role="menu"
        onKeyDown={(event) => steer(event, onClose)}
        className={cn('absolute', PLATE, SIDE[side], className)}
      >
        {children}
      </div>
    </>
  )
}

/** Where a pointer asked for a menu, in viewport pixels. */
export interface MenuPoint {
  readonly x: number
  readonly y: number
}

/** Takes the keyboard when a context menu opens, so the arrow keys and Escape work at once. */
const takeFocus = (menu: HTMLDivElement | null) => {
  if (menu !== null) menu.focus()
}

/**
 * The menu a right-click (or the keyboard's menu key) asks for, where it was asked for.
 *
 * It hangs from whichever corner keeps it on screen: asked for in the lower half it opens upward,
 * in the right half leftward. Nothing is measured, so it is in the right place on its first paint.
 */
export function ContextMenu({
  at,
  onClose,
  children,
}: {
  at: MenuPoint
  onClose: () => void
  children: ReactNode
}) {
  const leftward = at.x > window.innerWidth / 2
  const upward = at.y > window.innerHeight / 2
  // SAFETY: React forwards these CSS custom properties to the element; the classes below name
  // the edges they are read by, so the values are only ever the pointer's own pixels.
  const menuStyle = {
    '--menu-x': `${leftward ? window.innerWidth - at.x : at.x}px`,
    '--menu-y': `${upward ? window.innerHeight - at.y : at.y}px`,
  } as React.CSSProperties
  return (
    <>
      <Backdrop onClose={onClose} />
      <div
        ref={takeFocus}
        role="menu"
        tabIndex={-1}
        onKeyDown={(event) => steer(event, onClose)}
        style={menuStyle}
        className={cn(
          'fixed outline-none',
          leftward ? 'right-(--menu-x)' : 'left-(--menu-x)',
          upward ? 'bottom-(--menu-y)' : 'top-(--menu-y)',
          PLATE,
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
          : 'text-ink-2 hover:bg-wash-hover hover:text-ink focus-visible:bg-wash-hover focus-visible:text-ink',
        selected && 'text-ink',
      )}
    >
      {icon !== undefined && (
        <span className="inline-flex size-4 shrink-0 items-center justify-center">{icon}</span>
      )}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint !== undefined && <span className="text-meta font-meta text-ink-3">{hint}</span>}
    </button>
  )
}

/** A hairline between groups of choices. */
export function MenuDivider() {
  return <div role="separator" className="m-1 h-px bg-line-2" />
}

/** A quiet label above a group of choices. */
export function MenuLabel({ children }: { children: ReactNode }) {
  return <p className="px-2.5 pt-1.5 pb-1 text-meta font-meta text-ink-3">{children}</p>
}
