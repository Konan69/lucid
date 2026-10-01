import { ComputerState, type Computer as ComputerRecord } from '@vivid/contracts'
import { Hand, MonitorPlay, Power, X } from 'lucide-react'
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
      <div className="relative min-h-0 flex-1 desktop-wallpaper">
        {/* The screen page is served by this origin and opens a socket back to it with the
            session cookie, which is why it is allowed its own origin. */}
        {/* oxlint-disable-next-line react/iframe-missing-sandbox */}
        <iframe
          title="Vivid’s computer screen"
          src={state.screenAddress}
          className="size-full border-0"
          sandbox="allow-scripts allow-same-origin"
        />
        {computer.heldByPerson && (
          <p className="absolute inset-x-0 bottom-0 bg-scrim px-3 py-2 text-center text-meta text-ink-on-color">
            You have the keyboard. Vivid will wait until you hand it back.
          </p>
        )}
      </div>
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
