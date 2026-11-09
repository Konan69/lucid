import type { ThreadId } from '@vivid/contracts'
import { owed } from '@vivid/state'
import { Check, Ellipsis } from 'lucide-react'
import { Option } from 'effect'
import type { CSSProperties, ReactNode } from 'react'
import { closeOwed, useStandings } from '../../data/owed'
import { Button } from '../../ui/button'
import { cn } from '../../ui/cn'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../../ui/contextmenu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../ui/dropdownmenu'

/**
 * What the Person is waiting on: one row per record Vivid keeps, soonest due first, the Feed's
 * first section (docs/23, "It chases what I am waiting on"). The direction chosen on 27 October
 * 2026 is the "tide table": every row draws its time as a line on one shared window, so now is
 * the same place on every row and the list reads as one picture of who is late.
 *
 * A row opens the Thread the record came from, where the Person can ask about it. Its right slot
 * says when it is due at rest; a check (received) and a menu (received, drop, open) sit beside it
 * and show on hover, on focus and always on a touch screen. The same menu is on a right click.
 * A row a press has closed folds away where it stood (`motion-fold`) until the list drops it.
 */
export function Owed({
  waiting,
  zone,
  now,
  onOpen,
}: {
  waiting: ReadonlyArray<owed.Waiting>
  /** The Person's own zone: a deadline is a day on their calendar (`owed.owedWordsIn`). */
  zone: Option.Option<string>
  now: number
  onOpen: (thread: ThreadId) => void
}) {
  const standings = useStandings()
  if (Option.isNone(zone) || waiting.length === 0) return null
  const words = owed.owedWordsIn(zone.value)
  return (
    // The rows' fill runs past the page's text edge, so their words line up with the head's.
    <section aria-labelledby="owed-heading" className="-mx-4">
      {/* The caption, and over the rows' tracks the word for the tick every line is cut by: the
          tracks span the same width as this line, so the word sits over the tick. */}
      <div className="relative px-4 pb-1">
        <h2 id="owed-heading" className="text-label font-title text-ink-3">
          Waiting on
        </h2>
        <span aria-hidden className="absolute inset-x-4 bottom-1">
          <Mark
            at={owed.TRACK_NOW}
            span={0}
            className="bottom-0 w-max -translate-x-1/2 text-meta text-ink-3"
          >
            Now
          </Mark>
        </span>
      </div>
      <ul className="flex flex-col">
        {waiting.map((record) => (
          <Row
            key={record.id}
            record={record}
            standing={Option.getOrElse(
              Option.fromUndefinedOr(standings.get(record.id)),
              (): owed.Standing => 'shown',
            )}
            words={words}
            now={now}
            onOpen={() => onOpen(record.threadId)}
          />
        ))}
      </ul>
    </section>
  )
}

/**
 * One record. The whole row opens its Thread (the name's button covers it), and the actions sit
 * above that cover. A press folds the row while it is on its way and after the server took it;
 * a press that did not get through brings the row back with one line saying so.
 */
function Row({
  record,
  standing,
  words,
  now,
  onOpen,
}: {
  record: owed.Waiting
  standing: owed.Standing
  words: owed.OwedWords
  now: number
  onOpen: () => void
}) {
  const folded = standing === 'folded'
  const timing = words.timing(record, now)
  const detail = words.detail(record, now)
  return (
    <li data-folded={folded ? '' : undefined} inert={folded} className="motion-fold">
      <div>
        {standing === 'failed' && (
          <p className="px-3 pt-2 text-label text-danger">
            Not sent. Try again.
          </p>
        )}
        <ContextMenu>
          <ContextMenuTrigger
            render={
              <div className="group/owed relative rounded-row px-4 py-3 transition-colors duration-(--dur-fast) hover:bg-wash-hover has-focus-visible:bg-wash-hover" />
            }
          >
            <div className="flex items-start gap-3">
              <p className="line-clamp-2 min-w-0 flex-1 text-body text-pretty wrap-break-word text-ink-2">
                <button
                  type="button"
                  onClick={onOpen}
                  className="me-2 cursor-pointer font-strong text-ink outline-none after:absolute after:inset-0 after:rounded-row"
                >
                  {record.from}
                </button>
                <span className="font-meta">{record.what}</span>
              </p>
              {/* The slot yields (docs/08): its words at rest, the actions on hover or focus, in
                  the same place, so nothing in the row moves. Where there is no hover, both. */}
              <div className="relative flex shrink-0 items-center justify-end gap-1 pt-px">
                <Actions record={record} onOpen={onOpen} />
                <span
                  className={cn(
                    'text-label whitespace-nowrap tabular-nums group-hover/owed:invisible group-has-focus-visible/owed:invisible group-has-aria-expanded/owed:invisible pointer-coarse:visible',
                    timing.late ? 'text-danger' : 'text-ink-2',
                  )}
                >
                  {timing.words}
                </span>
              </div>
            </div>
            <Track record={record} now={now} className="mt-2.5" />
            <p className="mt-1.5 line-clamp-2 text-label font-meta text-pretty wrap-break-word text-ink-3">
              {detail}
            </p>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem
              onClick={() => closeOwed(record.id, owed.Closing.cases.Resolve.make({}))}
            >
              Received
            </ContextMenuItem>
            <ContextMenuItem onClick={() => closeOwed(record.id, owed.Closing.cases.Drop.make({}))}>
              Stop waiting
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={onOpen}>Open the thread</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </div>
    </li>
  )
}

