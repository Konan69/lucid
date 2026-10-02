import { PageLoadFailure, type Page, type Tab } from '@vivid/desktop/bridge'
import { Option } from 'effect'
import {
  ArrowLeft,
  ArrowRight,
  Globe,
  LoaderCircle,
  Monitor,
  MoreHorizontal,
  Plus,
  RotateCw,
  X,
} from 'lucide-react'
import { useCallback, useState, type KeyboardEvent } from 'react'
import { pages, type Front } from '../../data/pages'
import { Button, IconButton } from '../../ui/Button'
import { cn } from '../../ui/cn'
import { Face } from '../../ui/Face'
import { ContextMenu, MenuDivider, MenuItem, type MenuPoint } from '../../ui/Menu'

/**
 * One tab: 32 high, about 236 wide when there is room and shrinking to 90 before the strip
 * scrolls sideways. Selected tabs rise onto the surface with a hairline; the others are flat until
 * the pointer or keyboard reaches them.
 */
const TAB =
  'group/tab relative flex h-8 min-w-(--page-tab-min-w) max-w-(--page-tab-w) flex-1 basis-(--page-tab-w) items-center gap-2 rounded-row pr-1.5 pl-2.5 text-title transition-press duration-(--dur-fast)'
const SELECTED = 'bg-surface-3 text-ink smooth-shadow-ring-xs'
const RESTING = 'text-ink-3 hover:bg-wash-hover hover:text-ink focus-within:bg-wash-hover'

/** What a page is called when its document has no title: where it is. */
const nameOf = (page: Page) => (page.title.trim().length > 0 ? page.title : page.address)

/** The tab an arrow, Home or End key goes to, wrapping at either end. */
function neighbour(key: string, at: number, last: number) {
  switch (key) {
    case 'Home':
      return 0
    case 'End':
      return last
    case 'ArrowLeft':
      return at <= 0 ? last : at - 1
    default:
      return at >= last ? 0 : at + 1
  }
}

/**
 * Moves between tabs with the arrow keys, Home and End. Focus follows the arrow and so does the
 * selection, the way a browser's strip does, because the page behind is already open and showing
 * it costs nothing.
 */
function steer(event: KeyboardEvent<HTMLDivElement>) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'))
  const at = tabs.findIndex((tab) => tab === document.activeElement)
  const next = tabs[neighbour(event.key, at, tabs.length - 1)]
  if (next === undefined) return
  next.focus()
  next.click()
}

/** Where a tab being dragged would land relative to the one the pointer is over. */
type Landing = 'before' | 'after'

/**
 * The strip: Vivid's computer, then every page open beside the Thread, in the order the desktop
 * app keeps them. In a browser tab the pages do not exist, so the strip is the computer alone.
 */
export function PageTabs({
  open,
  front,
  showing,
  running,
}: {
  open: ReadonlyArray<Page>
  front: Front
  showing: Option.Option<Page>
  running: boolean
}) {
  // The tab being dragged and the tab the pointer is over, so the strip can show where it lands.
  const [dragging, setDragging] = useState<Option.Option<Tab>>(Option.none())
  const [over, setOver] = useState<Option.Option<Tab>>(Option.none())
  const from = Option.match(dragging, {
    onNone: () => -1,
    onSome: (tab) => open.findIndex((page) => page.tab === tab),
  })
  const stop = () => {
    setDragging(Option.none())
    setOver(Option.none())
  }
  return (
    <>
      <div
        role="tablist"
        aria-label="Vivid’s computer and pages"
        onKeyDown={steer}
        className="flex min-w-0 flex-1 scrollbar-hidden items-center gap-1 overflow-x-auto p-px"
      >
        <button
          role="tab"
          aria-selected={front === 'computer'}
          aria-controls="computer-surface"
          tabIndex={front === 'page' ? -1 : 0}
          onClick={pages.toComputer}
          className={cn(TAB, 'cursor-pointer', front === 'computer' ? SELECTED : RESTING)}
        >
          <Monitor className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-left">Vivid’s computer</span>
          {running && <i aria-hidden className="size-1.5 shrink-0 rounded-full bg-success" />}
        </button>
        {open.map((page, position) => (
          <PageTab
            key={page.tab}
            page={page}
            active={front === 'page' && Option.exists(showing, (shown) => shown.tab === page.tab)}
            dragging={Option.contains(dragging, page.tab)}
            landing={
              Option.contains(over, page.tab) && from !== position
                ? Option.some<Landing>(from < position ? 'after' : 'before')
                : Option.none()
            }
            onDragStart={() => setDragging(Option.some(page.tab))}
            onDragOver={() => setOver(Option.some(page.tab))}
            onDrop={() => {
              Option.map(dragging, (tab) => pages.reorder(tab, position))
              stop()
            }}
            onDragEnd={stop}
          />
        ))}
        {front === 'new' && <NewTab />}
      </div>
      {pages.available && (
        <IconButton label="New page" disabled={front === 'new'} onClick={pages.toNew}>
          <Plus className="size-4" />
        </IconButton>
      )}
    </>
  )
}

