import { DEFAULT_APPEARANCE, type MeResponse } from '@vivid/contracts'
import { Option } from 'effect'
import { Check, ChevronRight, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { live, useLiveValue } from '../../data/live'
import { onboarding } from '../../data/onboarding'
import { mayCustomise, useAppearance } from '../../data/vivid'
import { Card } from '../../ui/Card'
import { cn } from '../../ui/cn'
import { Customise } from '../vivid/Customise'
import { readyOf, Uses } from './Uses'

/**
 * Where each step of getting started stands, read from what is really there: the Person's ready
 * Integrations, Vivid's saved name and look, their Threads. `None` while a list has not arrived,
 * so a step is never shown as undone for the moment before its answer is known.
 */
interface Progress {
  /** The services already connected, by name, which is what the first row says once done. */
  readonly connected: Option.Option<ReadonlyArray<string>>
  /** Whether Vivid has been given a name or a look of the Person's own. */
  readonly named: boolean
  /** Whether the Person has started a Thread. */
  readonly asked: Option.Option<boolean>
}

/** Reads the steps' state. A hook, because each part is its own live query. */
function useProgress(): Progress {
  const connections = useLiveValue(live.connections)
  const threads = useLiveValue(live.threads)
  const appearance = useAppearance()
  return {
    connected: Option.map(connections, (value) =>
      readyOf(value.connections).map((connection) => connection.serviceName),
    ),
    named:
      appearance.name !== DEFAULT_APPEARANCE.name ||
      appearance.look._tag !== DEFAULT_APPEARANCE.look._tag,
    asked: Option.map(threads, (value) => value.threads.length > 0),
  }
}

/**
 * Puts the keyboard in the page's message box. The last row is done by writing, and there is
 * one composer on any screen this list is on; it marks its field with `data-keeps-draft`.
 */
const write = () => {
  const field = document.querySelector<HTMLTextAreaElement>('textarea[data-keeps-draft]')
  if (field !== null) field.focus()
}

/**
 * Whether every step this Person can take is taken. Turning on notifications is not counted:
 * the server cannot register this browser yet, and a list that could never be finished would
 * never leave.
 */
const finished = (progress: Progress, naming: boolean) =>
  Option.exists(progress.connected, (names) => names.length > 0) &&
  (progress.named || !naming) &&
  Option.contains(progress.asked, true)

/**
 * What is left of getting started, as a short list in the first Thread and on Home: connect what
 * you use most, name Vivid, turn on notifications, say one thing you are waiting on or want done.
 *
 * It is not a wizard. Nothing waits on it, every row can be done in any order or not at all, and
 * the composer works from the first second. Each row is drawn from real state, so doing the
 * thing anywhere (Settings, a Thread, another device) ticks it here. It leaves for good when
 * every step is done or when it is closed.
 */
export function Checklist({
  me,
  beside = false,
}: {
  me: MeResponse
  /**
   * Whether Vivid's "What do you use most?" card is already on screen beside this list. Where it
   * is, the first row stays folded: the services are right there and are not drawn twice.
   */
  beside?: boolean
}) {
  const progress = useProgress()
  const naming = mayCustomise(me)
  const { name } = useAppearance()
  const [customising, setCustomising] = useState(false)
  const hasConnected = Option.exists(progress.connected, (names) => names.length > 0)
  // The services stay open until one is connected, then fold; the Person can open them again.
  const [choosing, setChoosing] = useState<Option.Option<boolean>>(Option.none())
  const open = Option.getOrElse(choosing, () => !hasConnected && !beside)
  if (finished(progress, naming)) {
    // Finishing is remembered where it is noticed. `end` is idempotent and tells nobody when
    // nothing changed, so this is the same kind of write as following the Person's theme.
    onboarding.end(me.person.id, 'finished')
    return null
  }
  const steps = [hasConnected, progress.named || !naming, Option.contains(progress.asked, true)]
  const done = steps.filter(Boolean).length
  return (
    // The entrance is the wrapper's: a Card owns its own surface, radius and edge.
    <div className="motion-enter">
      <Card className="p-1.5">
        <div className="flex h-9 items-center gap-2 pr-1 pl-2.5">
          <h2 className="text-label font-title text-ink">Getting started</h2>
          <span className="flex-1 text-meta font-meta text-ink-3 tabular-nums">
            {/* The count steps up when a row is ticked; the key makes it a new number. */}
            <span key={done} className="motion-tick">
              {done}
            </span>{' '}
            of {steps.length} done
          </span>
          <button
            type="button"
            aria-label="Close getting started for good"
            title="Don’t show this again"
            onClick={() => onboarding.end(me.person.id, 'dismissed')}
            className="inline-flex size-7 motion-press cursor-pointer items-center justify-center rounded-row text-ink-3 hover:bg-wash-hover hover:text-ink focus-visible:bg-wash-hover focus-visible:text-ink"
          >
            <X className="size-3.5" />
          </button>
        </div>
        <ol className="flex flex-col">
          <Step
            done={hasConnected}
            title="Connect what you use most"
            detail={Option.match(progress.connected, {
              onNone: () => 'Mail and calendar first',
              onSome: (names) =>
                names.length === 0 ? 'Mail and calendar first' : names.join(', '),
            })}
            expanded={open}
            onPress={() => setChoosing(Option.some(!open))}
          >
            {open && (
              <div className="px-2.5 pt-1 pb-3">
                <Uses />
              </div>
            )}
          </Step>
          {naming && (
            <Step
              done={progress.named}
              title={`Name ${name}`}
              detail={progress.named ? `Called ${name}` : 'Any name, any colour'}
              onPress={() => setCustomising(true)}
            />
          )}
          <Coming
            title="Turn on notifications"
            detail={`So ${name} can reach you when this window is closed`}
          />
          <Step
            done={Option.contains(progress.asked, true)}
            title="Say one thing you’re waiting on or want done"
            detail="Write it in the message box"
            onPress={write}
          />
        </ol>
        {customising && <Customise onClose={() => setCustomising(false)} />}
      </Card>
    </div>
  )
}

const ROW = 'flex min-h-11 w-full items-center gap-3 rounded-control px-2.5 py-2 text-left'

/** The mark at the head of a row: an empty ring to do, a filled tick once done. */
function Tick({ done }: { done: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex size-4.5 shrink-0 items-center justify-center rounded-full',
        done ? 'bg-success text-surface-3' : 'edge edge-field',
      )}
    >
      {done && <Check className="motion-tick size-3" strokeWidth={3} />}
    </span>
  )
}

