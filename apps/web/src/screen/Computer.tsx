import { ComputerScreen, ComputerState, type Computer as ComputerRecord } from '@vivid/contracts'
import RFB from '@novnc/novnc'
import { Option, Result } from 'effect'
import {
  Hand,
  Maximize2,
  Monitor,
  MonitorPlay,
  MoreHorizontal,
  PanelRight,
  PictureInPicture2,
  Power,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useCallback, useReducer, useState, useSyncExternalStore } from 'react'
import { change, live, LiveState, useLive } from '../data/live'
import { pages, type Front } from '../data/pages'
import { split } from '../data/split'
import { orSay } from '../data/said'
import { Button, IconButton } from '../ui/button'
import { cn } from '../ui/cn'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '../ui/dropdownmenu'
import { Face } from '../ui/Face'
import { Segmented } from '../ui/Segmented'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { Edge } from './computer/Edge'
import { Corner, grip } from './computer/Float'
import { PageTabs, PageToolbar, PageView } from './computer/Pages'
import { place } from './computer/place'
import { viewerOnDesk, viewerResolution } from './computer/viewer'

/**
 * The three ways Vivid's computer is seen. `docked` is beside the Thread, sharing the page with
 * it. `popout` is a window over the page, dragged by its bar and resized from its corner, with
 * the Thread usable underneath. `full` is the whole page.
 *
 * The three and the floating window are T3 Code's preview (`apps/web/src/components/preview/
 * PreviewView.tsx` in the right panel, `ThreadPreviewMiniPlayer.tsx` floating over the thread).
 * The reference has no full view of its preview; that one is the panel's own, from before.
 */
type View = 'docked' | 'popout' | 'full'

/**
 * Which of the three is on screen. Popping out is about the computer's screen, so with a page in
 * front the panel is back in the page; a native page is laid over the panel by the desktop app
 * from its rectangle, which a window moved by `translate` does not report.
 */
const viewOf = (floating: boolean, full: boolean, front: Front): View => {
  if (floating && front === 'computer') return 'popout'
  return full ? 'full' : 'docked'
}

/** Changes how the computer is seen. Leaving full view is part of every change but the one to it. */
const show = (next: View) => {
  if (next === 'popout') {
    pages.toComputer()
    place.float()
  } else {
    place.dock()
  }
  // Where there is no room beside the Thread, full view is not a choice and is left as it is.
  if (split.canSplit() && split.isFull() !== (next === 'full')) split.toggleFull()
}

/**
 * Escape, pressed in the panel's own controls, goes back from the window or from full view to
 * beside the Thread (or to full view, where that is the only view in the page). It is heard on
 * the panel and not on the document: a key pressed on the machine's screen while the Person has
 * control is the machine's, and the screen client keeps those to itself.
 */
const leave = (event: KeyboardEvent) => {
  if (event.key !== 'Escape' || event.defaultPrevented) return
  // The address field has its own Escape: it puts the page's address back.
  if (event.target instanceof HTMLInputElement) return
  const home: View = split.canSplit() ? 'docked' : 'full'
  if (viewOf(place.isFloating(), split.isFull(), pages.front()) === home) return
  event.preventDefault()
  show(home)
}

/**
 * Vivid's computer: a real machine that is this Person's alone, shown live. One bar across the
 * top (the computer and, in the desktop app, every page opened beside the Thread; how it is seen;
 * what else can be done; close) and the machine's screen filling the rest. Who has the keyboard,
 * and the one control that changes it, sit under the screen, where the Person is looking.
 *
 * It is seen three ways (`View`). Beside the Thread, the divider on its left edge shares the page;
 * where there is not room for both, it is the whole page.
 */
