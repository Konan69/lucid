import { useCallback, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { cn } from './cn'
import { holdFocus, Layer } from './Layer'
import { leave } from './motion'

/* Where a menu hangs, and the corner it grows from: the one nearest what opened it, so it reads
   as coming out of its trigger and not as arriving from the middle of nowhere. */
const SIDE = {
  below: 'top-full mt-1 left-0 origin-top-left',
  'below-end': 'top-full mt-1 right-0 origin-top-right',
  above: 'bottom-full mb-1 left-0 origin-bottom-left',
} satisfies Record<string, string>

/* A menu is opened many times a day, so it arrives fast (120 ms) and from nearly full size: a
   scale from 0.97 with opacity, never from nothing (`motion-pop`). It is a transition from a
   starting style, so there is no keyframe to restart if it is opened twice quickly. */
const PLATE = 'z-50 min-w-56 motion-pop overflow-y-auto rounded-card outline-none lift glass'

/**
 * A menu's plate, and the way to send it away. Sent away by a click elsewhere it goes out the
 * way it came, faster, and only then is its owner told to close it. A choice made in it does
 * not come through here: the owner closes the menu at once, because what was chosen is already
 * happening and that is the answer the Person is looking for.
 */
function usePlate(onClose: () => void) {
  const plate = useRef<HTMLDivElement | null>(null)
  // One function for the life of the menu: a new one each render would have React let go of the
  // keyboard and take it again every time.
  const hold = useCallback((node: HTMLDivElement | null) => {
    plate.current = node
    return holdFocus(node)
  }, [])
  const dismiss = () => {
    if (plate.current === null) onClose()
    else void leave(plate.current, 'popExit').then(onClose)
  }
  return { hold, dismiss }
}

/* A list of choices is inset from the plate's edge and stops growing at a screenful; a panel
   (something with its own headings and rows) lays itself out edge to edge. */
const FILL = {
  // 8px of padding around 8px rows makes the plate's 16px corner concentric with theirs.
  list: 'max-h-96 p-2',
  panel: 'max-h-[min(36rem,80vh)]',
} as const

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
  fill = 'list',
  className,
  children,
}: {
  open: boolean
  onClose: () => void
  side?: keyof typeof SIDE
  /** A list of choices, or a panel that lays out its own content. */
  fill?: keyof typeof FILL
  className?: string
  children: ReactNode
}) {
  if (!open) return null
  return (
    <Plate onClose={onClose} className={cn('absolute', FILL[fill], SIDE[side], className)}>
      {children}
    </Plate>
  )
}

/** The plate of an open menu and the layer under it. It exists only while the menu is open. */
function Plate({
  onClose,
  className,
  children,
}: {
  onClose: () => void
  className: string
  children: ReactNode
}) {
  const { hold, dismiss } = usePlate(onClose)
  return (
    <>
      <Backdrop onClose={dismiss} />
      <div
        ref={hold}
        role="menu"
        tabIndex={-1}
        // Escape is the keyboard, and the keyboard is answered at once: no exit is played.
        onKeyDown={(event) => steer(event, onClose)}
        className={cn(PLATE, className)}
      >
        {children}
      </div>
    </>
  )
}

/* The corner a context menu grows from: the one under the pointer. */
const CORNER = {
  top: { left: 'origin-top-left', right: 'origin-top-right' },
  bottom: { left: 'origin-bottom-left', right: 'origin-bottom-right' },
} as const

/** Where a pointer asked for a menu, in viewport pixels. */
export interface MenuPoint {
  readonly x: number
  readonly y: number
}

/**
 * The menu a right-click (or the keyboard's menu key) asks for, where it was asked for.
 *
 * It hangs from whichever corner keeps it on screen: asked for in the lower half it opens upward,
 * in the right half leftward. Nothing is measured, so it is in the right place on its first paint.
 * It is drawn over the page, not inside the list that asked, so nothing that list does to its own
 * edges can cut it.
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
  const { hold, dismiss } = usePlate(onClose)
  const leftward = at.x > window.innerWidth / 2
  const upward = at.y > window.innerHeight / 2
  // SAFETY: React forwards these CSS custom properties to the element; the classes below name
  // the edges they are read by, so the values are only ever the pointer's own pixels.
  const menuStyle = {
    '--menu-x': `${leftward ? window.innerWidth - at.x : at.x}px`,
    '--menu-y': `${upward ? window.innerHeight - at.y : at.y}px`,
  } as React.CSSProperties
  return (
    <Layer>
      <Backdrop onClose={dismiss} />
      <div
        ref={hold}
        role="menu"
        tabIndex={-1}
        onKeyDown={(event) => steer(event, onClose)}
        style={menuStyle}
        className={cn(
          'fixed',
          leftward ? 'right-(--menu-x)' : 'left-(--menu-x)',
          upward ? 'bottom-(--menu-y)' : 'top-(--menu-y)',
          CORNER[upward ? 'bottom' : 'top'][leftward ? 'right' : 'left'],
          PLATE,
          FILL.list,
        )}
      >
        {children}
      </div>
    </Layer>
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
