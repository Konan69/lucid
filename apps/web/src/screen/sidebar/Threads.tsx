import type { Thread, ThreadId } from '@vivid/contracts'
import { ThreadAudience } from '@vivid/contracts'
import { regenerateThreadTitle } from '@vivid/client-runtime'
import { Data } from 'effect'
import {
  Check,
  CircleCheck,
  FolderInput,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Undo2,
  Users,
} from 'lucide-react'
import { useRef, useState } from 'react'
import { run } from '../../data/app'
import { change, live } from '../../data/live'
import { Route, router } from '../../data/route'
import { orSay } from '../../data/said'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../ui/alertdialog'
import { Faces } from '../../ui/Person'
import { cn } from '../../ui/cn'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../../ui/contextmenu'
import { Count } from '../../ui/Count'
import { useSurface } from '../../ui/Layer'
import { byKeyboard, leave } from '../../ui/motion'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { MoveThread } from '../project/Move'
import { CAPTION, FULL, HOVER, ROW } from './rows'

/**
 * What the Person is in the middle of doing to a Thread from the list. It is one thing at a time,
 * so the title being edited, the Project being chosen and the question before deleting can never
 * be open together. The menu that leads to them is not here: each row owns its own, and it has
 * closed by the time any of these begins.
 */
type Doing = Data.TaggedEnum<{
  Nothing: {}
  Renaming: { readonly id: ThreadId }
  Moving: { readonly thread: Thread }
  Deleting: { readonly thread: Thread }
}>
const Doing = Data.taggedEnum<Doing>()

/**
 * Changes a Thread and shows the change before the server has confirmed it. A refusal takes the
 * change back, and says so: a title that jumped back on its own read as the rename being lost.
 */
function patchThread(
  id: ThreadId,
  patch: { readonly title?: string; readonly archived?: boolean },
) {
  void orSay(
    change(
      (client) => client.PatchThread({ id, patch }),
      () =>
        live.threads.expect((current) => ({
          threads: current.threads.map((thread) =>
            thread.id === id ? { ...thread, ...patch } : thread,
          ),
        })),
    ),
    patch.title === undefined
      ? 'That thread could not be moved just now. Try again.'
      : 'That thread could not be renamed just now. Try again.',
  )
}

/**
 * Asking Vivid for a better title, and which Threads are waiting on one.
 *
 * Nothing is written into the list here: the new title is not known until Vivid has thought of
 * it, and the server publishes the Thread when it has, so every list shows it at once. Until then
 * the row's own title is drawn quieter (`IN_FLUX`), which is the only sign that something was
 * asked. Several Threads can be waiting together, so this is a set and not part of `Doing`. A
 * Thread already waiting is not asked about twice.
 */
function useRetitling() {
  const [waiting, setWaiting] = useState<ReadonlySet<ThreadId>>(() => new Set())
  const retitle = (id: ThreadId) => {
    if (waiting.has(id)) return
    setWaiting((now) => new Set(now).add(id))
    const settle = () => setWaiting((now) => new Set([...now].filter((other) => other !== id)))
    void orSay(
      run(regenerateThreadTitle(id)),
      'Vivid could not think of a better title just now.',
    ).then(settle, settle)
  }
  return { waiting, retitle }
}

/** A title Vivid is thinking of a replacement for: quieter, and still, until the new one lands. */
const IN_FLUX = 'transition-opacity duration-(--dur-fast) aria-busy:opacity-50'

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
export function relativeTime(updatedAt: number, now: number) {
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
  empty,
}: {
  threads: ReadonlyArray<Thread>
  active: ThreadId | null
  /** What to say where the list would be: it differs when the list is one Project's. */
  empty: string
}) {
  const [doing, setDoing] = useState<Doing>(Doing.Nothing())
  const [doneOpen, setDoneOpen] = useState(false)
  const { waiting, retitle } = useRetitling()
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
    // `data-moves` names the row for the list's `settling` (see `Sidebar`): when the Thread
    // changes place, even into another part of the list, the row glides there.
    <li key={thread.id} data-moves={thread.id}>
      <ThreadRow
        thread={thread}
        variant={variant}
        active={thread.id === active}
        now={now}
        renaming={Doing.$is('Renaming')(doing) && doing.id === thread.id}
        retitling={waiting.has(thread.id)}
        onDo={setDoing}
        onRetitle={retitle}
      />
    </li>
  )

  if (threads.length === 0) {
    return <p className="px-2.5 pt-3 text-label font-meta text-pretty text-ink-3">{empty}</p>
  }

  return (
    <>
      {needsYou.length > 0 && (
        <section>
          <Caption label="Needs you" count={needsYou.length} />
          <ul className="flex flex-col gap-px">{needsYou.map((thread) => row(thread, 'card'))}</ul>
        </section>
      )}
      {working.length > 0 && (
        <section>
          <Caption label="Working" count={working.length} />
          <ul className="flex flex-col gap-px">{working.map((thread) => row(thread, 'card'))}</ul>
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
            data-moves="done"
            className={cn(ROW, FULL, HOVER, 'mt-2 text-ink-3 hover:text-ink')}
            aria-expanded={doneOpen}
          >
            <span className="inline-flex size-5.5 items-center justify-center">
              <CircleCheck className="size-4" strokeWidth={1.6} />
            </span>
            <span className="min-w-0 flex-1 text-label">Done</span>
            <span className="text-meta font-meta text-ink-3">
              <Count value={done.length} />
            </span>
          </button>
          {doneOpen && (
            <ul className="flex flex-col gap-px pb-2">
              {done.map((thread) => row(thread, 'line'))}
            </ul>
          )}
        </section>
      )}
      {Doing.$is('Moving')(doing) && <MoveThread thread={doing.thread} onClose={nothing} />}
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
  /** Whether Vivid has been asked for a better title and has not answered yet. */
  readonly retitling: boolean
  readonly onDo: (doing: Doing) => void
  /** Asks Vivid for a better title. The row shows that it was asked. */
  readonly onRetitle: (id: ThreadId) => void
}

