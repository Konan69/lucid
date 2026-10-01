import type { Thread, ThreadId } from '@vivid/contracts'
import { ThreadAudience } from '@vivid/contracts'
import { Data } from 'effect'
import { Check, CircleCheck, Pencil, Trash2, Undo2, Users } from 'lucide-react'
import { useRef, useState } from 'react'
import { change, live } from '../../data/live'
import { Route, router } from '../../data/route'
import { Faces } from '../../ui/Avatar'
import { Button } from '../../ui/Button'
import { cn } from '../../ui/cn'
import { Dialog, DialogActions } from '../../ui/Dialog'
import { ContextMenu, MenuDivider, MenuItem, type MenuPoint } from '../../ui/Menu'
import { StatusLabel } from '../../ui/Status'
import { CAPTION, FULL, HOVER, ROW } from './rows'

/**
 * What the Person is in the middle of doing to a Thread from the list. It is one thing at a time,
 * so the menu, the title being edited and the question before deleting can never be open together.
 */
type Doing = Data.TaggedEnum<{
  Nothing: {}
  Choosing: { readonly thread: Thread; readonly at: MenuPoint }
  Renaming: { readonly id: ThreadId }
  Deleting: { readonly thread: Thread }
}>
const Doing = Data.taggedEnum<Doing>()

/** Changes a Thread and shows the change before the server has confirmed it. */
function patchThread(
  id: ThreadId,
  patch: { readonly title?: string; readonly archived?: boolean },
) {
  void change(
    (client) => client.PatchThread({ id, patch }),
    () =>
      live.threads.expect((current) => ({
        threads: current.threads.map((thread) =>
          thread.id === id ? { ...thread, ...patch } : thread,
        ),
      })),
  )
}

const DAY = 86_400_000