export function Computer({ onClose }: { onClose: () => void }) {
  const state = useLive(live.computer)
  const full = useSyncExternalStore(split.subscribe, split.isFull)
  const floating = useSyncExternalStore(place.subscribe, place.isFloating)
  const box = useSyncExternalStore(place.subscribe, place.box)
  const front = useSyncExternalStore(pages.subscribe, pages.front)
  const view = viewOf(floating, full, front)
  const computer = LiveState.$is('Ready')(state) ? Option.some(state.value.computer) : Option.none()
  // SAFETY: React forwards these CSS custom properties to the element. The popped-out window's
  // rule in `computer-workspace` reads them; beside the Thread and in full view nothing does.
  const boxStyle = {
    '--float-x': `${box.x}px`,
    '--float-y': `${box.y}px`,
    '--float-w': `${box.width}px`,
    '--float-h': `${box.height}px`,
  } as React.CSSProperties
  return (
    <aside
      ref={attach}
      data-view={view}
      aria-label="Vivid’s computer"
      style={boxStyle}
      className="computer-workspace flex shrink-0 flex-col bg-surface-1 transition-width duration-(--dur-base) ease-out in-data-resizing:transition-none"
    >
      {view === 'docked' && <Edge />}
      <Bar
        view={view}
        front={front}
        running={Option.exists(computer, (value) => ComputerState.guards.Running(value.state))}
        onClose={onClose}
      />
      <Surface view={view} front={front}>
        <ComputerBody
          loading={LiveState.$is('Loading')(state)}
          failed={LiveState.$is('Failed')(state)}
          computer={computer}
        />
      </Surface>
      {view === 'popout' && <Corner />}
    </aside>
  )
}

/**
 * What the panel follows for as long as it is on the page: the room beside the sidebar (for the
 * divider), the page the popped-out window floats over, and Escape in its own controls. The
 * ref's cleanup stops all three when the panel closes.
 */
const attach = (element: HTMLElement | null) => {
  if (element === null) return undefined
  const unsplit = split.attach(element)
  const unplace = place.attach(element)
  element.addEventListener('keydown', leave)
  return () => {
    if (unsplit !== undefined) unsplit()
    unplace()
    element.removeEventListener('keydown', leave)
  }
}

/**
 * The one bar: what is open (the computer and, in the desktop app, every page beside the Thread),
 * how the computer is seen, what else can be done with it, and close. 52 high with 32-high
 * controls: 10 above and below, 8 at the sides.
 *
 * Popped out, the bar is what the window is dragged by, and it names the window instead of
 * listing pages; a press on one of its controls is still that control's (`grip`).
 *
 * A page has an address to type and a history to walk, so it gets a second row for them. The
 * computer has neither, and its screen starts right under the bar.
 */
function Bar({
  view,
  front,
  running,
  onClose,
}: {
  view: View
  front: Front
  running: boolean
  onClose: () => void
}) {
  const canSplit = useSyncExternalStore(split.subscribe, split.canSplit)
  const browser = useSyncExternalStore(pages.subscribe, pages.current)
  const page = pages.showing(browser)
  return (
    <>
      <header
        {...grip}
        className={cn(
          'flex h-(--page-strip-h) shrink-0 items-center gap-1 px-2 py-2.5',
          front !== 'computer' && 'hairline-b',
          view === 'popout' && 'cursor-grab touch-none select-none active:cursor-grabbing',
        )}
      >
        {view === 'popout' ? (
          <Name running={running} />
        ) : (
          <PageTabs open={browser.tabs} front={front} showing={page} running={running} />
        )}
        <Views view={view} canSplit={canSplit} />
        {running && front === 'computer' && <More />}
        <IconButton label="Close" onClick={onClose}>
          <X className="size-4" />
        </IconButton>
      </header>
      {front !== 'computer' && (
        // 48 high; the address takes what the controls leave.
        <div className="flex h-12 shrink-0 items-center gap-2 px-2 hairline-b">
          <PageToolbar page={front === 'page' ? page : Option.none()} />
        </div>
      )}
    </>
  )
}

/** How the surface under the bar is drawn for each thing that can be in front of it. */
const SURFACE = {
  // A page fills its slot flush under the toolbar.
  page: 'bg-surface-0',
  // The machine's desk: the wallpaper, in a frame of its own inside the panel.
  desk: 'mx-2 mb-2 rounded-panel picture-edge desktop-wallpaper',
  // Popped out, the window is the frame and the desk runs to its edges.
  window: 'desktop-wallpaper',
} as const

const surfaceOf = (view: View, front: Front) => {
  if (front !== 'computer') return SURFACE.page
  return view === 'popout' ? SURFACE.window : SURFACE.desk
}

