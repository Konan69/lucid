import { ComputerState, type Computer as ComputerRecord } from '@vivid/contracts'
import RFB from '@novnc/novnc'
import { Hand, MonitorPlay, Power, X } from 'lucide-react'
import { useCallback, useReducer } from 'react'
import { change, live, LiveState, useLive } from '../data/live'
import { Button, IconButton } from '../ui/Button'
import { Face } from '../ui/Face'

/**
 * Vivid's computer, beside the Thread: a real machine that is this Person's alone. The panel shows
 * its screen while it runs, says honestly when it is off, starting or unavailable, and gives the
 * Person the one control that matters: taking the keyboard and pointer, which stops Vivid from
 * acting on it until they hand it back.
 */
export function Computer({ onClose }: { onClose: () => void }) {
  const state = useLive(live.computer)
  return (
    <aside className="fixed inset-0 z-30 flex size-full shrink-0 animate-fade-in flex-col bg-surface-1 sm:static sm:w-(--panel-w) sm:hairline-l">
      <header className="flex h-(--topbar-h) shrink-0 items-center gap-2 px-3 hairline-b">
        <h2 className="flex-1 text-label font-title text-ink">Vivid’s computer</h2>
        {LiveState.$is('Ready')(state) && <Controls computer={state.value.computer} />}
        <IconButton label="Close" onClick={onClose}>
          <X className="size-4" />
        </IconButton>
      </header>
      {LiveState.$is('Loading')(state) && (
        <Note title="One moment" detail="Looking for your computer." />
      )}
      {LiveState.$is('Failed')(state) && (
        <Note title="Not available" detail="Vivid could not reach its computer right now." />
      )}
      {LiveState.$is('Ready')(state) && <Screen computer={state.value.computer} />}
    </aside>
  )
}

const start = () => void change((client) => client.StartComputer())
const stop = () => void change((client) => client.StopComputer())
const hold = (held: boolean) => void change((client) => client.HoldComputer({ held }))

function Controls({ computer }: { computer: ComputerRecord }) {
  if (!ComputerState.guards.Running(computer.state)) return null
  return (
    <>
      <Button
        size="sm"
        variant={computer.heldByPerson ? 'primary' : 'control'}
        icon={<Hand className="size-3.5" />}
        onClick={() => hold(!computer.heldByPerson)}
      >
        {computer.heldByPerson ? 'Hand back' : 'Take over'}
      </Button>
      <IconButton label="Turn off" onClick={stop}>
        <Power className="size-4" />
      </IconButton>
    </>
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
    return (
      <Display
        // Taking over or handing back changes who may type, so the screen reconnects with it.
        key={computer.heldByPerson ? 'held' : 'watching'}
        address={state.screenAddress}
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

/** What the strip under the screen says while there is a screen, or one on its way. */
const CAPTION = {
  reaching: () => 'Connecting to the screen…',
  showing: (control: boolean) =>
    control
      ? 'You have the keyboard. Vivid will wait until you hand it back.'
      : 'Watching. Take over to use it yourself.',
} as const

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
      className="relative min-h-0 flex-1 desktop-wallpaper"
      aria-busy={sight.seen === 'reaching'}
    >
      {/* Each attempt is its own element, so its socket is opened and closed with it. */}
      <Glass key={sight.attempt} address={address} control={control} onHeard={hear} />
      <p className="pointer-events-none absolute inset-x-0 bottom-0 bg-scrim px-3 py-1.5 text-center text-meta text-ink-on-color">
        {CAPTION[sight.seen](control)}
      </p>
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
      const opened = () => onHeard('opened')
      const closed = () => onHeard('closed')
      screen.addEventListener('connect', opened)
      screen.addEventListener('disconnect', closed)
      return () => {
        // Closing it here is this window's own doing, not a screen that was lost.
        screen.removeEventListener('connect', opened)
        screen.removeEventListener('disconnect', closed)
        screen.disconnect()
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