/** Midnight at the start of the day a moment falls in, in the Person's own clock. */
const startOfDay = (moment: number) => {
  const date = new Date(moment)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

const daysAgo = (updatedAt: number, now: number) =>
  Math.round((startOfDay(now) - startOfDay(updatedAt)) / DAY)

const BANDS = ['Today', 'Yesterday', 'This week', 'Earlier'] as const

/** Which quiet band a Thread belongs in, by when it last moved. */
function band(updatedAt: number, now: number): (typeof BANDS)[number] {
  const days = daysAgo(updatedAt, now)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return days < 7 ? 'This week' : 'Earlier'
}

/** When a Thread last moved, as short as it can be said: the time today, the day this week. */
function relativeTime(updatedAt: number, now: number) {
  const days = daysAgo(updatedAt, now)
  const format: Intl.DateTimeFormatOptions =
    days <= 0
      ? { hour: 'numeric', minute: '2-digit' }
      : days < 7
        ? { weekday: 'short' }
        : { month: 'short', day: 'numeric' }
  return new Intl.DateTimeFormat(undefined, format).format(new Date(updatedAt))
}

/**
 * Every Thread, in the order a busy Person should look at them: what is waiting on them, what
 * Vivid is working on, then everything else by day, then what they are done with. The first two
 * are cards because they are few and they matter; the rest are single lines.
 *
 * A row is quiet. At rest it shows its title and when it last moved. Under the pointer the time
 * gives its place to the one thing most often done to a Thread: marking it done. Renaming is a
 * double-click on the title, and everything else is one right-click away, so a row never grows a
 * strip of buttons.
 */
export function Threads({
  threads,
  active,
}: {
  threads: ReadonlyArray<Thread>
  active: ThreadId | null
}) {
  const [doing, setDoing] = useState<Doing>(Doing.Nothing())
  const [doneOpen, setDoneOpen] = useState(false)
  // Read once when the list mounts: grouping by day does not need to tick.
  const [now] = useState(() => Date.now())
  const current = threads.filter((thread) => !thread.archived)
  const done = threads.filter((thread) => thread.archived)
  const needsYou = current.filter((thread) => thread.attention === 'NeedsYou')
  const working = current.filter((thread) => thread.attention === 'Working')
  const rest = current.filter(
    (thread) => thread.attention !== 'NeedsYou' && thread.attention !== 'Working',
  )
  const nothing = () => setDoing(Doing.Nothing())
  const row = (thread: Thread, variant: Variant) => (
    <li key={thread.id} className={variant === 'card' ? 'py-0.5' : undefined}>
      <ThreadRow
        thread={thread}
        variant={variant}
        active={thread.id === active}
        now={now}
        renaming={Doing.$is('Renaming')(doing) && doing.id === thread.id}
        onDo={setDoing}
      />
    </li>
  )

  if (threads.length === 0) {
    return (
      <p className="px-2.5 pt-3 text-label font-meta text-ink-3">
        Threads you start will appear here.
      </p>
    )
  }

  return (
    <>
      {needsYou.length > 0 && (
        <section>
          <Caption label="Needs you" count={needsYou.length} />
          <ul className="flex flex-col">{needsYou.map((thread) => row(thread, 'card'))}</ul>
        </section>
      )}
      {working.length > 0 && (
        <section>
          <Caption label="Working" count={working.length} />
          <ul className="flex flex-col">{working.map((thread) => row(thread, 'card'))}</ul>
        </section>
      )}
      {BANDS.map((name) => {
        const inBand = rest.filter((thread) => band(thread.updatedAt, now) === name)
        if (inBand.length === 0) return null
        return (
          <section key={name}>
            <Caption label={name} />
            <ul className="flex flex-col gap-px">{inBand.map((thread) => row(thread, 'line'))}</ul>
          </section>
        )
      })}
      {done.length > 0 && (
        <section>
          <button
            onClick={() => setDoneOpen((value) => !value)}
            className={cn(ROW, FULL, HOVER, 'mt-2 text-ink-3 hover:text-ink')}
            aria-expanded={doneOpen}
          >
            <span className="inline-flex size-5.5 items-center justify-center">
              <CircleCheck className="size-4" strokeWidth={1.6} />
            </span>
            <span className="min-w-0 flex-1 text-label">Done</span>
            <span className="text-meta font-meta text-ink-3 tabular-nums">{done.length}</span>
          </button>
          {doneOpen && (
            <ul className="flex flex-col gap-px pb-2">
              {done.map((thread) => row(thread, 'line'))}
            </ul>
          )}
        </section>
      )}
      {Doing.$is('Choosing')(doing) && (
        <ThreadMenu thread={doing.thread} at={doing.at} onDo={setDoing} />
      )}
      {Doing.$is('Deleting')(doing) && <DeleteThread thread={doing.thread} onClose={nothing} />}
    </>
  )
}

type Variant = 'card' | 'line'

interface RowProps {
  readonly thread: Thread
  readonly variant: Variant
  readonly active: boolean
  readonly now: number
  readonly renaming: boolean
  readonly onDo: (doing: Doing) => void
}

/** Fades what a row shows at rest while its action is under the pointer or has the keyboard. */
const AT_REST =
  'transition-opacity duration-(--dur-fast) group-focus-within/thread:opacity-0 group-hover/thread:opacity-0'

/**
 * One Thread in the list. The row is a button that opens the Thread; what else can be done to it
 * sits beside that button, not inside it, so there is never a button within a button.
 */
function ThreadRow(props: RowProps) {
  const { thread, variant, renaming, onDo } = props
  return (
    <div
      className="group/thread relative"
      onContextMenu={(event) => {
        event.preventDefault()
        onDo(Doing.Choosing({ thread, at: { x: event.clientX, y: event.clientY } }))
      }}
    >
      {variant === 'card' ? <CardFace {...props} /> : <LineFace {...props} />}
      {renaming ? (
        <RenameField thread={thread} variant={variant} onClose={() => onDo(Doing.Nothing())} />
      ) : (
        <DoneAction thread={thread} />
      )}
    </div>
  )
}

const openThread = (thread: Thread) => router.go(Route.Thread({ id: thread.id }))

/** A Thread that needs someone or is being worked on: who is in it, its state, its last line. */
function CardFace({ thread, active, onDo }: RowProps) {
  return (
    <button
      onClick={() => openThread(thread)}
      onDoubleClick={() => onDo(Doing.Renaming({ id: thread.id }))}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'relative block h-(--card-row-h) w-full cursor-pointer rounded-card px-2.5 py-2 text-left smooth-shadow-ring-xs transition-surface duration-(--dur-fast) select-none focus-visible:-outline-offset-2',
        active ? 'bg-surface-3' : 'bg-surface-2 hover:bg-wash-hover',
      )}
    >
      <span className="flex h-5 items-center gap-1.5">
        <Audience thread={thread} />
        <span className="flex-1" />
        <span className={AT_REST}>
          <StatusLabel status={thread.attention === 'NeedsYou' ? 'attention' : 'working'} />
        </span>
      </span>
      <span className="mt-0.5 block truncate text-title text-ink">{thread.title}</span>
      <span className="mt-0.5 block truncate text-label font-meta text-ink-3">
        {thread.preview}
      </span>
    </button>
  )
}

