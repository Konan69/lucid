import { PageLoadFailure, type Page, type Tab } from '@vivid/desktop/bridge'
import { Option } from 'effect'
import {
  ArrowLeft,
  ArrowRight,
  Globe,
  LoaderCircle,
  Monitor,
  Plus,
  RotateCw,
  X,
} from 'lucide-react'
import { useCallback, useState, type KeyboardEvent } from 'react'
import { pages, type Front } from '../../data/pages'
import { wake } from '../../data/wake'
import { Button, IconButton } from '../../ui/button'
import { cn } from '../../ui/cn'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../../ui/contextmenu'
import { Face } from '../../ui/Face'
import { floatingSurfaces, useSurfaces } from '../../ui/Layer'

/** The Person asks for Vivid's computer: it comes in front of the pages, and is turned on. */
const toComputer = () => {
  pages.toComputer()
  wake()
}

/**
 * One tab: 32 high. Selected tabs rise onto the surface with a hairline; the others are flat until
 * the pointer or keyboard reaches them.
 */
const TAB =
  'group/tab relative flex h-8 flex-1 items-center gap-2 rounded-row pr-1.5 pl-2.5 text-title transition-press duration-(--dur-fast)'
const SELECTED = 'bg-surface-3 text-ink edge'
const RESTING = 'text-ink-3 hover:bg-wash-hover hover:text-ink focus-within:bg-wash-hover'

/**
 * How wide a tab is. Most are about 236 when there is room and shrink to 90 before the strip
 * scrolls sideways. The page in front, and a page not opened yet, are 280 and keep 160: they carry
 * the site beside the title, and the address field takes their place when it is asked for.
 */
const WIDTH = {
  tab: 'min-w-(--page-tab-min-w) max-w-(--page-tab-w) basis-(--page-tab-w)',
  front: 'min-w-(--page-tab-front-min-w) max-w-(--page-tab-front-w) basis-(--page-tab-front-w)',
} as const

/** What a page is called when its document has no title: where it is. */
const nameOf = (page: Page) => (page.title.trim().length > 0 ? page.title : page.address)

/**
 * The site a page is on, as its address names it, less the "www." most sites also answer to. It is
 * the host, not the registrable domain: telling one from the other needs the public suffix list,
 * which this app does not carry, and the host is what the Person would type. An address with no
 * host (a file, `about:blank`) has no site.
 */
const siteOf = (page: Page) =>
  Option.filter(
    Option.map(Option.fromNullOr(URL.parse(page.address)), (url) =>
      url.hostname.replace(/^www\./u, ''),
    ),
    (host) => host.length > 0,
  )

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
  // Only a key pressed in the strip itself. A tab's menu is drawn at the end of the document,
  // but React carries its keys up to the strip, and Home and End there move within the menu.
  // The address field sits in the strip while it is open, and its arrows move its caret.
  if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return
  if (event.target instanceof HTMLInputElement) return
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'))
  const at = tabs.findIndex((tab) => tab === document.activeElement)
  const next = tabs[neighbour(event.key, at, tabs.length - 1)]
  // Home or End on the tab already there: pressing it again would open its address.
  if (next === undefined || next === document.activeElement) return
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
  /** What every page tab is told, in front or not: itself, and where a drag over it would land. */
  const placed = (page: Page, position: number) => ({
    page,
    dragging: Option.contains(dragging, page.tab),
    landing:
      Option.contains(over, page.tab) && from !== position
        ? Option.some<Landing>(from < position ? 'after' : 'before')
        : Option.none<Landing>(),
    onDragStart: () => setDragging(Option.some(page.tab)),
    onDragOver: () => setOver(Option.some(page.tab)),
    onDrop: () => {
      Option.map(dragging, (tab) => pages.reorder(tab, position))
      stop()
    },
    onDragEnd: stop,
  })
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
          onClick={toComputer}
          className={cn(
            TAB,
            WIDTH.tab,
            'cursor-pointer',
            front === 'computer' ? SELECTED : RESTING,
          )}
        >
          <Monitor className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-left">Vivid’s computer</span>
          {running && <i aria-hidden className="size-1.5 shrink-0 rounded-full bg-success" />}
        </button>
        {open.map((page, position) =>
          // The tab in front is its own element (`Editable`), so an address open in it is put
          // away the moment another page comes forward, whoever brought it.
          front === 'page' && Option.exists(showing, (shown) => shown.tab === page.tab) ? (
            <Editable key={page.tab} page={Option.some(page)}>
              {(edit) => <PageTab {...placed(page, position)} active onPress={edit} />}
            </Editable>
          ) : (
            <PageTab
              key={page.tab}
              {...placed(page, position)}
              active={false}
              onPress={() => pages.show(page.tab)}
            />
          ),
        )}
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
 * ⌘L or Ctrl+L: the address of the page in front, the key every browser has trained people on. Not
 * while an input method is composing, and not a key something else already used.
 */
