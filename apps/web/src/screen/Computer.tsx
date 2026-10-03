import { ComputerScreen, ComputerState, type Computer as ComputerRecord } from '@vivid/contracts'
import RFB from '@novnc/novnc'
import { Option, Result } from 'effect'
import { Hand, Maximize2, Minimize2, MonitorPlay, Power, X } from 'lucide-react'
import { useCallback, useReducer, useState, useSyncExternalStore } from 'react'
import { change, live, LiveState, useLive } from '../data/live'
import { pages } from '../data/pages'
import { split } from '../data/split'
import { orSay } from '../data/said'
import { Button, IconButton } from '../ui/Button'
import { cn } from '../ui/cn'
import { Face } from '../ui/Face'
import { PageTabs, PageToolbar, PageView } from './computer/Pages'
import { Edge } from './computer/Edge'

/**
 * Vivid's computer, beside the Thread: a real machine that is this Person's alone. It is laid out
 * like a browser window. A strip of tabs across the top (Vivid's computer, and in the desktop app
 * every page opened beside the Thread), a toolbar under it, and the content filling the rest.
 *
 * The divider on its left edge is dragged to share the page with the Thread, and a control in the
 * strip takes the whole page. Where there is not room for both, it is always the whole page.
 *
 * It shows the machine's screen while it runs, says honestly when it is off, starting or
 * unavailable, and gives the Person the one control that matters: taking the keyboard and
 * pointer, which stops Vivid from acting on it until they hand it back.
 */