/** Under the bar: the computer's screen (the children), or the page that is in front. */
function Surface({
  view,
  front,
  children,
}: {
  view: View
  front: Front
  children: React.ReactNode
}) {
  const browser = useSyncExternalStore(pages.subscribe, pages.current)
  return (
    <div
      id="computer-surface"
      role="tabpanel"
      aria-label={front === 'computer' ? 'Vivid’s computer' : 'Page'}
      className={cn('flex min-h-0 flex-1 flex-col overflow-hidden', surfaceOf(view, front))}
    >
      {front === 'computer' ? (
        children
      ) : (
        <PageView page={front === 'page' ? pages.showing(browser) : Option.none()} />
      )}
    </div>
  )
}

/** The popped-out window's title: what it is, and whether it is running. It is not a tab. */
function Name({ running }: { running: boolean }) {
  return (
    <h2 className="flex h-8 min-w-0 flex-1 items-center gap-2 pl-2.5 text-title text-ink">
      <Monitor className="size-4 shrink-0 text-ink-3" />
      <span className="min-w-0 truncate">Vivid’s computer</span>
      {running && <i aria-hidden className="size-1.5 shrink-0 rounded-full bg-success" />}
    </h2>
  )
}

/**
 * A view's mark with its name in a tooltip. The segment it sits in already carries the name for a
 * screen reader; this is the same name for the eye. The span reaches the segment's edges (28 high
 * with 8 at the sides), so the tooltip answers the whole segment and not only the 16 px mark.
 */
const mark = (name: string, Icon: LucideIcon) => (
  <Tooltip>
    <TooltipTrigger render={<span className="-mx-2 -my-1.5 inline-flex px-2 py-1.5" />}>
      <Icon className="size-4" />
    </TooltipTrigger>
    <TooltipContent>{name}</TooltipContent>
  </Tooltip>
)

/** What going beside the Thread is called from each view: from two of them it is the way back. */
const DOCK_NAME = {
  docked: 'Beside the Thread',
  popout: 'Dock beside the Thread (Esc)',
  full: 'Exit full screen (Esc)',
} as const

/**
 * How the computer is seen, as one choice of three in the bar. It is a radio group: one tab stop,
 * and the arrow keys move the choice. Where there is no room beside the Thread, "beside" is not
 * offered, because choosing it would change nothing.
 */
function Views({ view, canSplit }: { view: View; canSplit: boolean }) {
  const beside = {
    value: 'docked' as const,
    name: DOCK_NAME[view],
    label: mark(DOCK_NAME[view], PanelRight),
  }
  const others = [
    { value: 'popout' as const, name: 'Pop out', label: mark('Pop out', PictureInPicture2) },
    { value: 'full' as const, name: 'Full screen', label: mark('Full screen', Maximize2) },
  ]
  return (
    <Segmented<View>
      label="How Vivid’s computer is shown"
      value={view}
      options={canSplit ? [beside, ...others] : others}
      onChange={show}
    />
  )
}

/**
 * What else can be done with a running computer. Stopping it is rare and ends whatever Vivid is
 * doing on it, so it is a named line in a menu, in the danger ink, and not a mark in the bar.
 * Nothing is lost by it, and the menu says so.
 */
function More() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<IconButton label="More" />}>
        <MoreHorizontal className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuItem variant="destructive" onClick={stop}>
            <Power />
            Stop Vivid’s computer
          </DropdownMenuItem>
          <DropdownMenuLabel>Its files and sign-ins are kept.</DropdownMenuLabel>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** What the panel shows for Vivid's computer: its screen, or the honest reason there is none. */
function ComputerBody({
  loading,
  failed,
  computer,
}: {
  loading: boolean
  failed: boolean
  computer: Option.Option<ComputerRecord>
}) {
  return (
    <>
      {loading && <Note title="One moment" detail="Looking for Vivid’s computer." busy />}
      {failed && (
        <Note title="Not available" detail="Vivid could not reach its computer right now." />
      )}
      {Option.isSome(computer) && <Screen computer={computer.value} />}
    </>
  )
}

export const start = () =>
  void orSay(
    change((client) => client.StartComputer()),
    'The computer could not be turned on. Try again.',
  )
const stop = () =>
  void orSay(
    change((client) => client.StopComputer()),
    'The computer could not be turned off. Try again.',
  )
