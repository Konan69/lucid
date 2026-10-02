import {
  AuditEvent,
  ComputerState,
  ConnectionState,
  type Computer,
  type Connection,
  type ThreadId,
} from '@vivid/contracts'
import { makeWhen, thisReader } from '@vivid/state'
import { Option } from 'effect'
import { ChevronRight, Laptop, Monitor, Plug, Plus } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { live, useLiveValue } from '../../data/live'
import { router } from '../../data/route'
import { cn } from '../../ui/cn'
import { Face, type FaceMood } from '../../ui/Face'
import { Menu } from '../../ui/Menu'
import { auditSentence } from '../settings/Record'

/**
 * Everything around Vivid in one place, opened from the Thread's header: the computers it can
 * work on, the services it is connected to, and what it has lately done here. Each row goes to
 * where that thing is managed, so this is a map and not a second Settings.
 *
 * The layout follows the assistant panel of ChatGPT's dot: who it is and how it is doing at the
 * top, then Computers, then what it did.
 */
export function About({
  open,
  thread,
  mood,
  standing,
  onClose,
  onOpenComputer,
}: {
  open: boolean
  thread: ThreadId
  mood: FaceMood
  /** How Vivid is doing in this Thread, as the header says it. */
  standing: string
  onClose: () => void
  onOpenComputer: () => void
}) {
  return (
    <Menu open={open} onClose={onClose} side="below-end" fill="panel" className="w-80">
      <div className="flex items-center gap-3 px-4 pt-4 pb-3">
        <Face size={44} mood={mood} />
        <div className="min-w-0">
          <p className="font-display text-section font-strong text-ink">Vivid</p>
          <p className="truncate text-label font-meta text-ink-3">{standing}</p>
        </div>
      </div>
      {open && (
        <Around
          thread={thread}
          onOpenComputer={() => {
            onClose()
            onOpenComputer()
          }}
          onClose={onClose}
        />
      )}
    </Menu>
  )
}

/** The record's lines that are something Vivid did, or was stopped from doing, with a service. */
const DONE = [
  'ActionAllowed',
  'ActionApproved',
  'ActionDenied',
  'ActionFailed',
  'ActionBlocked',
  'ActionOutcomeUnknown',
  'ConnectionAdded',
  'ConnectionRemoved',
] as const

const reader = thisReader()
const when = makeWhen(reader)

/** The live parts, mounted only while the panel is open so nothing is watched for a closed one. */
function Around({
  thread,
  onOpenComputer,
  onClose,
}: {
  thread: ThreadId
  onOpenComputer: () => void
  onClose: () => void
}) {
  const computer = useLiveValue(live.computer)
  const connections = useLiveValue(live.connections)
  const audit = useLiveValue(live.audit)
  // "Now" for the times below is when the panel opened; it is not open long enough to drift.
  const [opened] = useState(() => Date.now())
  const settings = (section: 'connections' | 'devices') => {
    onClose()
    router.openSettings(Option.some(section))
  }
  const mine = Option.match(connections, {
    onNone: () => [],
    onSome: (value) => value.connections,
  })
  const here = Option.match(audit, {
    onNone: () => [],
    onSome: (value) =>
      value.entries
        // What Vivid did out in the world from this Thread. What it kept or forgot is in
        // "What Vivid knows", and saying "kept something" four times here told nobody anything.
        .filter((entry) => entry.threadId === thread && AuditEvent.isAnyOf(DONE)(entry.event))
        .slice(0, 4),
  })
  return (
    <div className="pb-2">
      <Heading>Computers</Heading>
      <Row
        icon={<Monitor className="size-4" />}
        title="Vivid’s computer"
        detail={Option.match(computer, {
          onNone: () => 'Looking…',
          onSome: (value) => computerStanding(value.computer),
        })}
        lit={Option.exists(computer, (value) => ComputerState.guards.Running(value.computer.state))}
        onClick={onOpenComputer}
      />
      <Row
        icon={<Laptop className="size-4" />}
        title="Your computer"
        detail="Not connected"
        lit={false}
        onClick={() => settings('devices')}
      />

      <Heading>Integrations</Heading>
      {mine.slice(0, 4).map((connection) => (
        <Row
          key={connection.id}
          icon={<Plug className="size-4" />}
          title={`${connection.serviceName} · ${connection.label}`}
          detail={integrationStanding(connection)}
          lit={ConnectionState.guards.Ready(connection.state)}
          onClick={() => settings('connections')}
        />
      ))}
      <Row
        icon={<Plus className="size-4" />}
        title={mine.length === 0 ? 'Connect your first one' : 'Add another'}
        detail="Mail, calendar, files, anything"
        lit={false}
        onClick={() => settings('connections')}
      />

      <Heading>Recent activity</Heading>
      {here.length === 0 ? (
        <p className="px-4 py-1.5 text-label font-meta text-ink-3">Nothing here yet.</p>
      ) : (
        <ol>
          {here.map((entry) => (
            <li key={entry.id} className="flex items-baseline gap-2 px-4 py-1.5">
              <span className="min-w-0 flex-1 text-label text-ink-2">
                {auditSentence(entry.event)}
              </span>
              <time className="shrink-0 text-meta font-meta text-ink-3">
                {when(entry.at, opened)}
              </time>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

/** Where Vivid's computer stands, in a few words. */
const computerStanding = (computer: Computer) =>
  ComputerState.match(computer.state, {
    Absent: () => 'Not started yet',
    Starting: () => 'Starting up…',
    Running: () => (computer.heldByPerson ? 'On · you have the keyboard' : 'On'),
    Stopped: () => 'Off · files and sign-ins kept',
    Failed: () => 'Did not start',
    Unavailable: () => 'Not set up here',
  })

const integrationStanding = (connection: Connection) =>
  ConnectionState.match(connection.state, {
    Ready: () => 'Connected',
    NeedsAuthorization: () => 'Needs you to sign in',
    Failed: () => 'Stopped working',
  })

function Heading({ children }: { children: ReactNode }) {
  return (
    <h3 className="px-4 pt-3 pb-1 text-meta font-title tracking-caps text-ink-3 uppercase">
      {children}
    </h3>
  )
}

/** One thing around Vivid, and the way to where it is managed. */
function Row({
  icon,
  title,
  detail,
  lit,
  onClick,
}: {
  icon: ReactNode
  title: string
  detail: string
  /** On, connected, working: marked with the one green dot the panel uses. */
  lit: boolean
  onClick: () => void
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className="group/around flex w-full cursor-pointer items-center gap-3 px-4 py-2 text-left transition-colors duration-(--dur-fast) outline-none hover:bg-wash-hover focus-visible:bg-wash-hover"
    >
      <span className="relative inline-flex size-8 shrink-0 items-center justify-center rounded-control bg-surface-2 text-ink-2">
        {icon}
        <i
          aria-hidden
          className={cn(
            'absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-surface-3',
            lit ? 'bg-success' : 'hidden',
          )}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-label font-title text-ink">{title}</span>
        <span className="block truncate text-meta font-meta text-ink-3">{detail}</span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-ink-4 group-hover/around:text-ink-2" />
    </button>
  )
}
