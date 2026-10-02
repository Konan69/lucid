import { ComputerScreen, ComputerState, type Computer as ComputerRecord } from '@vivid/contracts'
import RFB from '@novnc/novnc'
import { Option, Result } from 'effect'
import { Hand, Maximize2, Minimize2, Monitor, MonitorPlay, Power, X } from 'lucide-react'
import { useCallback, useReducer, useState, useSyncExternalStore } from 'react'
import { change, live, LiveState, useLive } from '../data/live'
import { pages } from '../data/pages'
import { orSay } from '../data/said'
import { Button, IconButton } from '../ui/Button'
import { cn } from '../ui/cn'
import { Face } from '../ui/Face'
import { PageTabs, PageToolbar, PageView } from './computer/Pages'

/**
 * Vivid's computer, beside the Thread: a real machine that is this Person's alone. The panel shows
 * its screen while it runs, says honestly when it is off, starting or unavailable, and gives the
 * Person the one control that matters: taking the keyboard and pointer, which stops Vivid from
 * acting on it until they hand it back.
 *
 * It is laid out like a browser window, after the panel in ChatGPT's dot: a strip of tabs across
 * the top (one today, the computer itself), a toolbar whose long field says what is on the glass
 * and who has the keyboard, and the screen filling the rest. The panel can be widened to work in
 * it, and is a full sheet on a narrow window.
 */
export function Computer({ onClose }: { onClose: () => void }) {
  const state = useLive(live.computer)
  const [wide, setWide] = useState(false)
  const browser = useSyncExternalStore(pages.subscribe, pages.current)
  const front = useSyncExternalStore(pages.subscribe, pages.front)
  const page = pages.showing(browser)
  const computer = LiveState.$is('Ready')(state) ? Option.some(state.value.computer) : Option.none()
  const on = Option.exists(computer, (value) => ComputerState.guards.Running(value.state))
  return (
    <aside
      className={cn(
        'fixed inset-0 z-30 flex size-full shrink-0 animate-fade-in flex-col bg-surface-1 transition-width duration-(--dur-base) ease-out sm:static sm:hairline-l',
        wide ? 'sm:w-(--panel-wide-w)' : 'sm:w-(--panel-w)',
      )}
    >
      <header className="flex h-(--topbar-h) shrink-0 items-center gap-1 px-2">
        {/* Tabs, not a title: in the desktop app, pages opened beside the Thread sit next to the
            computer here. In a browser there is only the computer. */}
        <div className="flex min-w-0 flex-1 scrollbar-hidden items-center gap-1 overflow-x-auto">
          <button
            onClick={pages.toComputer}
            className={cn(
              'flex h-8 max-w-56 min-w-0 shrink-0 cursor-pointer items-center gap-2 rounded-control pr-3 pl-2.5 text-label transition-colors duration-(--dur-fast)',
              front === 'computer'
                ? 'bg-surface-3 font-title text-ink smooth-shadow-ring-xs'
                : 'text-ink-3 hover:bg-wash-hover hover:text-ink',
            )}
          >
            <Monitor className="size-4 shrink-0 text-ink-3" />
            <span className="truncate">Vivid’s computer</span>
            {on && <i aria-hidden className="size-1.5 shrink-0 rounded-full bg-success" />}
          </button>
          {pages.available && <PageTabs open={browser.tabs} front={front} showing={page} />}
        </div>
        <IconButton
          label={wide ? 'Make it narrower' : 'Make it wider'}
          className="hidden sm:inline-flex"
          onClick={() => setWide((now) => !now)}
        >
          {wide ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
        </IconButton>
        <IconButton label="Close" onClick={onClose}>
          <X className="size-4" />
        </IconButton>
      </header>

      <div className="flex h-11 shrink-0 items-center gap-1 px-2 pb-2">
        {front === 'computer' ? (
          <>
            {Option.isSome(computer) && <Keyboard computer={computer.value} />}
            <p
              className="mx-1 flex h-9 min-w-0 flex-1 items-center justify-center truncate rounded-full bg-well px-4 text-label font-meta text-ink-3"
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
        ) : (
          <PageToolbar page={front === 'page' ? page : Option.none()} />
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-t-panel bg-surface-0 hairline-t sm:mx-2 sm:mb-2 sm:rounded-panel sm:ring-line">
        {front === 'computer' ? (
          <>
            {LiveState.$is('Loading')(state) && (
              <Note title="One moment" detail="Looking for your computer." />
            )}
            {LiveState.$is('Failed')(state) && (
              <Note title="Not available" detail="Vivid could not reach its computer right now." />
            )}
            {Option.isSome(computer) && <Screen computer={computer.value} />}
          </>
        ) : (
          <PageView page={front === 'page' ? page : Option.none()} />
        )}
      </div>
    </aside>
  )
}

/** What the toolbar's long field says: where the computer stands and who is using it. */
const glass = (computer: ComputerRecord) =>
  ComputerState.match(computer.state, {
    Absent: () => 'Not started yet',
    Starting: () => 'Starting up…',
    Running: () =>
      computer.heldByPerson ? 'You have the keyboard' : 'Vivid has the keyboard · you are watching',
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
const hold = (held: boolean) =>
  void orSay(
    change((client) => client.HoldComputer({ held })),
    held
      ? 'Vivid still has the keyboard: taking over did not go through. Try again.'
      : 'You still have the keyboard: handing back did not go through. Try again.',
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
function Viewer({
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
type Heard = 'opened' | 'closed' | 'asked'

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
function Glass({
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