/** Takes the keyboard and pointer from Vivid, or hands them back; the panel and the Thread's small picture both use it. */
export const hold = (held: boolean) =>
  void orSay(
    change((client) => client.HoldComputer({ held })),
    held
      ? 'Vivid still has control: taking over did not go through. Try again.'
      : 'You still have control: handing back did not go through. Try again.',
  )

const TURN_ON = (
  <Button onClick={start}>
    <MonitorPlay className="size-3.5" />
    Turn it on
  </Button>
)

/** What each state that is not "running" says, and what the Person can do about it. */
const RESTING = {
  Absent: {
    title: 'A computer of its own',
    detail:
      'Vivid can use a real machine for work that needs one: running a script, reading a site, filling a form. It is yours alone and keeps its files and sign-ins between uses.',
    action: TURN_ON,
    busy: false,
  },
  Starting: {
    title: 'Starting up',
    detail: 'Vivid’s computer is waking. This can take a minute or two.',
    action: null,
    busy: true,
  },
  Stopped: {
    title: 'Vivid’s computer is off',
    detail: 'Its files and sign-ins are kept.',
    action: TURN_ON,
    busy: false,
  },
} as const

/** A computer that is not running and did not fail: what it says, and the one thing to do about it. */
const resting = (state: { readonly _tag: keyof typeof RESTING }) => {
  const note = RESTING[state._tag]
  return <Note title={note.title} detail={note.detail} action={note.action} busy={note.busy} />
}

/** The time of day something happened, the way this browser writes it: "10:28 PM". */
const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

/**
 * The line under who has control. Today it says only what this panel knows: whether the Person is
 * watching or typing, and since when the machine has been on.
 *
 * What Vivid is doing on the machine right now ("Typing the echo command into the terminal") is
 * not here, because it does not reach this panel. Those words are the `summary` of each
 * `use_desktop`, `browse` and `run_command` step, read by `describeToolCall` in `@vivid/state`
 * from the Thread's own stream, which only the Thread screen holds. When the Thread publishes its
 * current or last such step where the panel can read it, that sentence and its time replace this
 * line while watching.
 */
const captionOf = (held: boolean, since: number) =>
  held ? 'Keys and clicks go to this screen' : `Live · on since ${clock.format(since)}`

function Screen({ computer }: { computer: ComputerRecord }) {
  const held = computer.heldByPerson
  // Every state is a named case, so a new one fails to typecheck here until it says what it shows.
  return ComputerState.match(computer.state, {
    Running: (state) =>
      // The machine's provider decides how its screen is watched: relayed through this server as a
      // remote-framebuffer socket, or in the provider's own viewer page for this Person's machine.
      ComputerScreen.guards.Relay(state.screen) ? (
        <Display
          // Taking over or handing back changes who may type, so the screen reconnects with it.
          key={held ? 'held' : 'watching'}
          address={state.screen.address}
          control={held}
          since={state.since}
        />
      ) : (
        <Watched
          // A new machine start has a new viewer; the one on screen is not carried over.
          key={state.since}
          address={state.screen.address}
          expiresAt={state.screen.expiresAt}
          held={held}
          since={state.since}
        />
      ),
    Failed: (state) => (
      <Note
        title="It did not start"
        detail={state.reason}
        action={
          <Button variant="outline" onClick={start}>
            Try again
          </Button>
        }
      />
    ),
    Absent: resting,
    Starting: resting,
    Stopped: resting,
  })
}

/** The machine's screen in its own pixels, as the stream reports it. */
export interface Resolution {
  readonly width: number
  readonly height: number
}

/**
 * The provider's viewer on the stage, at the machine's own shape. Given the whole room instead, a
 * docked panel made it a tall strip and the page streamed a desktop to match: the taskbar across
 * the middle of a white page.
 */
function Watched({
  address,
  expiresAt,
  held,
  since,
}: {
  address: string
  expiresAt: number
  held: boolean
  since: number
}) {
  return (
    <Stage resolution={viewerResolution(address)} held={held} caption={captionOf(held, since)}>
      <Viewer address={address} expiresAt={expiresAt} control={held} />
    </Stage>
  )
}

