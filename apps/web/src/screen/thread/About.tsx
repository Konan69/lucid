import { AuditEvent, ConnectionState, type Connection, type ThreadId } from '@vivid/contracts'
import { makeWhen, thisReader } from '@vivid/state'
import { Option } from 'effect'
import { Laptop, Plus } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { live, LiveState, useLive, useLiveValue } from '../../data/live'
import { pages } from '../../data/pages'
import { openSettings } from '../../router'
import { wake } from '../../data/wake'
import { engine } from '../../data/runtime'
import { mayCustomise, useAppearance } from '../../data/vivid'
import { Button } from '../../ui/button'
import { cn } from '../../ui/cn'
import { Face, type FaceMood } from '../../ui/Face'
import { holdFocus } from '../../ui/Layer'
import { SkeletonList } from '../../ui/skeleton'
import { auditSentence } from '../settings/Record'
import { Customise } from '../vivid/Customise'
import { Mark } from '../integration/Mark'
import { Heading, Refused, Row, TextButton } from './Rows'
import { Screen } from './Screen'
import { Sides } from './Sides'

/**
 * How far the identity must scroll away before the 48-high bar takes its place: the name's lower
 * edge (24 above the face, the 80 face, 12, one 24 line) has to be under the bar, or the name is
 * on screen twice.
 */
const COMPACT_AFTER_PX = 96

/**
 * Everything around Vivid in one card: who it is and how it is doing, and under that three tabs,
 * as the reference has them (Grok Bot desktop app, the card beside the conversation, screenshots
 * of 5 Oct 2026): Details (the Person's computer, the Integrations Vivid has, what it has lately
 * done here), Library, and Computer (Vivid's own machine, as a picture of its screen). Each row
 * goes to where that thing is managed, so this is a map and not a second Settings.
 *
 * This is the card in a Thread. It opens from three places there (the bar's list button, the face
 * and title at the left of the bar, and Vivid at the top of the conversation) and is the same card
 * from each. Home opens the same card without a Thread: see `AboutHome`.
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
  // The Computer is beside the Thread: the card steps away and the panel comes to the front.
  const openComputer = () => {
    onClose()
    pages.toComputer()
    // Arriving at Vivid's computer turns it on, whether or not the panel was already open.
    wake()
    onOpenComputer()
  }
  return (
    <>
      {/* Only where the card floats. Where it sits beside the conversation, clicking the
          conversation must not close it. */}
      <Scrim className="around-scrim" onClose={onClose} />
      <Frame
        className="absolute around-card z-20 origin-top-right"
        mood={mood}
        standing={standing}
        onClose={onClose}
      >
        <Sides
          details={
            <>
              <Computers onClose={onClose} />
              <Connected onClose={onClose} />
              <section aria-labelledby="around-activity">
                <Heading id="around-activity">Recent activity</Heading>
                <Activity thread={thread} onSeeAll={() => toSettings(onClose, 'record')} />
              </section>
            </>
          }
          computer={<Screen onOpen={Option.some(openComputer)} />}
          onClose={onClose}
        />
      </Frame>
    </>
  )
}

/**
 * The same card on Home, where there is no Thread. It opens from the chip at the leading edge of
 * Home's bar, so it hangs under that chip and grows from it (`origin-top-left`), not from the
 * trailing corner a Thread's card uses.
 *
 * What a Thread's card has and this one does not, because each is about one Thread:
 * - "Recent activity" lists what Vivid did from that Thread. With no Thread there is no such list,
 *   so the section is absent, not empty.
 * - The picture of Vivid's screen is live but is not a button while the machine runs. The Computer
 *   opens beside a Thread (`App.tsx` draws it only on a Thread's route), so from Home it has
 *   nowhere to go and must not look as if it did. A machine that is off can still be turned on.
 *
 * It always floats: Home has no conversation to move aside, so a press anywhere else closes it at
 * every width. The layer under the bar is what places it; it ends 12 above the foot of the page,
 * and the card scrolls inside that when the window is short.
 */
export function AboutHome({
  mood,
  standing,
  onClose,
}: {
  mood: FaceMood
  /** How Vivid is doing across this Person's Threads, in the standing line's words. */
  standing: string
  onClose: () => void
}) {
  return (
    <>
      {/* At every width, unlike a Thread's (`around-scrim` shows it only where the card floats). */}
      <Scrim className="block" onClose={onClose} />
      {/* Home draws Vivid as a Thread does: face at 56 and the name capsule, 104 tall from the
          top of the page. The card hangs centred 8 under that and grows from its top edge. */}
      <div className="pointer-events-none absolute inset-x-0 top-28 bottom-0 z-20 flex items-start justify-center px-3 pb-3">
        <Frame
          className="pointer-events-auto max-h-full w-(--around-w) max-w-full origin-top"
          mood={mood}
          standing={standing}
          onClose={onClose}
        >
          <Sides
            details={
              <>
                <Computers onClose={onClose} />
                <Connected onClose={onClose} />
              </>
            }
            computer={<Screen onOpen={Option.none()} />}
            onClose={onClose}
          />
        </Frame>
      </div>
    </>
  )
}

/** The layer that closes a floating card on a press anywhere else. It is not a tab stop. */
function Scrim({ className, onClose }: { className: string; onClose: () => void }) {
  return (
    <button
      type="button"
      aria-label="Close"
      tabIndex={-1}
      onClick={onClose}
      className={cn('absolute inset-0 z-10 cursor-default', className)}
    />
  )
}