/** Any other Thread: a mark that says whether it has something unread, its title, and when. */
function LineFace({ thread, active, now, onDo }: RowProps) {
  const unread = thread.attention === 'Unread' && !active
  return (
    <button
      onClick={() => openThread(thread)}
      onDoubleClick={() => onDo(Doing.Renaming({ id: thread.id }))}
      aria-current={active ? 'page' : undefined}
      className={cn(ROW, FULL, active ? 'bg-wash-selected' : HOVER)}
    >
      <span className="inline-flex size-5.5 shrink-0 items-center justify-center">
        <i className={cn('size-1.5 rounded-full', unread ? 'bg-accent' : 'bg-line-4')} />
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-label',
          unread && 'font-strong',
          unread || active ? 'text-ink' : 'text-ink-2 group-hover/row:text-ink',
        )}
      >
        {thread.title}
      </span>
      <Audience thread={thread} />
      <time className={cn('shrink-0 text-meta font-meta text-ink-3 tabular-nums', AT_REST)}>
        {relativeTime(thread.updatedAt, now)}
      </time>
    </button>
  )
}

/** Who else is in a Thread, as faces for named people and a mark for the whole Company. */
function Audience({ thread }: { thread: Thread }) {
  return ThreadAudience.match(thread.audience, {
    Private: () => null,
    People: ({ participants }) => <Faces people={participants} size={16} />,
    Company: () => (
      <Users className="size-3.5 shrink-0 text-ink-3" aria-label="Shared with the company" />
    ),
  })
}

/**
 * The one thing a row offers under the pointer, in the place its time was: done with this Thread,
 * or, for one already done, back among the others. It has no fill of its own; it is the row's
 * time turned into a verb.
 */
function DoneAction({ thread }: { thread: Thread }) {
  const label = thread.archived ? 'Move back to threads' : 'Mark as done'
  return (
    <button
      data-row-action
      aria-label={`${label}: ${thread.title}`}
      title={label}
      onClick={() => patchThread(thread.id, { archived: !thread.archived })}
      className="pointer-events-none absolute top-1.5 right-1.5 z-10 inline-flex size-6 cursor-pointer items-center justify-center rounded-control text-ink-3 opacity-0 transition-opacity duration-(--dur-fast) group-focus-within/thread:pointer-events-auto group-focus-within/thread:opacity-100 group-hover/thread:pointer-events-auto group-hover/thread:opacity-100 hover:bg-wash-hover hover:text-ink active:scale-96"
    >
      {thread.archived ? <Undo2 className="size-3.5" /> : <Check className="size-3.5" />}
    </button>
  )
}

/** Where the title sits in each kind of row, so the field lands exactly on the words it edits. */
const FIELD_PLACE = {
  card: 'top-7 right-1.5 left-1.5 h-6 text-title',
  line: 'inset-y-1.5 right-1.5 left-9.5 text-label',
} satisfies Record<Variant, string>

/**
 * A Thread's title, being edited where it is. Enter or clicking away keeps the new title, Escape
 * keeps the old one. `settled` is what stops the blur that follows Enter or Escape from being read
 * as a second answer.
 */