/**
 * The machine's screen on its desk, with the line of control under it.
 *
 * The screen is the page. With its shape known it is the largest screen of that shape the room
 * holds (`screen-fit`): as wide as the room when the room is tall, as tall as the room less the
 * line under it when the room is wide. The line is as wide as the screen and shares its edges, so
 * the words and the control belong to the screen and not to the panel. In a tall room the pair
 * sits a little above the middle (two parts of the spare room above, three below), which is where
 * a picture on a wall reads as centred. The line is under the screen and never on it, so nothing
 * of Vivid's covers the machine's own taskbar.
 *
 * Until the shape is known, the screen takes the whole room above the line.
 *
 * The screen's corners are the control radius (10) inside a 10 px inset inside the desk's panel
 * radius (20): concentric. While the Person has control, the screen wears the primary outline, so
 * where the typing goes is drawn and not only said.
 */
function Stage({
  resolution,
  held,
  caption,
  children,
}: {
  resolution: Option.Option<Resolution>
  held: boolean
  caption: string
  children: React.ReactNode
}) {
  const fitted = Option.isSome(resolution)
  // SAFETY: React forwards these CSS custom properties to the element; `screen-fit` and
  // `screen-glass` read them. Both are positive integers from the stream's own canvas, and with
  // no resolution yet neither is set and neither class is worn.
  const fitStyle = {
    '--screen-w': Option.getOrUndefined(Option.map(resolution, (screen) => screen.width)),
    '--screen-h': Option.getOrUndefined(Option.map(resolution, (screen) => screen.height)),
  } as React.CSSProperties
  return (
    <div className="screen-room flex min-h-0 flex-1 flex-col items-center p-2.5">
      {fitted && <i aria-hidden className="grow-2" />}
      {/* As wide as the screen, so the line under it shares the screen's edges; never narrower
          than the line needs (224), which a tall narrow screen in a short room would be. */}
      <div
        className={cn('flex min-w-56 flex-col gap-3', !fitted && 'min-h-0 w-full flex-1')}
        style={fitStyle}
      >
        <div
          className={cn(
            'relative overflow-hidden rounded-control bg-scrim desktop-window',
            fitted ? 'screen-glass screen-fit shrink-0 self-center' : 'min-h-0 flex-1',
            held ? 'outline-2 outline-offset-2 outline-primary' : 'picture-edge',
          )}
        >
          {children}
        </div>
        {/* 40 high: two lines of words and the 28-high control, centred on each other. It asks
            for no width of its own and takes the column's, so long words are cut short instead of
            pushing the column wider than the screen. */}
        <div className="flex h-10 w-0 min-w-full shrink-0 items-center gap-3 px-0.5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-label font-title text-ink-on-color" aria-live="polite">
              {held ? 'You have control' : 'Vivid has control'}
            </p>
            <p className="truncate text-meta font-meta text-ink-on-color/70 tabular-nums">
              {caption}
            </p>
          </div>
          <Button
            size="sm"
            variant={held ? 'default' : 'outline'}
            className="shrink-0"
            onClick={() => hold(!held)}
          >
            <Hand className="size-3.5" />
            {held ? 'Hand back' : 'Take over'}
          </Button>
        </div>
      </div>
      {fitted && <i aria-hidden className="grow-3" />}
    </div>
  )
}

/** How long before a viewer's permission runs out a fresh one is asked for. */
const RENEW_BEFORE_MS = 60_000

/**
 * The provider's own viewer for this Person's machine, in a frame that fills whatever holds it.
 * Its address is a short-lived permission to watch one machine, issued by the server for whoever
 * is signed in here; it is never written anywhere, and before it runs out the server is asked for
 * the next one, so a screen left open keeps showing.
 *
 * The frame is another site's page: it is sandboxed, gets no referrer, and cannot reach this
 * page. While the Person is only watching, nothing they do reaches it, so looking at the screen
 * can never fight with what Vivid is doing on it.
 */