export function Computer({ onClose }: { onClose: () => void }) {
  const state = useLive(live.computer)
  const full = useSyncExternalStore(split.subscribe, split.isFull)
  const canSplit = useSyncExternalStore(split.subscribe, split.canSplit)
  const browser = useSyncExternalStore(pages.subscribe, pages.current)
  const front = useSyncExternalStore(pages.subscribe, pages.front)
  const page = pages.showing(browser)
  const computer = LiveState.$is('Ready')(state) ? Option.some(state.value.computer) : Option.none()
  const on = Option.exists(computer, (value) => ComputerState.guards.Running(value.state))
  // The ref's cleanup stops observing the room beside the sidebar when the panel closes.
  const attach = useCallback((element: HTMLElement | null) => split.attach(element), [])
  return (
    <aside
      ref={attach}
      data-full={full}
      aria-label="Vivid’s computer"
      className="computer-workspace flex h-full shrink-0 flex-col bg-surface-1 transition-width duration-(--dur-base) ease-out in-data-resizing:transition-none"
    >
      {!full && <Edge />}
      {/* 52 high with 32-high tabs: 10 above and below, 8 at the sides. */}
      <header className="flex h-(--page-strip-h) shrink-0 items-center gap-1 px-2 py-2.5 hairline-b">
        <PageTabs open={browser.tabs} front={front} showing={page} running={on} />
        <IconButton
          label={full && canSplit ? 'Back to the Thread' : 'Full view'}
          // With no room beside the Thread, full view is the only view, so there is nothing to undo.
          disabled={!canSplit}
          onClick={split.toggleFull}
        >
          {full ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
        </IconButton>
        <IconButton label="Close" onClick={onClose}>
          <X className="size-4" />
        </IconButton>
      </header>

      {/* 48 high; whichever it holds, the long field takes what the controls leave. */}
      <div className="flex h-12 shrink-0 items-center gap-2 px-2 hairline-b">
        {front === 'computer' ? (
          <ComputerToolbar computer={computer} on={on} />
        ) : (
          <PageToolbar page={front === 'page' ? page : Option.none()} />
        )}
      </div>

      <div
        id="computer-surface"
        role="tabpanel"
        aria-label={front === 'computer' ? 'Vivid’s computer' : 'Page'}
        className={cn(
          'flex min-h-0 flex-1 flex-col overflow-hidden bg-surface-0',
          // The machine's screen sits in a frame of its own; a page fills its slot flush under the toolbar.
          front === 'computer' && 'mx-2 mb-2 rounded-panel ring-line',
        )}
      >
        {front === 'computer' ? (
          <ComputerBody
            loading={LiveState.$is('Loading')(state)}
            failed={LiveState.$is('Failed')(state)}
            computer={computer}
          />
        ) : (
          <PageView page={front === 'page' ? page : Option.none()} />
        )}
      </div>
    </aside>
  )
}

/** Who has the keyboard, in the toolbar's long field, with the controls that change it. */
function ComputerToolbar({
  computer,
  on,
}: {
  computer: Option.Option<ComputerRecord>
  on: boolean
}) {
  return (
    <>
      {Option.isSome(computer) && <Keyboard computer={computer.value} />}
      <p
        className="flex h-8 min-w-0 flex-1 items-center justify-center truncate rounded-full bg-surface-2 px-4 text-title font-meta text-ink-3"
        aria-live="polite"
      >
        {Option.match(computer, {
          onNone: () => 'Looking for your computer…',
          onSome: glass,
        })}
      </p>
      {on && (
        <IconButton label="Turn off" onClick={stop}>
          <Power className="size-4" />
        </IconButton>
      )}
    </>
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
      {loading && <Note title="One moment" detail="Looking for your computer." />}
      {failed && (
        <Note title="Not available" detail="Vivid could not reach its computer right now." />
      )}
      {Option.isSome(computer) && <Screen computer={computer.value} />}
    </>
  )
}

/** What the toolbar's long field says: where the computer stands and who is using it. */
const glass = (computer: ComputerRecord) =>
  ComputerState.match(computer.state, {
    Absent: () => 'Not started yet',
    Starting: () => 'Starting up…',
    Running: () =>
      computer.heldByPerson ? 'You have control' : 'Vivid has control · you are watching',
    Stopped: () => 'Turned off · files and sign-ins kept',
    Failed: () => 'Did not start',
    Unavailable: () => 'Not set up here',
  })

const start = () =>
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

/** Taking the keyboard and pointer, or handing them back. Only a running computer has them. */
function Keyboard({ computer }: { computer: ComputerRecord }) {
  if (!ComputerState.guards.Running(computer.state)) return null
  return (
    <Button
      size="sm"
      variant={computer.heldByPerson ? 'primary' : 'control'}
      icon={<Hand className="size-3.5" />}
      onClick={() => hold(!computer.heldByPerson)}
    >
      {computer.heldByPerson ? 'Hand back' : 'Take over'}
    </Button>
  )
}

const TURN_ON = (
  <Button variant="primary" icon={<MonitorPlay className="size-3.5" />} onClick={start}>
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
  Starting: { title: 'Starting up', detail: 'This takes a few seconds.', action: null, busy: true },
  Stopped: {
    title: 'Turned off',
    detail: 'Its files and sign-ins are kept.',
    action: TURN_ON,
    busy: false,
  },
  Unavailable: {
    title: 'Not set up here',
    detail:
      'This installation has no machine provider configured, so Vivid works without a computer.',
    action: null,
    busy: false,
  },
} as const

function Screen({ computer }: { computer: ComputerRecord }) {
  const state = computer.state
  if (ComputerState.guards.Running(state)) {
    // The machine's provider decides how its screen is watched: relayed through this server as a
    // remote-framebuffer socket, or in the provider's own viewer page for this Person's machine.
    if (ComputerScreen.guards.Relay(state.screen)) {
      return (
        <Display
          // Taking over or handing back changes who may type, so the screen reconnects with it.
          key={computer.heldByPerson ? 'held' : 'watching'}
          address={state.screen.address}
          control={computer.heldByPerson}
        />
      )
    }
    return (
      <Viewer
        // A new machine start has a new viewer; the one on screen is not carried over.
        key={state.since}
        address={state.screen.address}
        expiresAt={state.screen.expiresAt}
        control={computer.heldByPerson}
      />
    )
  }
  if (ComputerState.guards.Failed(state)) {
    return (
      <Note
        title="It did not start"
        detail={state.reason}
        action={<Button onClick={start}>Try again</Button>}
      />
    )
  }
  const resting = RESTING[state._tag]
  return (
    <Note
      title={resting.title}
      detail={resting.detail}
      action={resting.action}
      busy={resting.busy}
    />
  )
}

/** How long before a viewer's permission runs out a fresh one is asked for. */
const RENEW_BEFORE_MS = 60_000

/**
 * The provider's own viewer for this Person's machine, in a frame. Its address is a short-lived
 * permission to watch one machine, issued by the server for whoever is signed in here; it is
 * never written anywhere, and before it runs out the server is asked for the next one, so a
 * screen left open keeps showing.
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
    <div className="relative aspect-16/9 max-h-full w-full shrink-0 desktop-wallpaper">
      {/* The viewer is the provider's page on the provider's origin. It needs its scripts and
          its own storage to run; "same origin" here is its origin, never this app's, so the two
          together do not let it out of the frame the way they would for a page of ours. */}
      <iframe
        ref={renew}
        src={shown.address}
        title="Vivid’s computer"
        // oxlint-disable-next-line react/iframe-missing-sandbox
        sandbox="allow-scripts allow-same-origin allow-forms"
        allow="clipboard-read; clipboard-write; fullscreen"
        referrerPolicy="no-referrer"
        className={cn('size-full border-0', !control && 'pointer-events-none')}
      />
    </div>
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
const sightAfter = (now: Sight, heard: Heard): Sight => {
  if (heard === 'opened') return { seen: 'showing', attempt: now.attempt }
  if (heard === 'asked' || now.seen === 'showing') {
    return { seen: 'reaching', attempt: now.attempt + 1 }
  }
  return { seen: 'lost', attempt: now.attempt }
}