/** Fades what a row shows at rest while its action is under the pointer or has the keyboard. */
const AT_REST =
  'transition-opacity duration-(--dur-fast) group-focus-within/thread:opacity-0 group-hover/thread:opacity-0'

/**
 * One Thread in the list. The row is a button that opens the Thread; what else can be done to it
 * sits beside that button, not inside it, so there is never a button within a button.
 *
 * The whole row asks for its menu: a right-click, the keyboard's menu key or a long press opens
 * it where it was asked for. The menu is drawn over the page, not inside the list, so the mask
 * that fades the list's edges cannot cut it, and its choices exist only while it is open.
 */
function ThreadRow(props: RowProps) {
  const { thread, variant, renaming, onDo, onRetitle } = props
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div className="group/thread relative" />}>
        {variant === 'card' ? <CardFace {...props} /> : <LineFace {...props} />}
        {renaming ? (
          <RenameField thread={thread} variant={variant} onClose={() => onDo(Doing.Nothing())} />
        ) : (
          <DoneAction thread={thread} />
        )}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ThreadActions thread={thread} onDo={onDo} onRetitle={onRetitle} />
      </ContextMenuContent>
    </ContextMenu>
  )
}

const openThread = (thread: Thread) => router.go(Route.Thread({ id: thread.id }))

/**
 * A Thread that needs someone or is being worked on. It is the same row as every other Thread,
 * with one more line under the title: the last thing said in it.
 *
 * It used to be a bordered card with its own left edge, a "Needs you" badge and an empty first
 * line. Under a caption that already says "Needs you", the badge said it twice, and the card's
 * words started 12px to the left of the titles in the rows below it, so the list read as two
 * unrelated lists stacked. Now the mark, the title and the time sit on the same three edges in
 * every row; what sets these apart is the colour of the mark, the weight of the title and the
 * second line.
 */
function CardFace({ thread, active, now, retitling, onDo }: RowProps) {
  const needsYou = thread.attention === 'NeedsYou'
  return (
    <button
      onClick={() => openThread(thread)}
      onDoubleClick={() => onDo(Doing.Renaming({ id: thread.id }))}
      aria-current={active ? 'page' : undefined}
      className={cn(ROW, 'items-start py-1.5', active ? 'bg-wash-selected' : HOVER)}
    >
      <span className="inline-flex size-5.5 shrink-0 items-center justify-center">
        <i
          aria-label={needsYou ? 'Needs you' : 'Working'}
          role="img"
          className={cn('size-1.5 rounded-full', needsYou ? 'bg-attention' : 'bg-working')}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex h-5.5 items-center gap-2.5">
          <span
            aria-busy={retitling}
            className={cn('min-w-0 flex-1 truncate text-label font-strong text-ink', IN_FLUX)}
          >
            {thread.title}
          </span>
          <Audience thread={thread} />
          <time className={cn('shrink-0 text-meta font-meta text-ink-3 tabular-nums', AT_REST)}>
            {relativeTime(thread.updatedAt, now)}
          </time>
        </span>
        <span className="block truncate text-meta font-meta text-ink-3">{thread.preview}</span>
      </span>
    </button>
  )
}