export function Viewer({
  address,
  expiresAt,
  control,
}: {
  address: string
  expiresAt: number
  control: boolean
}) {
  const [shown, setShown] = useState({ address, expiresAt })
  const renew = useCallback(
    (frame: HTMLIFrameElement | null) => {
      if (frame === null) return undefined
      const timer = setTimeout(
        () => {
          void change((client) => client.GetComputer()).then((answer) => {
            if (Result.isFailure(answer)) return
            const state = answer.success.computer.state
            if (!ComputerState.guards.Running(state)) return
            const next = state.screen
            if (ComputerScreen.guards.Viewer(next)) {
              setShown({ address: next.address, expiresAt: next.expiresAt })
            }
          })
        },
        Math.max(shown.expiresAt - Date.now() - RENEW_BEFORE_MS, 5_000),
      )
      return () => clearTimeout(timer)
    },
    [shown.expiresAt],
  )
  return (
    // The viewer is the provider's page on the provider's origin. It needs its scripts and its
    // own storage to run; "same origin" here is its origin, never this app's, so the two together
    // do not let it out of the frame the way they would for a page of ours.
    <iframe
      ref={renew}
      src={viewerOnDesk(shown.address)}
      title="Vivid’s computer"
      // oxlint-disable-next-line react/iframe-missing-sandbox
      sandbox="allow-scripts allow-same-origin allow-forms"
      allow="clipboard-read; clipboard-write; fullscreen"
      referrerPolicy="no-referrer"
      className={cn(
        'size-full border-0',
        // Watching sends nothing to it. Neither does a drag of the popped-out window or of the
        // divider, which would otherwise lose the pointer to the frame as it passed over.
        !control && 'pointer-events-none',
        'in-data-resizing:pointer-events-none',
      )}
    />
  )
}

/**
 * Whether the machine's screen is on the glass. A running Computer and a screen this window can
 * see are two facts: the socket between them can fail to open, or drop, while the machine carries
 * on. `attempt` counts the connections made, so asking again is a new connection, not a retry of
 * a dead one.
 */
interface Sight {
  readonly seen: 'reaching' | 'showing' | 'lost'
  readonly attempt: number
}

/** What happened to the connection: it opened, it closed, or the Person asked for it again. */
export type Heard = 'opened' | 'closed' | 'asked'

/**
 * A screen that was showing and dropped (the server restarted, the network blinked) is reached
 * for again at once. One that never arrived says so and waits to be asked, or a machine that
 * cannot be reached would be dialled forever.
 */
export const sightAfter = (now: Sight, heard: Heard): Sight => {
  if (heard === 'opened') return { seen: 'showing', attempt: now.attempt }
  if (heard === 'asked' || now.seen === 'showing') {
    return { seen: 'reaching', attempt: now.attempt + 1 }
  }
  return { seen: 'lost', attempt: now.attempt }
}

/**
 * The shape the machine's screen last had in this window. Taking over and handing back reconnect
 * the screen, and a dropped one is reached for again; each new connection starts from the shape
 * the last one showed, so the screen does not jump to the whole room and back while it connects.
 * The stream corrects it the moment it says otherwise.
 */
let lastResolution: Option.Option<Resolution> = Option.none()

const sameResolution = (one: Resolution, other: Resolution) =>
  one.width === other.width && one.height === other.height

/**
 * The machine's screen and the truth about whether it is showing. It used to say "Watching" from
 * the moment the machine ran, whether or not a single frame had arrived, so a socket that never
 * opened was an empty dark panel captioned as a live screen.
 */
function Display({
  address,
  control,
  since,
}: {
  address: string
  control: boolean
  since: number
}) {
  const [sight, hear] = useReducer(sightAfter, { seen: 'reaching', attempt: 0 })
  const [resolution, setResolution] = useState(lastResolution)
  const sized = useCallback((next: Resolution) => {
    lastResolution = Option.some(next)
    // The same shape again is the same state, so a stream that repeats itself draws nothing.
    setResolution((now) =>
      Option.exists(now, (was) => sameResolution(was, next)) ? now : lastResolution,
    )
  }, [])
  if (sight.seen === 'lost') {
    return (
      <Note
        title="Can’t see the screen"
        detail="Vivid’s computer is still running. Its screen did not reach this window."
        action={
          <Button variant="outline" onClick={() => hear('asked')}>
            Look again
          </Button>
        }
      />
    )
  }
  return (
    <Stage resolution={resolution} held={control} caption={captionWhile(sight, control, since)}>
      <div className="size-full" aria-busy={sight.seen === 'reaching'}>
        {/* Each attempt is its own element, so its socket is opened and closed with it. */}
        <Glass
          key={sight.attempt}
          address={address}
          control={control}
          onHeard={hear}
          onResolution={sized}
        />
      </div>
    </Stage>
  )
}