/**
 * A page that has not been opened yet: an address still to be typed. It is drawn as the tab it
 * will become, so "new page" is a place the Person is in, and closing it goes back to the computer.
 */
function NewTab() {
  return (
    <span role="presentation" className={cn(TAB, SELECTED)}>
      <button
        role="tab"
        aria-selected
        aria-controls="computer-surface"
        tabIndex={0}
        className="flex min-w-0 flex-1 cursor-default items-center gap-2 text-left outline-none"
      >
        <Globe className="size-4 shrink-0 text-ink-3" />
        <span className="truncate">New page</span>
      </button>
      <CloseTab label="Close new page" visible onClose={pages.toComputer} />
    </span>
  )
}

/** The close control: always on the selected tab, and on the others once they are reached. */
function CloseTab({
  label,
  visible,
  onClose,
}: {
  label: string
  visible: boolean
  onClose: () => void
}) {
  return (
    <button
      aria-label={label}
      tabIndex={visible ? 0 : -1}
      onClick={onClose}
      className={cn(
        'inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-xs text-ink-3 transition-press duration-(--dur-fast) hover:bg-wash-pressed hover:text-ink active:scale-96',
        !visible && 'opacity-0 group-focus-within/tab:opacity-100 group-hover/tab:opacity-100',
      )}
    >
      <X className="size-3.5" />
    </button>
  )
}

/** A page's icon: its own when the document declared one, a spinner while it loads, else a globe. */
function PageIcon({ page }: { page: Page }) {
  const icon = pages.favicon(page)
  if (page.loading) return <LoaderCircle className="size-4 shrink-0 animate-spin text-ink-3" />
  if (Option.isNone(icon)) return <Globe className="size-4 shrink-0 text-ink-3" />
  return (
    <img
      src={icon.value}
      alt=""
      draggable={false}
      referrerPolicy="no-referrer"
      className="size-4 shrink-0 rounded-xs"
    />
  )
}

/**
 * One open page. Activation and closing are separate buttons, so the close target never switches
 * to the page first; a middle click closes, and a right click opens the page's actions. Dragging
 * reorders through the desktop app, which owns the order.
 */
function PageTab({
  page,
  active,
  dragging,
  landing,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  page: Page
  active: boolean
  dragging: boolean
  landing: Option.Option<Landing>
  onDragStart: () => void
  onDragOver: () => void
  onDrop: () => void
  onDragEnd: () => void
}) {
  const [menu, setMenu] = useState<Option.Option<MenuPoint>>(Option.none())
  return (
    <>
      <span
        role="presentation"
        draggable
        className={cn(TAB, active ? SELECTED : RESTING, dragging && 'opacity-50')}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = 'move'
          onDragStart()
        }}
        onDragOver={(event) => {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          onDragOver()
        }}
        onDrop={(event) => {
          event.preventDefault()
          onDrop()
        }}
        onDragEnd={onDragEnd}
        // The middle button would start the browser's auto-scroll before the click arrived.
        onMouseDown={(event) => {
          if (event.button === 1) event.preventDefault()
        }}
        onAuxClick={(event) => {
          if (event.button === 1) pages.close(page.tab)
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          setMenu(Option.some({ x: event.clientX, y: event.clientY }))
        }}
      >
        {Option.isSome(landing) && (
          <i
            aria-hidden
            className={cn(
              'absolute inset-y-1 w-0.5 rounded-full bg-accent',
              landing.value === 'before' ? '-left-1' : '-right-1',
            )}
          />
        )}
        <button
          role="tab"
          aria-selected={active}
          aria-busy={page.loading}
          aria-controls="computer-surface"
          tabIndex={active ? 0 : -1}
          title={nameOf(page)}
          onClick={() => pages.show(page.tab)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left outline-none"
        >
          <PageIcon page={page} />
          <span className="truncate">{nameOf(page)}</span>
        </button>
        <CloseTab
          label={`Close ${nameOf(page)}`}
          visible={active}
          onClose={() => pages.close(page.tab)}
        />
      </span>
      {/* Beside the tab, not inside it: events from a portalled menu bubble through React's tree,
        and a right click on its backdrop would otherwise reach the tab and open it again. */}
      {Option.isSome(menu) && (
        <ContextMenu at={menu.value} onClose={() => setMenu(Option.none())}>
          <PageActions page={page} onClose={() => setMenu(Option.none())} />
        </ContextMenu>
      )}
    </>
  )
}