/** Any other Thread: a mark that says whether it has something unread, its title, and when. */
function LineFace({ thread, active, now, retitling, onDo }: RowProps) {
  const unread = thread.attention === 'Unread' && !active
  return (
    <button
      onClick={() => openThread(thread)}
      onDoubleClick={() => onDo(Doing.Renaming({ id: thread.id }))}
      aria-current={active ? 'page' : undefined}
      className={cn(ROW, FULL, active ? 'bg-wash-selected' : HOVER)}
    >
      <span className="inline-flex size-5.5 shrink-0 items-center justify-center">
        <i className={cn('size-1.5 rounded-full', unread ? 'bg-primary' : 'bg-line-4')} />
      </span>
      <span
        aria-busy={retitling}
        className={cn(
          'min-w-0 flex-1 truncate text-label',
          IN_FLUX,
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
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            data-row-action
            aria-label={`${label}: ${thread.title}`}
            onClick={(event) => {
              const done = () => patchThread(thread.id, { archived: !thread.archived })
              const row = event.currentTarget.closest('[data-moves]')
              // The row fades out under the pointer first, then the list closes over it: taken
              // away in the same frame, the row below would be under the pointer before the eye
              // had let go of this one. From the keyboard it is done at once.
              if (row === null || byKeyboard(event)) done()
              else void leave(row, 'exit').then(done)
            }}
            className="pointer-events-none absolute top-1.5 right-1.5 z-10 inline-flex size-6 cursor-pointer items-center justify-center rounded-control text-ink-3 opacity-0 transition-opacity duration-(--dur-fast) group-focus-within/thread:pointer-events-auto group-focus-within/thread:opacity-100 group-hover/thread:pointer-events-auto group-hover/thread:opacity-100 hover:bg-wash-hover hover:text-ink active:scale-96"
          />
        }
      >
        {thread.archived ? <Undo2 className="size-3.5" /> : <Check className="size-3.5" />}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/** Where the title sits in each kind of row, so the field lands exactly on the words it edits. */
const FIELD_PLACE = {
  card: 'top-1.5 right-1.5 left-9.5 h-5.5 text-label',
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
        'absolute rounded-xs bg-surface-3 px-1 text-ink edge outline-none edge-primary',
        FIELD_PLACE[variant],
      )}
    />
  )
}

/**
 * Everything that can be done to a Thread from the list, as the choices of its row's menu. The
 * menu closes itself when one is chosen, so each choice only does its thing.
 */
function ThreadActions({
  thread,
  onDo,
  onRetitle,
}: {
  thread: Thread
  onDo: (doing: Doing) => void
  onRetitle: (id: ThreadId) => void
}) {
  return (
    <>
      <ContextMenuItem onClick={() => onDo(Doing.Renaming({ id: thread.id }))}>
        <Pencil className="size-3.5" />
        Rename
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onRetitle(thread.id)}>
        <RefreshCw className="size-3.5" />
        Regenerate title
      </ContextMenuItem>
      <ContextMenuItem onClick={() => patchThread(thread.id, { archived: !thread.archived })}>
        {thread.archived ? <Undo2 className="size-3.5" /> : <Check className="size-3.5" />}
        {thread.archived ? 'Move back to threads' : 'Mark as done'}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onDo(Doing.Moving({ thread }))}>
        <FolderInput className="size-3.5" />
        Move to a project…
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem variant="destructive" onClick={() => onDo(Doing.Deleting({ thread }))}>
        <Trash2 className="size-3.5" />
        Delete…
      </ContextMenuItem>
    </>
  )
}

/**
 * Deleting is the one thing here that cannot be taken back, so it is the one thing that asks, and
 * it asks as an alert: a click outside it does not answer for the Person.
 */
function DeleteThread({ thread, onClose }: { thread: Thread; onClose: () => void }) {
  return (
    <AlertDialog {...useSurface(onClose)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this thread?</AlertDialogTitle>
          <AlertDialogDescription>
            {`“${thread.title}” and everything in it will be gone for everyone who can see it. This cannot be undone.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel variant="ghost">Keep it</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              onClose()
              // Only the Thread on screen has to be left; deleting another one from the list must
              // not take the Person away from what they are reading.
              const here = router.route()
              if (Route.$is('Thread')(here) && here.id === thread.id) router.replace(Route.New())
              void orSay(
                change(
                  (client) => client.DeleteThread({ id: thread.id }),
                  () =>
                    live.threads.expect((current) => ({
                      threads: current.threads.filter((candidate) => candidate.id !== thread.id),
                    })),
                ),
                `“${thread.title}” could not be deleted, so it is back in the list.`,
              )
            }}
          >
            Delete thread
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * The line over each part of the list, with the way to start a Thread at its far end. A Person
 * reading down the list is looking at these lines, so "new" is where the eye already is, on
 * every one of them, not only at the top of the sidebar.
 */
function Caption({ label, count }: { label: string; count?: number }) {
  return (
    <div
      // A caption moves with the rows under it when the list above it grows or closes up.
      data-moves={`caption:${label}`}
      className={cn('mt-1 flex items-center gap-1.5 ps-2.5 pe-1', CAPTION)}
    >
      <h3 className="flex min-w-0 flex-1 items-center gap-1.5 text-meta font-title text-ink-3">
        {label}
        {count !== undefined && (
          <span className="font-meta">
            <Count value={count} />
          </span>
        )}
      </h3>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="New thread"
              onClick={() => router.go(Route.New())}
              className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-control text-ink-3 transition-colors duration-(--dur-fast) hover:bg-wash-hover hover:text-ink focus-visible:-outline-offset-2"
            />
          }
        >
          <Plus className="size-3.5" strokeWidth={1.8} />
        </TooltipTrigger>
        <TooltipContent>New thread</TooltipContent>
      </Tooltip>
    </div>
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
