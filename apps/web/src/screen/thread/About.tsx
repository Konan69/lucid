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
import { live, LiveState, useLive, useLiveValue } from '../../data/live'
import { pages } from '../../data/pages'
import { router } from '../../data/route'
import { engine } from '../../data/runtime'
import { mayCustomise, useAppearance } from '../../data/vivid'
import { Button } from '../../ui/Button'
import { cn } from '../../ui/cn'
import { Face, type FaceMood } from '../../ui/Face'
import { holdFocus } from '../../ui/Layer'
import { Skeleton } from '../../ui/Skeleton'
import { auditSentence } from '../settings/Record'
import { Customise } from '../vivid/Customise'

/** How far the identity must scroll away before the 48-high bar takes its place. */
const COMPACT_AFTER_PX = 56

/**
 * Everything around Vivid in one card: who it is and how it is doing, the computers it can work
 * on, the Integrations it has, and what it has lately done here. Each row goes to where that thing
 * is managed, so this is a map and not a second Settings.
 *
 * It opens from three places in the Thread (the bar's list button, the face and title at the left
 * of the bar, and Vivid at the top of the conversation) and is the same card from each.
 *
 * It is not a menu and not a dialog: it does not take over the page. Where there is room beside a
 * readable column it stays open while the Person works and the conversation steps aside (see
 * `around-space`); below that width it floats over the conversation, and a click anywhere else
 * closes it. Either way, Escape closes it from inside, and focus returns to what opened it.
 */
export function About({
  thread,
  mood,
  standing,
  onClose,
  onOpenComputer,
}: {
  thread: ThreadId
  mood: FaceMood
  /** How Vivid is doing in this Thread, as the bar says it. */
  standing: string
  onClose: () => void
  onOpenComputer: () => void
}) {
  // Past the identity, a compact bar rides the top of the scrolling card.
  const [compact, setCompact] = useState(false)
  // Vivid's own name here, live: the Person's choice, or their Company's.
  const { name } = useAppearance()
  // The way in to the Customise sheet is offered only to someone who may change this Vivid.
  const editable = Option.exists(useLiveValue(live.me), mayCustomise)
  const [customising, setCustomising] = useState(false)
  return (
    <>
      {/* Only where the card floats. Where it sits beside the conversation, clicking the
          conversation must not close it. */}
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 z-10 around-scrim cursor-default"
      />
      <aside
        ref={holdFocus}
        role="dialog"
        aria-label={name}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose()
        }}
        onScroll={(event) => setCompact(event.currentTarget.scrollTop > COMPACT_AFTER_PX)}
        className="absolute around-card z-20 origin-top-right overflow-y-auto rounded-panel smooth-shadow-ring-lg glass transition-pop duration-(--dur-fast) ease-out outline-none starting:scale-97 starting:opacity-0"
      >
        {/* Zero height, so riding the top costs the content below it nothing and the card never
            shifts as the bar comes and goes. */}
        <div aria-hidden={!compact} className="sticky top-0 z-10 h-0">
          <div
            className={cn(
              'absolute inset-x-0 top-0 flex h-12 items-center gap-2.5 bg-surface-3 px-4 hairline-b transition-opacity duration-(--dur-fast)',
              !compact && 'pointer-events-none opacity-0',
            )}
          >
            <Face size={28} mood={mood} />
            <p className="truncate font-display text-title font-strong text-ink">{name}</p>
          </div>
        </div>
        <div className="flex items-center gap-3.5 px-4 pt-5 pb-4">
          <Face size={64} mood={mood} />
          <div className="min-w-0 flex-1">
            <p className="truncate font-display text-section font-strong text-ink">{name}</p>
            <p className="text-title font-meta text-ink-3">{standing}</p>
          </div>
          {editable && (
            <Button
              variant="ghost"
              size="sm"
              aria-haspopup="dialog"
              onClick={() => setCustomising(true)}
            >
              Customise
            </Button>
          )}
        </div>
        <Around
          thread={thread}
          onOpenComputer={() => {
            onClose()
            pages.toComputer()
            onOpenComputer()
          }}
          onClose={onClose}
        />
      </aside>
      {customising && <Customise onClose={() => setCustomising(false)} />}
    </>
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