/**
 * The machine's screen and the truth about whether it is showing. It used to say "Watching" from
 * the moment the machine ran, whether or not a single frame had arrived, so a socket that never
 * opened was an empty dark panel captioned as a live screen.
 */
function Display({ address, control }: { address: string; control: boolean }) {
  const [sight, hear] = useReducer(sightAfter, { seen: 'reaching', attempt: 0 })
  if (sight.seen === 'lost') {
    return (
      <Note
        title="Can’t see the screen"
        detail="The computer is still running. Its screen did not reach this window."
        action={<Button onClick={() => hear('asked')}>Look again</Button>}
      />
    )
  }
  return (
    <div
      // The machine's screen is 16:10 and the panel is taller, so the glass takes its own shape at
      // the top instead of sitting as a small picture in a tall dark frame.
      className="relative aspect-16/10 max-h-full w-full shrink-0 desktop-wallpaper"
      aria-busy={sight.seen === 'reaching'}
    >
      {/* Each attempt is its own element, so its socket is opened and closed with it. */}
      <Glass key={sight.attempt} address={address} control={control} onHeard={hear} />
      {sight.seen === 'reaching' && (
        <p className="pointer-events-none absolute inset-x-0 bottom-0 bg-scrim px-3 py-1.5 text-center text-meta text-ink-on-color">
          Connecting to the screen…
        </p>
      )}
    </div>
  )
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
 */
export function Glass({
  address,
  control,
  onHeard,
}: {
  address: string
  control: boolean
  onHeard: (heard: Heard) => void
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
      const opened = () => onHeard('opened')
      const closed = () => {
        open = false
        onHeard('closed')
      }
      screen.addEventListener('connect', opened)
      screen.addEventListener('disconnect', closed)
      return () => {
        // Closing it here is this window's own doing, not a screen that was lost.
        screen.removeEventListener('connect', opened)
        screen.removeEventListener('disconnect', closed)
        if (open) screen.disconnect()
      }
    },
    [address, control, onHeard],
  )
  return <div ref={connect} className="size-full" />
}

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
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
      <Face size={36} mood={busy ? 'thinking' : 'neutral'} />
      <h3 className="text-title font-title text-ink">{title}</h3>
      <p className="max-w-xs text-label text-ink-3">{detail}</p>
      {action}
    </div>
  )
}