/** The line under the screen while it connects, and once it shows. */
const captionWhile = (sight: Sight, held: boolean, since: number) => {
  if (sight.seen === 'showing') return captionOf(held, since)
  // The first connection is a connection; any after it is one that dropped and is coming back.
  return sight.attempt === 0 ? 'Connecting to the screen…' : 'Reconnecting to the screen…'
}

/**
 * One connection to the screen, drawn by the noVNC client bundled with this app. Nothing the
 * machine serves is ever loaded as a page here: the only thing that crosses is the
 * remote-framebuffer socket, which the server proxies for this Person's own Computer and nobody
 * else's.
 *
 * The connection lives exactly as long as the element does: React calls the ref's cleanup when it
 * unmounts, which closes the socket. While the Person is only watching, the canvas sends no keys
 * or pointer events, so looking at the screen can never fight with what Vivid is doing on it.
 *
 * `onResolution` hears the machine's screen size: once when the connection opens, and again whenever
 * the machine changes it. The client keeps that size as its canvas's `width` and `height` (noVNC
 * 1.7.0 `core/display.js`, `resize`) and has no event for it, so the two attributes are watched.
 */
export function Glass({
  address,
  control,
  onHeard,
  onResolution,
}: {
  address: string
  control: boolean
  onHeard: (heard: Heard) => void
  onResolution: (resolution: Resolution) => void
}) {
  const connect = useCallback(
    (element: HTMLDivElement | null) => {
      if (element === null) return undefined
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
      const screen = new RFB(element, `${scheme}://${location.host}${address}`)
      screen.scaleViewport = true
      screen.viewOnly = !control
      screen.background = 'transparent'
      // Whether the socket is still this element's to close: asking a client that has already
      // closed to close again is an error in its log, once for every panel that is shut.
      let open = true
      // Before the connection opens the canvas has the browser's default size, which is not the
      // machine's and is not reported.
      let showing = false
      const canvas = element.querySelector('canvas')
      const measure = () => {
        if (!showing || canvas === null || canvas.width === 0 || canvas.height === 0) return
        onResolution({ width: canvas.width, height: canvas.height })
      }
      const resized = new MutationObserver(measure)
      if (canvas !== null) {
        resized.observe(canvas, { attributes: true, attributeFilter: ['width', 'height'] })
      }
      const opened = () => {
        showing = true
        measure()
        onHeard('opened')
      }
      const closed = () => {
        open = false
        onHeard('closed')
      }
      screen.addEventListener('connect', opened)
      screen.addEventListener('disconnect', closed)
      return () => {
        // Closing it here is this window's own doing, not a screen that was lost.
        resized.disconnect()
        screen.removeEventListener('connect', opened)
        screen.removeEventListener('disconnect', closed)
        if (open) screen.disconnect()
      }
    },
    [address, control, onHeard, onResolution],
  )
  return <div ref={connect} className="size-full" />
}

/**
 * A state with no screen to show, said on the machine's desk: Vivid's face, what is so, and the
 * one thing to do about it. The desk is the same dark wallpaper in both themes, so the words are
 * the on-colour ink and not the page's.
 */
function Note({
  title,
  detail,
  action,
  busy = false,
}: {
  title: string
  detail: string
  action?: React.ReactNode
  busy?: boolean
}) {
  return (
    // The words are centred by their own margins, not by the box: in a room too short for them
    // they scroll from the top instead of losing their first lines above it.
    <div className="flex min-h-0 flex-1 overflow-y-auto" aria-busy={busy}>
      <div className="m-auto flex flex-col items-center gap-3 px-6 py-4 text-center">
        <Face size={36} mood={busy ? 'thinking' : 'neutral'} />
        <h3 className="text-title font-title text-balance text-ink-on-color">{title}</h3>
        <p className="max-w-xs text-label text-pretty wrap-break-word text-ink-on-color/70">
          {detail}
        </p>
        {action}
      </div>
    </div>
  )
}