/**
 * The check and the menu in a row's slot. Hidden at rest so the list stays quiet; shown in place of
 * the due words while the row is hovered or something in it has focus, and beside them where there
 * is no hover. They sit above the row's open cover (`z-10`), so pressing them does not open it.
 */
function Actions({ record, onOpen }: { record: owed.Waiting; onOpen: () => void }) {
  return (
    <span className="absolute inset-e-0 -top-1 z-10 flex items-center opacity-0 group-hover/owed:opacity-100 group-has-focus-visible/owed:opacity-100 has-aria-expanded:opacity-100 pointer-coarse:static pointer-coarse:opacity-100">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Received from ${record.from}`}
        onClick={() => closeOwed(record.id, owed.Closing.cases.Resolve.make({}))}
      >
        <Check strokeWidth={2.25} />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-sm" aria-label={`More for ${record.from}`} />}
        >
          <Ellipsis />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={() => closeOwed(record.id, owed.Closing.cases.Resolve.make({}))}
          >
            Received
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => closeOwed(record.id, owed.Closing.cases.Drop.make({}))}>
            Stop waiting
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onOpen}>Open the thread</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  )
}

/**
 * One piece of a track: a mark or a line, placed from the track's left by `at` and as long as
 * `span`, both fractions of the track. Every piece goes through here so the one place the
 * percentages become CSS is this element.
 */
function Mark({
  at,
  span,
  className,
  children,
}: {
  at: number
  span: number
  className: string
  children?: ReactNode
}) {
  return (
    <span
      className={cn('absolute left-(--at) w-(--span)', className)}
      // SAFETY: React forwards these CSS custom properties; `left-(--at)` and `w-(--span)` read them.
      style={{ '--at': `${at * 100}%`, '--span': `${span * 100}%` } as CSSProperties}
    >
      {children}
    </span>
  )
}

/**
 * A record's time as a line (`owed.trackOf`): a dot where the waiting began, a ring at the last
 * chase, a diamond on the due day, and the tick for now. What has passed is a solid line, what is
 * still ahead is dotted, and the days past due run red. A start older than the window fades in
 * instead of claiming a first day the line cannot show. Decorative: the row's words say all of it.
 */
function Track({
  record,
  now,
  className,
}: {
  record: owed.Waiting
  now: number
  className: string
}) {
  const track = owed.trackOf(record, now)
  const due = Option.getOrUndefined(track.due)
  const chased = Option.getOrUndefined(track.chased)
  const passed = due === undefined || track.late ? owed.TRACK_NOW : Math.min(owed.TRACK_NOW, due.at)
  return (
    <span aria-hidden className={cn('relative block h-3.5', className)}>
      <Mark
        at={track.since.at}
        span={passed - track.since.at}
        className={cn(
          'top-1.5 h-0.5 rounded-full',
          track.since.clipped ? 'bg-linear-to-r from-transparent to-ink-4 to-20%' : 'bg-ink-4',
        )}
      />
      {due !== undefined && !track.late && (
        <Mark
          at={owed.TRACK_NOW}
          span={due.at - owed.TRACK_NOW}
          className="top-1.5 h-0 border-t-2 border-dotted border-line-3"
        />
      )}
      {due !== undefined && track.late && (
        <Mark
          at={due.at}
          span={owed.TRACK_NOW - due.at}
          className="top-1.5 h-0.5 rounded-full bg-danger"
        />
      )}
      {!track.since.clipped && (
        <Mark
          at={track.since.at}
          span={0}
          className="top-1 size-1.5 -translate-x-1/2 rounded-full bg-ink-3"
        />
      )}
      <Mark at={owed.TRACK_NOW} span={0} className="-top-px h-4 w-px bg-ink-3" />
      {chased !== undefined && (
        <Mark
          at={chased.at}
          span={0}
          className="top-0.5 size-2.5 -translate-x-1/2 rounded-full border-2 border-ink-2 bg-surface-0"
        />
      )}
      {due !== undefined && (
        <Mark
          at={due.at}
          span={0}
          className={cn(
            'top-0.5 size-2.5 -translate-x-1/2 rotate-45 border-2 bg-surface-0',
            track.late ? 'border-danger' : 'border-ink-2',
          )}
        />
      )}
    </span>
  )
}