const when = makeWhen(thisReader())

/** How many Integrations the card lists before the rest are left to Settings. */
const LISTED = 4

/** The sections, mounted only while the card is open so nothing is watched for a closed one. */
function Around({
  thread,
  onOpenComputer,
  onClose,
}: {
  thread: ThreadId
  onOpenComputer: () => void
  onClose: () => void
}) {
  const settings = (section: 'connections' | 'devices' | 'record') => {
    onClose()
    router.openSettings(Option.some(section))
  }
  return (
    <div className="space-y-6 px-4 pb-4">
      <section aria-labelledby="around-computers">
        <Heading id="around-computers">Computers</Heading>
        <Hosted onOpen={onOpenComputer} />
        <Row
          icon={<Laptop className="size-4" />}
          title="Your computer"
          detail="Not connected"
          onClick={() => settings('devices')}
        />
      </section>
      <section aria-labelledby="around-integrations">
        <Heading id="around-integrations">Integrations</Heading>
        <Integrations onOpen={() => settings('connections')} />
      </section>
      <section aria-labelledby="around-activity">
        <Heading id="around-activity">Recent activity</Heading>
        <Activity thread={thread} onSeeAll={() => settings('record')} />
      </section>
    </div>
  )
}

/** Vivid's computer with its true state; a live query, so it is as current as the panel itself. */
function Hosted({ onOpen }: { onOpen: () => void }) {
  const computer = useLive(live.computer)
  return LiveState.$match(computer, {
    Loading: () => <Skeleton of="row" count={1} />,
    Failed: () => (
      <Refused onRetry={() => engine.registry.refresh(live.computer.atom)}>
        Vivid’s computer can’t be reached right now.
      </Refused>
    ),
    Ready: ({ value }) => (
      <Row
        icon={<Monitor className="size-4" />}
        title="Vivid’s computer"
        detail={computerStanding(value.computer)}
        lit={ComputerState.guards.Running(value.computer.state)}
        onClick={onOpen}
      />
    ),
  })
}

/** The Integrations Vivid has, then the way to add one. Failure is not an empty list. */
function Integrations({ onOpen }: { onOpen: () => void }) {
  const state = useLive(live.connections)
  const listed = LiveState.$is('Ready')(state) ? state.value.connections.slice(0, LISTED) : []
  return (
    <>
      {LiveState.$is('Loading')(state) && <Skeleton of="row" count={1} />}
      {LiveState.$is('Failed')(state) && (
        <Refused onRetry={() => engine.registry.refresh(live.connections.atom)}>
          Your Integrations can’t be reached right now.
        </Refused>
      )}
      {listed.map((connection) => (
        <Row
          key={connection.id}
          icon={<Plug className="size-4" />}
          title={`${connection.serviceName} · ${connection.label}`}
          detail={integrationStanding(connection)}
          lit={ConnectionState.guards.Ready(connection.state)}
          onClick={onOpen}
        />
      ))}
      <Row
        icon={<Plus className="size-4" />}
        title={listed.length === 0 ? 'Connect your first one' : 'Add another'}
        detail="Mail, calendar, files, anything"
        onClick={onOpen}
      />
    </>
  )
}