/** The actions a page has, in the menu a right click and the toolbar's overflow both open. */
function PageActions({ page, onClose }: { page: Page; onClose: () => void }) {
  const open = pages.current().tabs
  const position = open.findIndex((candidate) => candidate.tab === page.tab)
  // Every choice closes the menu first, so the page it acts on is in front of nothing.
  const then = (act: () => void) => () => {
    onClose()
    act()
  }
  return (
    <>
      <MenuItem onSelect={then(() => pages.reload(page.tab))}>Reload</MenuItem>
      <MenuItem onSelect={then(() => void navigator.clipboard.writeText(page.address))}>
        Copy address
      </MenuItem>
      <MenuItem onSelect={then(() => pages.duplicate(page.tab))}>Duplicate</MenuItem>
      <MenuDivider />
      {position > 0 && (
        <MenuItem onSelect={then(() => pages.reorder(page.tab, position - 1))}>Move left</MenuItem>
      )}
      {position < open.length - 1 && (
        <MenuItem onSelect={then(() => pages.reorder(page.tab, position + 1))}>Move right</MenuItem>
      )}
      <MenuItem onSelect={then(pages.reopen)}>Reopen closed page</MenuItem>
      <MenuDivider />
      <MenuItem onSelect={then(() => pages.close(page.tab))}>Close</MenuItem>
      {open.length > 1 && (
        <MenuItem onSelect={then(() => pages.closeOthers(page.tab))}>Close the others</MenuItem>
      )}
    </>
  )
}

/** One of the three controls in the navigation pill: round, 28 across, so the pill is 32 high. */
function NavButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex size-7 cursor-pointer items-center justify-center rounded-full text-ink-2 transition-press duration-(--dur-fast) hover:bg-wash-hover hover:text-ink active:enabled:scale-96 disabled:cursor-not-allowed disabled:text-ink-4"
    >
      {children}
    </button>
  )
}

/**
 * The toolbar for a page: back, forward and reload in one pill, the address, and the page's
 * actions. A page-to-Thread action is not here because there is no such action yet.
 */
export function PageToolbar({ page }: { page: Option.Option<Page> }) {
  const [menu, setMenu] = useState<Option.Option<MenuPoint>>(Option.none())
  const loading = Option.exists(page, (shown) => shown.loading)
  return (
    <>
      <div className="flex h-8 w-(--page-nav-w) shrink-0 items-center justify-evenly rounded-full bg-surface-2 px-0.5">
        <NavButton
          label="Back"
          disabled={!Option.exists(page, (shown) => shown.canGoBack)}
          onClick={() => Option.map(page, (shown) => pages.back(shown.tab))}
        >
          <ArrowLeft className="size-4" />
        </NavButton>
        <NavButton
          label="Forward"
          disabled={!Option.exists(page, (shown) => shown.canGoForward)}
          onClick={() => Option.map(page, (shown) => pages.forward(shown.tab))}
        >
          <ArrowRight className="size-4" />
        </NavButton>
        <span aria-hidden className="h-4 w-px shrink-0 bg-line-3" />
        <NavButton
          label={loading ? 'Stop loading' : 'Reload'}
          disabled={Option.isNone(page)}
          onClick={() =>
            Option.map(page, (shown) =>
              shown.loading ? pages.stop(shown.tab) : pages.reload(shown.tab),
            )
          }
        >
          {loading ? <X className="size-4" /> : <RotateCw className="size-4" />}
        </NavButton>
      </div>
      <Address
        // A navigation, or another page coming forward, starts the field again from that address.
        key={Option.match(page, {
          onNone: () => 'address',
          onSome: (shown) => `${shown.tab}:${shown.address}`,
        })}
        page={page}
      />
      {Option.isSome(page) && (
        <IconButton
          label="Page actions"
          active={Option.isSome(menu)}
          aria-haspopup="menu"
          aria-expanded={Option.isSome(menu)}
          onClick={(event) => {
            // Drawn at the end of the document, under the button: the page is a native view that
            // would sit over a menu drawn inside the panel.
            const box = event.currentTarget.getBoundingClientRect()
            setMenu(Option.some({ x: box.right, y: box.bottom + 4 }))
          }}
        >
          <MoreHorizontal className="size-4" />
        </IconButton>
      )}
      {Option.isSome(page) && Option.isSome(menu) && (
        <ContextMenu at={menu.value} onClose={() => setMenu(Option.none())}>
          <PageActions page={page.value} onClose={() => setMenu(Option.none())} />
        </ContextMenu>
      )}
    </>
  )
}

/**
 * The address and search field. What is typed belongs to this field and to nothing else: a page
 * that is not open yet has no identity to hold a draft. Escape puts the page's own address back.
 */