/**
 * The card itself: Vivid's identity, then whatever its place puts under it. `className` is only
 * where it sits and which corner it grows from; everything it looks like is here, so the Thread's
 * card and Home's cannot drift apart.
 *
 * The identity is the reference's calm column (Grok Bot desktop app, screenshots of 5 Oct 2026):
 * the face large and centred, the name under it, one muted line under the name. The reference's
 * face is 118 px in screenshots taken at 150% display scale, which is 79 px of layout: 80 here.
 * Its name is 22 px; the nearest step of Vivid's scale that still fits a long name in a 300 px
 * card is `section` (19). Its muted line is "Add a label"; Vivid's is how Vivid is doing, which
 * is the line this card has always had there. Customise sits in the corner, out of the column.
 */
function Frame({
  className,
  mood,
  standing,
  onClose,
  children,
}: {
  className: string
  mood: FaceMood
  standing: string
  onClose: () => void
  children: ReactNode
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
      <aside
        ref={holdFocus}
        role="dialog"
        aria-label={name}
        tabIndex={-1}
        onKeyDown={(event) => {
          // Only a key pressed in the card itself. The Customise sheet is opened from here and
          // drawn at the end of the document, but React carries its keys up to this card: its
          // Escape closes the sheet, and must not take the card away with it.
          const inside = event.target instanceof Node && event.currentTarget.contains(event.target)
          if (inside && event.key === 'Escape') onClose()
        }}
        onScroll={(event) => setCompact(event.currentTarget.scrollTop > COMPACT_AFTER_PX)}
        className={cn(
          'overflow-y-auto rounded-panel lift-lg glass transition-pop duration-(--dur-fast) ease-out outline-none starting:scale-97 starting:opacity-0',
          className,
        )}
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
        <div className="relative flex flex-col items-center px-4 pt-6 pb-4 text-center">
          {editable && (
            <Button
              variant="ghost"
              size="sm"
              aria-haspopup="dialog"
              className="absolute top-2 right-2"
              onClick={() => setCustomising(true)}
            >
              Customise
            </Button>
          )}
          <Face size={80} mood={mood} />
          <p className="mt-3 max-w-full truncate font-display text-section font-strong text-ink">
            {name}
          </p>
          <p className="mt-0.5 text-title font-meta text-pretty text-ink-3">{standing}</p>
        </div>
        {/* What is under the identity is mounted only while the card is open, so nothing is
            watched for a closed one. */}
        <div className="px-4 pb-4">{children}</div>
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

/** Leaves the card for the part of Settings where a thing around Vivid is managed. */
const toSettings = (onClose: () => void, section: 'connections' | 'devices' | 'record') => {
  onClose()
  void openSettings(section)
}

/**
 * The Person's own computer, which Vivid can work on once it is connected. Vivid's own machine is
 * not here: it is the Computer tab, as a picture of its screen.
 */
function Computers({ onClose }: { onClose: () => void }) {
  return (
    <section aria-labelledby="around-computers">
      <Heading id="around-computers">Computers</Heading>
      <Row
        entry={{
          icon: <Laptop className="size-4" />,
          title: 'Your computer',
          detail: 'Not connected',
          lit: false,
        }}
        onClick={() => toSettings(onClose, 'devices')}
      />
    </section>
  )
}

/** The Integrations section: what Vivid has, and the way to Settings for more. */
function Connected({ onClose }: { onClose: () => void }) {
  return (
    <section aria-labelledby="around-integrations">
      <Heading id="around-integrations">Integrations</Heading>
      <Integrations onOpen={() => toSettings(onClose, 'connections')} />
    </section>
  )
}

/** The Integrations Vivid has, then the way to add one. Failure is not an empty list. */
function Integrations({ onOpen }: { onOpen: () => void }) {
  const state = useLive(live.connections)
  const listed = LiveState.$is('Ready')(state) ? state.value.connections.slice(0, LISTED) : []
  return (
    <>
      {LiveState.$is('Loading')(state) && <SkeletonList of="row" count={1} />}
      {LiveState.$is('Failed')(state) && (
        <Refused onRetry={() => engine.registry.refresh(live.connections.atom)}>
          Your Integrations can’t be reached right now.
        </Refused>
      )}
      {listed.map((connection) => (
        <Row
          key={connection.id}
          entry={{
            icon: <Mark service={{ name: connection.serviceName }} size={16} />,
            // The account's own name ("Gmail (Work)"), which is also what Vivid calls it.
            title: connection.account,
            detail: integrationStanding(connection),
            lit: ConnectionState.guards.Ready(connection.state),
          }}
          onClick={onOpen}
        />
      ))}
      <Row
        entry={{
          icon: <Plus className="size-4" />,
          title: listed.length === 0 ? 'Connect your first one' : 'Add another',
          detail: 'Mail, calendar, files, anything',
          lit: false,
        }}
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
    Loading: () => <SkeletonList of="row" count={1} />,
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

/** An Integration keeps its true state, including the ones that need the Person. */
const integrationStanding = (connection: Connection) =>
  ConnectionState.match(connection.state, {
    Ready: () => 'Connected',
    NeedsAuthorization: () => 'Needs you to sign in',
    Failed: () => 'Stopped working',
  })