const asksForAddress = (event: globalThis.KeyboardEvent) =>
  (event.metaKey || event.ctrlKey) &&
  !event.altKey &&
  !event.shiftKey &&
  !event.defaultPrevented &&
  !event.isComposing &&
  event.key.toLocaleLowerCase() === 'l'

/**
 * The tab in front, which turns into the address field in its own place when it is pressed or ⌘L
 * is. The field has the tab's width, so nothing else in the bar moves. Going to an address, Escape,
 * or leaving the field turns it back into the tab.
 *
 * The shortcut is heard on the window for as long as this tab is in front. A key pressed in the
 * page itself is the page's: the desktop app draws the page as a view of its own, outside this
 * document, and its keys do not reach it.
 */
function Editable({
  page,
  children,
}: {
  page: Option.Option<Page>
  children: (edit: () => void) => React.ReactNode
}) {
  // A page not opened yet is nothing but its address, so it starts in the field.
  const [editing, setEditing] = useState(Option.isNone(page))
  const listen = useCallback((element: HTMLSpanElement | null) => {
    if (element === null) return undefined
    const press = (event: globalThis.KeyboardEvent) => {
      if (!asksForAddress(event)) return
      event.preventDefault()
      setEditing(true)
    }
    addEventListener('keydown', press)
    return () => removeEventListener('keydown', press)
  }, [])
  return (
    // `contents`: the strip lays out the tab or the field inside, never this.
    <span ref={listen} role="presentation" className="contents">
      {editing ? (
        <Address page={page} onDone={() => setEditing(false)} />
      ) : (
        children(() => setEditing(true))
      )}
    </span>
  )
}

/**
 * A page that has not been opened yet: an address still to be typed. It opens in the field, and
 * once the field is left it is drawn as the tab it will become, so "new page" is a place the
 * Person is in; pressing it opens the field again, and closing it goes back to the computer.
 */