/** One step: whether it is done, what it is, and a press that does it or opens what does. */
function Step({
  done,
  title,
  detail,
  expanded,
  onPress,
  children,
}: {
  done: boolean
  title: string
  detail: string
  /** Set on the one row that opens in place; absent on rows that open something else. */
  expanded?: boolean
  onPress: () => void
  children?: ReactNode
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onPress}
        aria-expanded={expanded}
        className={cn(
          ROW,
          'group/step cursor-pointer transition-colors duration-(--dur-fast) hover:bg-wash-hover focus-visible:bg-wash-hover',
        )}
      >
        <Tick done={done} />
        <span className="min-w-0 flex-1">
          <span className={cn('block text-label font-title', done ? 'text-ink-3' : 'text-ink')}>
            {title}
            {done && <span className="sr-only"> (done)</span>}
          </span>
          <span className="block truncate text-meta font-meta text-ink-3">{detail}</span>
        </span>
        <ChevronRight
          aria-hidden
          className={cn(
            'size-4 shrink-0 text-ink-4 transition-transform duration-(--dur-fast) group-hover/step:text-ink-2',
            expanded === true && 'rotate-90',
          )}
        />
      </button>
      {children}
    </li>
  )
}

/**
 * A step that is being built and cannot be taken yet. It is shown so the Person knows it is on
 * its way, said to be coming, and is not a button: there is nothing behind it to open.
 */
function Coming({ title, detail }: { title: string; detail: string }) {
  return (
    <li className={cn(ROW, 'cursor-default')}>
      <Tick done={false} />
      <span className="min-w-0 flex-1">
        <span className="block text-label font-title text-ink-3">{title}</span>
        <span className="block truncate text-meta font-meta text-ink-3">{detail}</span>
      </span>
      <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-meta font-meta text-ink-3">
        Coming soon
      </span>
    </li>
  )
}