function RenameField({
  thread,
  variant,
  onClose,
}: {
  thread: Thread
  variant: Variant
  onClose: () => void
}) {
  const settled = useRef(false)
  const finish = (title: string | null) => {
    if (settled.current) return
    settled.current = true
    const next = title === null ? '' : title.trim()
    if (next.length > 0 && next !== thread.title) patchThread(thread.id, { title: next })
    onClose()
  }
  return (
    <input
      autoFocus
      aria-label={`Rename ${thread.title}`}
      defaultValue={thread.title}
      maxLength={120}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={(event) => finish(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') finish(event.currentTarget.value)
        if (event.key === 'Escape') finish(null)
      }}
      className={cn(
        'absolute rounded-xs bg-surface-3 px-1 text-ink smooth-shadow-ring-xs outline-none smooth-ring-accent',
        FIELD_PLACE[variant],
      )}
    />
  )
}

/** Everything that can be done to a Thread from the list, where the Person asked for it. */
function ThreadMenu({
  thread,
  at,
  onDo,
}: {
  thread: Thread
  at: MenuPoint
  onDo: (doing: Doing) => void
}) {
  return (
    <ContextMenu at={at} onClose={() => onDo(Doing.Nothing())}>
      <MenuItem
        icon={<Pencil className="size-3.5" />}
        onSelect={() => onDo(Doing.Renaming({ id: thread.id }))}
      >
        Rename
      </MenuItem>
      <MenuItem
        icon={thread.archived ? <Undo2 className="size-3.5" /> : <Check className="size-3.5" />}
        onSelect={() => {
          patchThread(thread.id, { archived: !thread.archived })
          onDo(Doing.Nothing())
        }}
      >
        {thread.archived ? 'Move back to threads' : 'Mark as done'}
      </MenuItem>
      <MenuDivider />
      <MenuItem
        tone="danger"
        icon={<Trash2 className="size-3.5" />}
        onSelect={() => onDo(Doing.Deleting({ thread }))}
      >
        Delete…
      </MenuItem>
    </ContextMenu>
  )
}

/** Deleting is the one thing here that cannot be taken back, so it is the one thing that asks. */
function DeleteThread({ thread, onClose }: { thread: Thread; onClose: () => void }) {
  return (
    <Dialog
      title="Delete this thread?"
      description={`“${thread.title}” and everything in it will be gone for everyone who can see it. This cannot be undone.`}
      onClose={onClose}
    >
      <DialogActions>
        <Button variant="ghost" onClick={onClose}>
          Keep it
        </Button>
        <Button
          variant="danger"
          onClick={() => {
            onClose()
            // Only the Thread on screen has to be left; deleting another one from the list must
            // not take the Person away from what they are reading.
            const here = router.route()
            if (Route.$is('Thread')(here) && here.id === thread.id) router.replace(Route.New())
            void change(
              (client) => client.DeleteThread({ id: thread.id }),
              () =>
                live.threads.expect((current) => ({
                  threads: current.threads.filter((candidate) => candidate.id !== thread.id),
                })),
            )
          }}
        >
          Delete thread
        </Button>
      </DialogActions>
    </Dialog>
  )
}

function Caption({ label, count }: { label: string; count?: number }) {
  return (
    <h3
      className={cn(
        'mt-1 flex items-center gap-1.5 px-2.5 text-meta font-title text-ink-3',
        CAPTION,
      )}
    >
      {label}
      {count !== undefined && <span className="font-meta tabular-nums">{count}</span>}
    </h3>
  )
}

/** The list's shape while the first result is on its way: lines, not the empty-state sentence. */
export function ThreadSkeleton() {
  return (
    <ul className="flex flex-col gap-2 px-2.5 pt-3" aria-hidden>
      {['w-40', 'w-32', 'w-44', 'w-28'].map((width) => (
        <li key={width} className={cn('h-3 rounded-full bg-wash-hover', width)} />
      ))}
    </ul>
  )
}