function NewTab() {
  return (
    <Editable page={Option.none()}>
      {(edit) => (
        <span role="presentation" className={cn(TAB, WIDTH.front, SELECTED)}>
          <button
            role="tab"
            aria-selected
            aria-controls="computer-surface"
            tabIndex={0}
            onClick={edit}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left outline-none"
          >
            <Globe className="size-4 shrink-0 text-ink-3" />
            <span className="truncate">New page</span>
          </button>
          <CloseTab label="Close new page" visible onClose={pages.toComputer} />
        </span>
      )}
    </Editable>
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
 * The site at the trailing end of the tab in front, quieter than the title and never more than two
 * fifths of it. The title comes first: where the strip has squeezed the tab's label
 * (`@container/label`) under 160 px, two cut-off words would say neither, so the site steps out and
 * the title has the room. A page with no title is already called by its address, so it does not say
 * the site twice.
 */
function Site({ page }: { page: Page }) {
  const site = siteOf(page)
  if (page.title.trim().length === 0 || Option.isNone(site)) return null
  return (
    <span className="hidden max-w-2/5 shrink-0 truncate text-label text-ink-3 @min-[10rem]/label:inline">
      {site.value}
    </span>
  )
}

/**
 * One open page. Activation and closing are separate buttons, so the close target never switches
 * to the page first; a middle click closes, and a right click opens the page's actions. Dragging
 * reorders through the desktop app, which owns the order. Pressing a page brings it in front;
 * pressing the one already in front opens its address (`onPress` says which).
 */
function PageTab({
  page,
  active,
  dragging,
  landing,
  onPress,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  page: Page
  active: boolean
  dragging: boolean
  landing: Option.Option<Landing>
  onPress: () => void
  onDragStart: () => void
  onDragOver: () => void
  onDrop: () => void
  onDragEnd: () => void
}) {
  return (
    // The tab asks for its menu (a right click, the menu key, a long press) and the menu is drawn
    // over the page, beside the tab in React's tree and not inside it: nothing done in the menu
    // reaches the tab's own drag, click or middle-click handling.
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <span
            role="presentation"
            draggable
            className={cn(
              TAB,
              active ? WIDTH.front : WIDTH.tab,
              active ? SELECTED : RESTING,
              dragging && 'opacity-50',
            )}
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
          />
        }
      >
        {Option.isSome(landing) && (
          <i
            aria-hidden
            className={cn(
              'absolute inset-y-1 w-0.5 rounded-full bg-primary',
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
          onClick={onPress}
          className="@container/label flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left outline-none"
        >
          <PageIcon page={page} />
          <span className="min-w-0 flex-1 truncate">{nameOf(page)}</span>
          {active && <Site page={page} />}
        </button>
        <CloseTab
          label={`Close ${nameOf(page)}`}
          visible={active}
          onClose={() => pages.close(page.tab)}
        />
      </ContextMenuTrigger>
      <ContextMenuContent>
        <PageActions page={page} />
      </ContextMenuContent>
    </ContextMenu>
  )
}

/**
 * Everything a page can have done to it, in the menu its tab opens; going back, forward and
 * reloading the page in front are also at the start of the bar. The actions exist only while the
 * menu is open, so the order of the pages is read as it is at that moment. The menu closes itself
 * when one is chosen, so the page it acts on is in front of nothing.
 */
function PageActions({ page }: { page: Page }) {
  const open = pages.current().tabs
  const position = open.findIndex((candidate) => candidate.tab === page.tab)
  return (
    <>
      <ContextMenuItem onClick={() => pages.reload(page.tab)}>Reload</ContextMenuItem>
      <ContextMenuItem onClick={() => void navigator.clipboard.writeText(page.address)}>
        Copy address
      </ContextMenuItem>
      <ContextMenuItem onClick={() => pages.duplicate(page.tab)}>Duplicate</ContextMenuItem>
      <ContextMenuSeparator />
      {position > 0 && (
        <ContextMenuItem onClick={() => pages.reorder(page.tab, position - 1)}>
          Move left
        </ContextMenuItem>
      )}
      {position < open.length - 1 && (
        <ContextMenuItem onClick={() => pages.reorder(page.tab, position + 1)}>
          Move right
        </ContextMenuItem>
      )}
      <ContextMenuItem onClick={() => pages.reopen()}>Reopen closed page</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => pages.close(page.tab)}>Close</ContextMenuItem>
      {open.length > 1 && (
        <ContextMenuItem onClick={() => pages.closeOthers(page.tab)}>
          Close the others
        </ContextMenuItem>
      )}
    </>
  )
}

/** A control with nothing to do is only dim: it is not refused, so it does not say "not allowed". */
const STILL = 'disabled:cursor-default'

/**
 * Back, forward and reload, at the start of the one bar and acting on the page in front. With the
 * computer in front, or a page not opened yet, there is nothing to walk or load, so the three stay
 * in their places, dim. Each is named in a tooltip, which the keyboard gets too. A hairline ends
 * the group, so the page's controls do not read as the first tabs.
 */
export function PageNav({ page }: { page: Option.Option<Page> }) {
  const loading = Option.exists(page, (shown) => shown.loading)
  return (
    <div role="group" aria-label="Page" className="flex shrink-0 items-center">
      <IconButton
        label="Back"
        disabled={!Option.exists(page, (shown) => shown.canGoBack)}
        onClick={() => Option.map(page, (shown) => pages.back(shown.tab))}
        className={STILL}
      >
        <ArrowLeft className="size-4" />
      </IconButton>
      <IconButton
        label="Forward"
        disabled={!Option.exists(page, (shown) => shown.canGoForward)}
        onClick={() => Option.map(page, (shown) => pages.forward(shown.tab))}
        className={STILL}
      >
        <ArrowRight className="size-4" />
      </IconButton>
      <IconButton
        label={loading ? 'Stop loading' : 'Reload'}
        disabled={Option.isNone(page)}
        onClick={() =>
          Option.map(page, (shown) =>
            shown.loading ? pages.stop(shown.tab) : pages.reload(shown.tab),
          )
        }
        className={STILL}
      >
        {loading ? <X className="size-4" /> : <RotateCw className="size-4" />}
      </IconButton>
      <span aria-hidden className="mx-1.5 h-4 w-px shrink-0 bg-line-3" />
    </div>
  )
}

/** Puts the caret in the address field as it appears, where the press or ⌘L asked for it. */
const grab = (input: HTMLInputElement | null) => {
  if (input !== null) input.focus()
}

/**
 * The address and search field, in the place of the tab in front. What is typed belongs to this
 * field and to nothing else: a page that is not open yet has no identity to hold a draft, and the
 * field starts again from the page's own address each time it opens, so Escape (or leaving it)
 * leaves the page as it was.
 */
function Address({ page, onDone }: { page: Option.Option<Page>; onDone: () => void }) {
  const [typed, setTyped] = useState(
    Option.match(page, { onNone: () => '', onSome: (shown) => shown.address }),
  )
  return (
    <form
      className={cn('flex h-8 flex-1', WIDTH.front)}
      onSubmit={(event) => {
        event.preventDefault()
        const address = typed.trim()
        if (address.length === 0) return
        Option.match(page, {
          onNone: () => pages.open(address),
          onSome: (shown) => pages.go(shown.tab, address),
        })
        onDone()
      }}
    >
      {/* The tab's own shape and type in Vivid's field (a well, held by an edge that turns primary
          with focus, as `ui/input.tsx` draws one), so the tab and the field are one place. */}
      <input
        ref={grab}
        value={typed}
        onChange={(event) => setTyped(event.currentTarget.value)}
        onFocus={(event) => event.currentTarget.select()}
        onBlur={onDone}
        onKeyDown={(event) => {
          if (event.key === 'Escape') event.currentTarget.blur()
        }}
        aria-label="Address"
        placeholder="Search or enter an address"
        spellCheck={false}
        autoComplete="off"
        className="h-8 w-full min-w-0 truncate rounded-row bg-well px-2.5 text-title text-ink edge outline-none edge-field placeholder:text-ink-3 focus-visible:edge-primary"
      />
    </form>
  )
}

/**
 * Whether the native page has to be off the window: the window is not showing, or a floating
 * surface is open, which the page would otherwise be drawn on top of.
 */
const covered = () => document.visibilityState !== 'visible' || floatingSurfaces.open()

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
    const unlayered = useSurfaces.subscribe(schedule)
    addEventListener('resize', schedule)
    document.addEventListener('visibilitychange', schedule)
    report()
    return () => {
      cancelAnimationFrame(frame)
      sized.disconnect()
      unlayered()
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
        action={
          <Button variant="outline" onClick={() => pages.reload(page.value.tab)}>
            Try again
          </Button>
        }
      />
    )
  }
  return (
    <>
      {pages.usedByVivid(pages.current(), page.value) && (
        // A standing line, not a toast: it is there for exactly as long as an action is running
        // on this page, and the page below it moves down to make room, so nothing of the page is
        // covered. Stop is the only way the Person interrupts Vivid; using the page does not.
        <div className="flex shrink-0 items-center gap-3 py-1.5 pr-2 pl-3 hairline-b">
          <p role="status" className="min-w-0 flex-1 truncate text-label text-ink-2">
            Vivid is using this page.
          </p>
          <Button size="sm" variant="outline" onClick={() => pages.stopVivid(page.value.tab)}>
            Stop
          </Button>
        </div>
      )}
      {/* Keyed by the page, so another page gets its own element and its own first report. */}
      <div key={page.value.tab} ref={place} className="min-h-0 flex-1" />
    </>
  )
}

/**
 * A page not opened yet. It offers only what exists: Vivid's computer, and the address in the bar
 * above. Files, documents and suggested pages appear when there is something real behind them.
 */
function Launcher() {
  return (
    <div className="flex flex-1 flex-col gap-3 px-5 pt-8">
      <h3 className="text-title font-title text-ink-3">Open</h3>
      <div className="grid grid-cols-2 gap-4">
        <button
          onClick={toComputer}
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