function Address({ page }: { page: Option.Option<Page> }) {
  const here = Option.match(page, { onNone: () => '', onSome: (shown) => shown.address })
  const [typed, setTyped] = useState(here)
  return (
    <form
      className="min-w-0 flex-1"
      onSubmit={(event) => {
        event.preventDefault()
        const address = typed.trim()
        if (address.length === 0) return
        Option.match(page, {
          onNone: () => pages.open(address),
          onSome: (shown) => pages.go(shown.tab, address),
        })
      }}
    >
      <input
        value={typed}
        // oxlint-disable-next-line jsx-a11y/no-autofocus
        autoFocus={Option.isNone(page)}
        onChange={(event) => setTyped(event.currentTarget.value)}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          setTyped(here)
          event.currentTarget.blur()
        }}
        aria-label="Address"
        placeholder="Search or enter an address"
        spellCheck={false}
        autoComplete="off"
        className="h-8 w-full truncate rounded-full bg-surface-2 px-4 text-center text-title text-ink transition-press duration-(--dur-fast) outline-none placeholder:text-ink-3 hover:bg-surface-3 focus:bg-surface-3 focus:text-left focus-visible:ring-2 focus-visible:ring-ring"
      />
    </form>
  )
}

/**
 * Whether something is drawn over the panel that a native page would sit on top of: a modal
 * surface, or a menu. Menus and dialogs are drawn at the end of the document, so they arrive as
 * its children.
 */
const covered = () =>
  document.visibilityState !== 'visible' ||
  document.querySelector('[aria-modal="true"], [role="menu"]') !== null

/**
 * Where the showing page is drawn. This element is empty: it reports its own rectangle to the
 * desktop app, which lays the page over it. It reports again when that rectangle changes (the
 * divider moves, the window resizes) and when something opens over the app, then the page is taken
 * off the window until it closes. Leaving takes the page off too.
 *
 * Reports are coalesced to one a frame and an unchanged rectangle is not sent twice, so dragging
 * the divider costs one message a frame and an idle panel costs none.
 */
export function PageView({ page }: { page: Option.Option<Page> }) {
  const place = useCallback((element: HTMLDivElement | null) => {
    if (element === null) return undefined
    let previous = ''
    let frame = 0
    const report = () => {
      frame = 0
      const box = element.getBoundingClientRect()
      const hidden = covered() || box.width === 0 || box.height === 0
      const next = hidden ? 'hidden' : `${box.x}:${box.y}:${box.width}:${box.height}`
      if (next === previous) return
      previous = next
      pages.place(hidden ? 'hidden' : { x: box.x, y: box.y, width: box.width, height: box.height })
    }
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(report)
    }
    const sized = new ResizeObserver(schedule)
    sized.observe(element)
    const layered = new MutationObserver(schedule)
    layered.observe(document.body, { childList: true })
    addEventListener('resize', schedule)
    document.addEventListener('visibilitychange', schedule)
    report()
    return () => {
      cancelAnimationFrame(frame)
      sized.disconnect()
      layered.disconnect()
      removeEventListener('resize', schedule)
      document.removeEventListener('visibilitychange', schedule)
      pages.place('hidden')
    }
  }, [])
  if (Option.isNone(page)) return <Launcher />
  if (PageLoadFailure.guards.Some(page.value.failed)) {
    return (
      <Blank
        title="This page did not load"
        detail={page.value.failed.value}
        action={<Button onClick={() => pages.reload(page.value.tab)}>Try again</Button>}
      />
    )
  }
  // Keyed by the page, so another page gets its own element and its own first report.
  return <div key={page.value.tab} ref={place} className="min-h-0 flex-1" />
}

/**
 * A page not opened yet. It offers only what exists: Vivid's computer, and the address bar above.
 * Files, documents and suggested pages appear when there is something real behind them.
 */
function Launcher() {
  return (
    <div className="flex flex-1 flex-col gap-3 px-5 pt-8">
      <h3 className="text-title font-title text-ink-3">Open</h3>
      <div className="grid grid-cols-2 gap-4">
        <button
          onClick={pages.toComputer}
          className="flex h-10 cursor-pointer items-center gap-2 rounded-row bg-surface-2 px-3 text-title text-ink transition-press duration-(--dur-fast) hover:bg-wash-pressed focus-visible:bg-wash-pressed active:scale-96"
        >
          <Monitor className="size-4 shrink-0" />
          <span className="truncate">Vivid’s computer</span>
        </button>
      </div>
      <p className="text-label font-meta text-ink-3">
        Or type an address, or a few words to search for, in the bar above.
      </p>
    </div>
  )
}

/** A page that did not load, or a state with nothing to show, said plainly with the way out. */
function Blank({
  title,
  detail,
  action,
}: {
  title: string
  detail: string
  action: React.ReactNode
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
      <Face size={36} mood="neutral" />
      <h3 className="text-title font-title text-ink">{title}</h3>
      <p className="max-w-xs text-label text-ink-3">{detail}</p>
      {action}
    </div>
  )
}