/** What Vivid did out in the world from this Thread: four lines, and the rest a press away. */
function Activity({ thread, onSeeAll }: { thread: ThreadId; onSeeAll: () => void }) {
  const state = useLive(live.audit)
  // "Now" for the times below is when the card opened; it is not open long enough to drift.
  const [opened] = useState(() => Date.now())
  const [count, setCount] = useState(LISTED)
  return LiveState.$match(state, {
    Loading: () => <Skeleton of="row" count={1} />,
    Failed: () => (
      <Refused onRetry={() => engine.registry.refresh(live.audit.atom)}>
        The record can’t be reached right now.
      </Refused>
    ),
    Ready: ({ value }) => {
      // What it kept or forgot is in "What Vivid knows"; "kept something" four times told nobody anything.
      const entries = value.entries.filter(
        (entry) => entry.threadId === thread && AuditEvent.isAnyOf(DONE)(entry.event),
      )
      if (entries.length === 0) {
        return <p className="py-1.5 text-label font-meta text-ink-3">Nothing here yet.</p>
      }
      return (
        <>
          <ol>
            {entries.slice(0, count).map((entry) => (
              <li key={entry.id} className="py-1.5">
                <p className="text-label text-ink-2">{auditSentence(entry.event)}</p>
                <time
                  dateTime={new Date(entry.at).toISOString()}
                  className="text-meta font-meta text-ink-3"
                >
                  {when(entry.at, opened)}
                </time>
              </li>
            ))}
          </ol>
          <div className="mt-1 flex gap-3 text-label">
            {entries.length > count && (
              <TextButton onClick={() => setCount((shown) => shown + LISTED)}>Show more</TextButton>
            )}
            <TextButton onClick={onSeeAll}>Open the record</TextButton>
          </div>
        </>
      )
    },
  })
}

/** Where Vivid's computer stands, in a few words. */
const computerStanding = (computer: Computer) =>
  ComputerState.match(computer.state, {
    Absent: () => 'Not started yet',
    Starting: () => 'Starting up…',
    Running: () =>
      computer.heldByPerson ? 'On · you have the keyboard' : 'On · Vivid has the keyboard',
    Stopped: () => 'Off · files and sign-ins kept',
    Failed: () => 'Did not start',
    Unavailable: () => 'Not set up here',
  })

/** An Integration keeps its true state, including the ones that need the Person. */
const integrationStanding = (connection: Connection) =>
  ConnectionState.match(connection.state, {
    Ready: () => 'Connected',
    NeedsAuthorization: () => 'Needs you to sign in',
    Failed: () => 'Stopped working',
  })

/** A section's name: quiet, in sentence case, so the rows under it carry the weight. */
function Heading({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h3 id={id} className="mb-1.5 text-title font-title text-ink-3">
      {children}
    </h3>
  )
}

/** A link-weight action under a list: text, so it is not mistaken for another row. */
function TextButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="-mx-1 cursor-pointer rounded-xs px-1 py-0.5 text-ink-3 transition-press duration-(--dur-fast) hover:text-ink focus-visible:text-ink active:scale-96"
    >
      {children}
    </button>
  )
}

/** A failed read says so, and retries only that one subscription; the other sections stay warm. */
function Refused({ children, onRetry }: { children: ReactNode; onRetry: () => void }) {
  return (
    <p className="py-1.5 text-label text-ink-3" role="status">
      {children} <TextButton onClick={onRetry}>Try again</TextButton>
    </p>
  )
}

/**
 * One thing around Vivid: an icon (with a green dot while it is on or connected), what it is and
 * where it stands, and a chevron because it goes somewhere. The hover fill reaches 8 beyond the
 * text on each side so the text keeps the heading's edge.
 */
function Row({
  icon,
  title,
  detail,
  lit = false,
  onClick,
}: {
  icon: ReactNode
  title: string
  detail: string
  lit?: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="group/row -mx-2 flex min-h-11 cursor-pointer items-center gap-2.5 rounded-row px-2 py-1 text-left transition-press duration-(--dur-fast) outline-none hover:bg-wash-hover focus-visible:bg-wash-hover active:scale-98"
    >
      <span className="relative inline-flex size-5 shrink-0 items-center justify-center text-ink-2">
        {icon}
        {lit && (
          <i
            aria-hidden
            className="absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full bg-success ring-2 ring-surface-3"
          />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-title font-title text-ink">{title}</span>
        <span className="block truncate text-label font-meta text-ink-3">{detail}</span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-ink-4 transition-colors duration-(--dur-fast) group-hover/row:text-ink-3" />
    </button>
  )
}
