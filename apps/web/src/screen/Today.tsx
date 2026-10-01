import {
  Assignee,
  Author,
  FollowUpId,
  TaskId,
  Workspace,
  type MeResponse,
  type PersonSummary,
} from '@vivid/contracts'
import { Data, Option, Result } from 'effect'
import {
  AlertTriangle,
  BellRing,
  Check,
  ChevronRight,
  Circle,
  CircleCheck,
  Clock3,
  MessageSquareText,
  Plus,
  Repeat2,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react'
import { useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react'
import { change, live, LiveState, useLive } from '../data/live'
import type { ProductFailure } from '../data/runtime'
import * as tasksData from '../data/tasks'
import { Avatar } from '../ui/Avatar'
import { Button, IconButton } from '../ui/Button'
import { cn } from '../ui/cn'
import { Face } from '../ui/Face'
import { Field, Input, Select, Textarea } from '../ui/Field'
import { Live } from '../ui/Live'
import { Notice } from '../ui/Notice'
import { Skeleton } from '../ui/Skeleton'

type Task = tasksData.Task
type FollowUp = tasksData.FollowUp
type Notification = tasksData.Notification
type Bucket = tasksData.Bucket

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

/**
 * Every Task the Person can see, in every state. Today reads this one query so that completing,
 * reopening and editing are changes in place: an expectation never has to move a Task between two
 * results.
 */
const allTasks = live.tasks.get('all')

// ── The clock ────────────────────────────────────────────────────────────────

const CLOCK_TICK_MS = 30_000
const clockListeners = new Set<() => void>()
let clockNow = Date.now()
let clockTimer: ReturnType<typeof setInterval> | null = null

/**
 * The wall clock as an external store. "Overdue" and "Tomorrow" depend on the time as well as on
 * the data, and render must stay pure, so every row reads one shared snapshot that moves twice a
 * minute while Today is on screen. This is a clock, not a refetch: nothing is asked of the server.
 */
function subscribeClock(listener: () => void) {
  clockListeners.add(listener)
  if (clockTimer === null) {
    clockNow = Date.now()
    clockTimer = setInterval(() => {
      clockNow = Date.now()
      for (const each of clockListeners) each()
    }, CLOCK_TICK_MS)
  }
  return () => {
    clockListeners.delete(listener)
    if (clockListeners.size === 0 && clockTimer !== null) {
      clearInterval(clockTimer)
      clockTimer = null
    }
  }
}

const readClock = () => clockNow

// ── What the screen holds itself ─────────────────────────────────────────────

/** A follow-up as the form holds it: no time chosen yet means there is no follow-up to send. */
interface FollowUpDraft {
  readonly at: number | null
  readonly note: string
  readonly repeatEveryMs: number | null
}

const NO_FOLLOW_UP: FollowUpDraft = { at: null, note: '', repeatEveryMs: null }

/** Everything the "New task" form holds, kept so a refused save can put it all back. */
interface NewTaskDraft {
  readonly fields: tasksData.TaskFields
  readonly followUp: FollowUpDraft
}

/**
 * What Today is showing: the list, the form for a new Task, or one Task. Which one is local to
 * this screen; the Tasks themselves are never copied into state.
 */
type View = Data.TaggedEnum<{
  Overview: {}
  Creating: { readonly draft: NewTaskDraft }
  Detail: { readonly id: TaskId }
}>
const View = Data.taggedEnum<View>()

/** Who is looking, and where: what every change on this screen is attributed to and scoped by. */
interface Session {
  readonly me: PersonSummary
  readonly workspace: Workspace
}

/** `Person.image` may be left out on the wire; a summary always says whether there is a picture. */
const sessionOf = (me: MeResponse): Session => ({
  me: {
    id: me.person.id,
    name: me.person.name,
    image: me.person.image === undefined ? null : me.person.image,
  },
  workspace: me.workspace,
})

/** What a change came to: nothing to say, or the server's sentence about why it refused. */
const refusal = <Value,>(result: Result.Result<Value, ProductFailure>): Option.Option<string> =>
  Result.isFailure(result) ? Option.some(result.failure.message) : Option.none()

/** The follow-up to send, when the form has a time for one. */
const followUpOf = (draft: FollowUpDraft): Option.Option<tasksData.NewFollowUp> =>
  draft.at === null
    ? Option.none()
    : Option.some({
        id: FollowUpId.make(crypto.randomUUID()),
        at: draft.at,
        note: draft.note.trim(),
        repeatEveryMs: draft.repeatEveryMs,
      })

/** `datetime-local` speaks local wall time with no zone, so the parts are written out by hand. */
function toLocalInput(value: number | null) {
  if (value === null) return ''
  const date = new Date(value)
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** A cleared or half-typed `datetime-local` field is no time at all. */
function fromLocalInput(value: string): number | null {
  if (value === '') return null
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : null
}

// ── Changes ──────────────────────────────────────────────────────────────────

/**
 * Each follow-up action: the call, what the Task will look like once it is accepted, and, if the
 * server refuses, its sentence about why.
 */
const FOLLOW_UP_ACTION = {
  run: async (task: Task, followUp: FollowUp) =>
    refusal(
      await change(
        (client) => client.RunFollowUp({ id: followUp.id }),
        () => allTasks.expect(tasksData.followUpSet(task.id, followUp.id, 'running')),
      ),
    ),
  cancel: async (task: Task, followUp: FollowUp) =>
    refusal(
      await change(
        (client) => client.PatchFollowUp({ id: followUp.id, patch: { status: 'cancelled' } }),
        () => allTasks.expect(tasksData.followUpSet(task.id, followUp.id, 'cancelled')),
      ),
    ),
  delete: async (task: Task, followUp: FollowUp) =>
    refusal(
      await change(
        (client) => client.DeleteFollowUp({ id: followUp.id }),
        () => allTasks.expect(tasksData.followUpRemoved(task.id, followUp.id)),
      ),
    ),
}
type FollowUpAction = keyof typeof FOLLOW_UP_ACTION

/**
 * Every change Today makes. Each one shows its result at once through an expectation on the live
 * query, sends the call, and reports back only if the server refused: the expectation has then
 * already been taken back, and `onRefused` says why in the server's words.
 */
function todayActions(context: {
  readonly session: Session
  readonly onView: (view: View) => void
  readonly onRefused: (message: Option.Option<string>) => void
}) {
  const { session, onView, onRefused } = context

  async function toggle(task: Task) {
    const status = task.status === 'open' ? 'done' : 'open'
    const result = await change(
      (client) => client.PatchTask({ id: task.id, patch: { status } }),
      () => allTasks.expect(tasksData.statusSet(task.id, status, Date.now())),
    )
    onRefused(refusal(result))
  }

  /** Shows the new Task in the list at once; a refused save reopens the form as it was left. */
  async function create(draft: NewTaskDraft) {
    const assignee = tasksData.assigneeInput(draft.fields.assignee)
    if (Option.isNone(assignee)) return
    const id = TaskId.make(crypto.randomUUID())
    const fields = tasksData.settledFields(draft.fields)
    const first = followUpOf(draft.followUp)
    const task = tasksData.draftTask(
      id,
      { fields, followUp: first },
      { me: session.me, now: Date.now() },
    )
    const request = {
      id,
      title: fields.title,
      detail: fields.detail,
      assignee: assignee.value,
      dueAt: fields.dueAt,
      priority: fields.priority,
    }
    onView(View.Overview())
    const result = await change(
      (client) =>
        client.CreateTask(
          Option.match(first, {
            onNone: () => request,
            onSome: (followUp) => ({ ...request, followUp }),
          }),
        ),
      () => allTasks.expect(tasksData.added(task)),
    )
    onRefused(refusal(result))
    if (Result.isFailure(result)) onView(View.Creating({ draft }))
  }

  async function save(task: Task, fields: tasksData.TaskFields) {
    const assignee = tasksData.assigneeInput(fields.assignee)
    if (Option.isNone(assignee)) return
    const settled = tasksData.settledFields(fields)
    const result = await change(
      (client) =>
        client.PatchTask({
          id: task.id,
          patch: {
            title: settled.title,
            detail: settled.detail,
            assignee: assignee.value,
            dueAt: settled.dueAt,
            priority: settled.priority,
          },
        }),
      () => allTasks.expect(tasksData.edited(task.id, settled, Date.now())),
    )
    onRefused(refusal(result))
  }

  /** Leaves the Task's page at once; if the server refuses, the Task is back in the list. */
  async function remove(task: Task) {
    if (!window.confirm(`Delete “${task.title}”? Its follow-ups go with it.`)) return
    onView(View.Overview())
    const result = await change(
      (client) => client.DeleteTask({ id: task.id }),
      () => allTasks.expect(tasksData.removed(task.id)),
    )
    onRefused(refusal(result))
  }

  /** There is nothing to predict here: the server decides what the chase is and the Task says so. */
  async function nudge(task: Task) {
    onRefused(refusal(await change((client) => client.NudgeTask({ id: task.id, nudge: {} }))))
  }

  async function addFollowUp(task: Task, followUp: tasksData.NewFollowUp) {
    const expected = tasksData.scheduledFollowUp(task.id, followUp, {
      me: session.me,
      now: Date.now(),
    })
    const result = await change(
      (client) => client.AddFollowUp({ taskId: task.id, followUp }),
      () => allTasks.expect(tasksData.followUpAdded(expected)),
    )
    onRefused(refusal(result))
    return Result.isSuccess(result)
  }

  async function actOnFollowUp(task: Task, followUp: FollowUp, action: FollowUpAction) {
    onRefused(await FOLLOW_UP_ACTION[action](task, followUp))
  }

  return { actOnFollowUp, addFollowUp, create, nudge, remove, save, toggle }
}

type TodayActions = ReturnType<typeof todayActions>

// ── The screen ───────────────────────────────────────────────────────────────

/**
 * Today: what the Person owes, what was handed to them, and what they are waiting on.
 *
 * Tasks and notifications are live queries; this component holds only which view is open and the
 * last thing the server refused. `onOpenConversation` opens a Thread by id, with the Task's title
 * for the shell to show until the Thread itself has loaded.
 */
export function Today({
  onOpenConversation,
}: {
  onOpenConversation: (conversationId: string, fallbackTitle: string) => void
}) {
  const [view, setView] = useState<View>(View.Overview())
  const [refused, setRefused] = useState<Option.Option<string>>(Option.none())
  const now = useSyncExternalStore(subscribeClock, readClock, readClock)
  const me = useLive(live.me)
  const list = useLive(allTasks)

  // A Task that is open here can be deleted somewhere else. Its page then has nothing to show, so
  // the view falls back to the list instead of holding on to an id that no longer exists.
  const selected = View.$is('Detail')(view)
    ? LiveState.$match(list, {
        Loading: () => Option.none<Task>(),
        Failed: () => Option.none<Task>(),
        Ready: ({ value }) => Option.fromUndefinedOr(value.tasks.find((t) => t.id === view.id)),
      })
    : Option.none<Task>()
  const shown = View.$is('Detail')(view) && Option.isNone(selected) ? View.Overview() : view
  const goTo = (next: View) => {
    setRefused(Option.none())
    setView(next)
  }

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-surface-0 content-edge">
      <TodayHeader
        view={shown}
        selected={selected}
        onBack={() => goTo(View.Overview())}
        onCreate={() => goTo(newTask())}
      />
      <div className="min-h-0 flex-1 overflow-y-auto scroll-fade-y">
        <div className="mx-auto flex w-full max-w-230 flex-col gap-3 px-5 pt-1 pb-10 sm:px-8">
          {Option.isSome(refused) && <Notice>{refused.value}</Notice>}
          <Live state={me} loading={<Skeleton of="row" count={5} />}>
            {(person) => (
              <Live state={list} loading={<Skeleton of="row" count={5} />}>
                {(value) => (
                  <TodayBody
                    session={sessionOf(person)}
                    tasks={value.tasks}
                    view={shown}
                    now={now}
                    onView={setView}
                    onRefused={setRefused}
                    onOpenThread={onOpenConversation}
                  />
                )}
              </Live>
            )}
          </Live>
        </div>
      </div>
    </section>
  )
}

const newTask = () =>
  View.Creating({ draft: { fields: tasksData.emptyFields(), followUp: NO_FOLLOW_UP } })

/** The top bar: where the Person is, the way back from a Task, and the way to a new one. */
function TodayHeader({
  view,
  selected,
  onBack,
  onCreate,
}: {
  view: View
  selected: Option.Option<Task>
  onBack: () => void
  onCreate: () => void
}) {
  const overview = View.$is('Overview')(view)
  const title = View.$match(view, {
    Overview: () => 'Today',
    Creating: () => 'New task',
    Detail: () => Option.match(selected, { onNone: () => 'Today', onSome: (task) => task.title }),
  })
  return (
    <header className="flex h-(--topbar-h) shrink-0 items-center gap-2 px-4">
      {!overview && (
        <IconButton label="Back to Today" onClick={onBack}>
          <ChevronRight className="size-4 rotate-180" />
        </IconButton>
      )}
      <h1 className="min-w-0 flex-1 truncate text-title font-title text-ink">{title}</h1>
      {overview && (
        <IconButton label="New task" onClick={onCreate}>
          <Plus className="size-4" />
        </IconButton>
      )}
    </header>
  )
}

/** Chooses the list, the new-Task form or one Task's page, once both live queries have answered. */
function TodayBody({
  session,
  tasks,
  view,
  now,
  onView,
  onRefused,
  onOpenThread,
}: {
  session: Session
  tasks: ReadonlyArray<Task>
  view: View
  now: number
  onView: (view: View) => void
  onRefused: (message: Option.Option<string>) => void
  onOpenThread: (threadId: string, title: string) => void
}) {
  const actions = todayActions({ session, onView, onRefused })
  return View.$match(view, {
    Overview: () => (
      <TodayOverview
        session={session}
        tasks={tasks}
        now={now}
        onCreate={() => onView(newTask())}
        onSelect={(task) => onView(View.Detail({ id: task.id }))}
        onToggle={(task) => void actions.toggle(task)}
        onOpenThread={onOpenThread}
      />
    ),
    Creating: ({ draft }) => (
      <NewTask
        draft={draft}
        session={session}
        onCancel={() => onView(View.Overview())}
        onCreate={(next) => void actions.create(next)}
      />
    ),
    Detail: ({ id }) => {
      const task = tasks.find((candidate) => candidate.id === id)
      if (task === undefined) return null
      return (
        <TaskDetail
          key={task.id}
          task={task}
          session={session}
          now={now}
          actions={actions}
          onBack={() => onView(View.Overview())}
          onOpenThread={onOpenThread}
        />
      )
    },
  })
}

// ── The list ─────────────────────────────────────────────────────────────────

const GROUP = {
  Yours: { title: 'Yours', note: 'What you owe.' },
  Assigned: { title: 'Assigned to you', note: 'What someone else asked of you.' },
  Waiting: { title: 'Waiting on others', note: 'Vivid drafts the nudge; you send it.' },
} satisfies Record<Bucket, { title: string; note: string }>

/** The date, what is new, the open Tasks in their three groups, and what is already settled. */
function TodayOverview({
  session,
  tasks,
  now,
  onCreate,
  onSelect,
  onToggle,
  onOpenThread,
}: {
  session: Session
  tasks: ReadonlyArray<Task>
  now: number
  onCreate: () => void
  onSelect: (task: Task) => void
  onToggle: (task: Task) => void
  onOpenThread: (threadId: string, title: string) => void
}) {
  const groups = tasksData.groupOpen(tasks, session.me.id)
  const today = new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(now)
  const row = (task: Task) => (
    <li key={task.id}>
      <TaskRow
        task={task}
        me={session.me}
        now={now}
        onOpen={() => onSelect(task)}
        onToggle={() => onToggle(task)}
      />
    </li>
  )
  return (
    <div>
      <p className="px-0.5 text-meta font-meta text-ink-4">{today}</p>
      <TodayNotifications
        now={now}
        onOpen={(notification) => {
          const task = tasks.find((candidate) => candidate.id === notification.taskId)
          if (task !== undefined) onSelect(task)
          else if (notification.threadId !== null)
            onOpenThread(notification.threadId, notification.title)
        }}
      />
      {groups.length === 0 ? (
        <NoOpenTasks onCreate={onCreate} />
      ) : (
        <>
          {groups.map((group) => (
            <Section
              key={group.bucket}
              title={GROUP[group.bucket].title}
              note={GROUP[group.bucket].note}
            >
              <ul className="flex flex-col gap-px">{group.tasks.map(row)}</ul>
            </Section>
          ))}
          <button
            type="button"
            onClick={onCreate}
            className="mt-2 flex w-full cursor-pointer items-center gap-2.5 rounded-row p-2.5 text-left text-ink-3 transition-colors duration-(--dur-fast) hover:bg-wash-hover hover:text-ink"
          >
            <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-control bg-surface-2">
              <Plus className="size-4" />
            </span>
            <span className="text-title">New task</span>
          </button>
        </>
      )}
      <SettledTasks tasks={tasksData.settledOf(tasks)} row={row} />
    </div>
  )
}

/** What Today says when nothing is open: one sentence about how Tasks get here, and the way in. */
function NoOpenTasks({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="mt-7 flex flex-col items-center rounded-card bg-surface-2 px-6 py-10 text-center smooth-shadow-ring-xs">
      <Face size={32} mood="happy" />
      <p className="mt-3 text-title font-title text-ink">Nothing is open.</p>
      <p className="mt-1 mb-4 max-w-sm text-label text-ink-3">
        Ask Vivid to remind you, chase someone or check on something later, and it lands here.
      </p>
      <Button icon={<Plus className="size-3.5" />} onClick={onCreate}>
        New task
      </Button>
    </div>
  )
}

/** Done and dropped Tasks behind a disclosure, newest first, twelve at most. */
function SettledTasks({
  tasks,
  row,
}: {
  tasks: ReadonlyArray<Task>
  row: (task: Task) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  if (tasks.length === 0) return null
  return (
    <div className="mt-6">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex h-(--caption-h) cursor-pointer items-center gap-1.5 rounded-xs px-0.5 text-meta font-title text-ink-4 transition-colors duration-(--dur-fast) hover:text-ink-2"
      >
        <Check className="size-3.5" />
        Done <span className="font-meta">{tasks.length}</span>
      </button>
      {open && <ul className="mt-1 flex flex-col gap-px">{tasks.slice(0, 12).map(row)}</ul>}
    </div>
  )
}

const NOTIFICATION_TONE = {
  tracked: 'bg-accent',
  overdue: 'bg-danger',
  'follow-up': 'bg-working',
  'follow-up-failed': 'bg-danger',
  finished: 'bg-success',
  'needs-you': 'bg-attention',
  shared: 'bg-accent',
  assigned: 'bg-approve',
  invited: 'bg-accent',
} satisfies Record<Notification['kind'], string>

/**
 * What happened since the Person last looked. It draws nothing while loading and nothing when
 * everything has been read: an empty "new" section would only be noise above the Tasks.
 */
function TodayNotifications({
  now,
  onOpen,
}: {
  now: number
  onOpen: (notification: Notification) => void
}) {
  const state = useLive(live.notifications)
  const [refused, setRefused] = useState<Option.Option<string>>(Option.none())

  /** Opening one, or all of them, marks them read at once; the server's count follows. */
  async function read(ids: Option.Option<ReadonlyArray<Notification['id']>>) {
    const result = await change(
      (client) =>
        client.ReadNotifications(
          Option.match(ids, { onNone: () => ({}), onSome: (list) => ({ ids: list }) }),
        ),
      () => live.notifications.expect(tasksData.notificationsRead(ids, Date.now())),
    )
    setRefused(refusal(result))
  }

  return (
    <Live state={state} loading={null}>
      {({ notifications }) => {
        const unread = notifications.filter((notification) => notification.readAt === null)
        if (unread.length === 0 && Option.isNone(refused)) return null
        return (
          <Section
            title="New"
            note={`${unread.length} unread`}
            action={
              <Button variant="quiet" size="sm" onClick={() => void read(Option.none())}>
                Mark all read
              </Button>
            }
          >
            {Option.isSome(refused) && <Notice>{refused.value}</Notice>}
            <ul className="flex flex-col gap-1">
              {unread.map((notification) => (
                <li key={notification.id}>
                  <NotificationRow
                    notification={notification}
                    now={now}
                    onOpen={() => {
                      void read(Option.some([notification.id]))
                      onOpen(notification)
                    }}
                  />
                </li>
              ))}
            </ul>
          </Section>
        )
      }}
    </Live>
  )
}

/** One unread notification: what it is about, and when. Pressing it opens its Task or Thread. */
function NotificationRow({
  notification,
  now,
  onOpen,
}: {
  notification: Notification
  now: number
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full cursor-pointer items-start gap-3 rounded-row bg-surface-2 px-3 py-2.5 text-left smooth-shadow-ring-xs transition-surface duration-(--dur-fast) hover:bg-wash-hover hover:smooth-shadow-ring-sm"
    >
      <i
        className={cn('mt-1.75 size-2 shrink-0 rounded-full', NOTIFICATION_TONE[notification.kind])}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-label font-title text-ink">{notification.title}</span>
        {notification.body !== '' && (
          <span className="mt-0.5 block text-label text-ink-3">{notification.body}</span>
        )}
      </span>
      <time className="shrink-0 pt-0.5 text-meta font-meta text-ink-4 tabular-nums">
        {tasksData.formatWhen(notification.createdAt, now, true)}
      </time>
    </button>
  )
}

// ── One row ──────────────────────────────────────────────────────────────────

/** Whoever owes a Task: a Person by face and name, somebody outside Vivid by name alone. */
function OwnerMark({ owner }: { owner: tasksData.TaskOwner }) {
  return tasksData.TaskOwner.match(owner, {
    Person: ({ person }) => (
      <span className="inline-flex min-w-0 items-center gap-1">
        <Avatar name={person.name} image={person.image} size={14} />
        <span className="truncate">{person.name}</span>
      </span>
    ),
    Outsider: ({ name }) => <span className="truncate">{name}</span>,
  })
}

/** Who a row is about, when that is not simply the Person looking at it. */
function rowPeople(task: Task, me: PersonSummary): ReadonlyArray<{ key: string; node: ReactNode }> {
  const bucket = tasksData.bucketOf(task, me.id)
  const people: Array<{ key: string; node: ReactNode }> = []
  if (bucket === 'Waiting') {
    people.push({
      key: 'owner',
      node: (
        <span className="inline-flex min-w-0 items-center gap-1">
          Waiting on <OwnerMark owner={tasksData.ownerOf(task)} />
        </span>
      ),
    })
  }
  // A Task Vivid made always says so, and for whom; one a Person handed over says who it is from.
  if (Author.guards.Vivid(task.createdBy))
    people.push({ key: 'author', node: tasksData.authorName(task.createdBy) })
  else if (bucket === 'Assigned')
    people.push({ key: 'author', node: `From ${tasksData.authorName(task.createdBy)}` })
  return people
}

/** The dated facts under a row's title: when it is due, when it was settled, when Vivid acts next. */
function rowDates(task: Task, now: number): ReadonlyArray<{ key: string; node: ReactNode }> {
  const dates: Array<{ key: string; node: ReactNode }> = []
  if (task.status === 'open' && task.dueAt !== null) {
    const day = tasksData.formatWhen(task.dueAt, now, false)
    dates.push({
      key: 'due',
      node: tasksData.isOverdue(task, now) ? `Was due ${day}` : `Due ${day}`,
    })
  }
  if (task.status === 'done' && task.completedAt !== null)
    dates.push({ key: 'done', node: `Done ${tasksData.formatWhen(task.completedAt, now, false)}` })
  if (task.status === 'dropped') dates.push({ key: 'dropped', node: 'Dropped' })
  if (task.status === 'open' && task.nextFollowUpAt !== null) {
    const running = task.followUps.some((followUp) => followUp.status === 'running')
    dates.push({
      key: 'next',
      node: (
        <span className="inline-flex items-center gap-1">
          <Face size={12} />
          {running
            ? 'Vivid is on it'
            : `Vivid follows up ${tasksData.formatWhen(task.nextFollowUpAt, now, true)}`}
        </span>
      ),
    })
  }
  return dates
}

/** The mark a row leads with: done, dropped or still open. */
function TaskStatusIcon({ status }: { status: Task['status'] }) {
  if (status === 'done') return <CircleCheck className="size-4.5 text-success" />
  if (status === 'dropped') return <X className="size-4" />
  return <Circle className="size-4.5" strokeWidth={1.6} />
}

/** One Task in a list. The mark settles or reopens it; the rest of the row opens it. */
function TaskRow({
  task,
  me,
  now,
  onOpen,
  onToggle,
}: {
  task: Task
  me: PersonSummary
  now: number
  onOpen: () => void
  onToggle: () => void
}) {
  const settled = task.status !== 'open'
  const overdue = tasksData.isOverdue(task, now)
  const meta = [...rowPeople(task, me), ...rowDates(task, now)]
  return (
    <div
      className={cn(
        'group/row flex items-center gap-2.5 rounded-row px-2.5 py-2 transition-colors duration-(--dur-fast) hover:bg-wash-hover',
        settled && 'opacity-70 hover:opacity-100',
      )}
    >
      <IconButton label={settled ? 'Reopen' : 'Mark done'} onClick={onToggle}>
        <TaskStatusIcon status={task.status} />
      </IconButton>
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-xs text-left"
      >
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              'block truncate text-title',
              settled ? 'text-ink-3 line-through decoration-line-4' : 'text-ink',
            )}
          >
            {task.title}
          </span>
          {meta.length > 0 && (
            <span
              className={cn(
                'mt-0.5 flex min-w-0 items-center gap-1.5 truncate text-meta font-meta',
                overdue ? 'text-danger' : 'text-ink-4',
              )}
            >
              {meta.map((item, index) => (
                <span
                  key={item.key}
                  className={cn('inline-flex min-w-0 items-center', index > 0 && 'sep-dot')}
                >
                  {item.node}
                </span>
              ))}
            </span>
          )}
        </span>
        {task.priority === 'urgent' && !settled && (
          <span className="shrink-0 rounded-full bg-approve-soft px-2 py-0.5 text-meta font-title text-approve">
            Urgent
          </span>
        )}
        <ChevronRight className="size-4 shrink-0 text-ink-4 opacity-0 transition-opacity group-hover/row:opacity-100" />
      </button>
    </div>
  )
}

// ── One Task ─────────────────────────────────────────────────────────────────

/** One Task's page: what can be done to it, its fields, its follow-ups and where it came from. */
function TaskDetail({
  task,
  session,
  now,
  actions,
  onBack,
  onOpenThread,
}: {
  task: Task
  session: Session
  now: number
  actions: TodayActions
  onBack: () => void
  onOpenThread: (threadId: string, title: string) => void
}) {
  const [fields, setFields] = useState(() => tasksData.fieldsOf(task))
  const savable =
    tasksData.fieldsDiffer(task, fields) &&
    fields.title.trim() !== '' &&
    Option.isSome(tasksData.assigneeInput(fields.assignee))

  function save(event: FormEvent) {
    event.preventDefault()
    // The form shows what was sent, so it stops reading as edited the moment it is saved; if the
    // server refuses, the Task goes back and the form still holds the Person's words.
    setFields(tasksData.settledFields(fields))
    void actions.save(task, fields)
  }

  return (
    <div className="pt-2">
      <TaskControls
        task={task}
        me={session.me}
        actions={actions}
        onOpenThread={() => onOpenThread(task.threadId, task.title)}
      />
      {tasksData.isOverdue(task, now) && task.dueAt !== null && (
        <div className="mb-4 flex items-start gap-2 rounded-control bg-danger-soft px-3 py-2.5 text-label text-danger">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <p>
            Past due since {tasksData.formatWhen(task.dueAt, now, true)}. Chase it, move the date or
            close it.
          </p>
        </div>
      )}
      <form onSubmit={save} className="space-y-4">
        <TaskFieldset
          fields={fields}
          workspace={session.workspace}
          focusTitle={false}
          onChange={setFields}
        />
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onBack}>
            Back
          </Button>
          <Button type="submit" variant="primary" disabled={!savable}>
            Save changes
          </Button>
        </div>
      </form>
      <TaskFollowUps
        task={task}
        now={now}
        actions={actions}
        onOpenThread={() => onOpenThread(task.threadId, task.title)}
      />
      <TaskOrigin task={task} now={now} onOpenThread={onOpenThread} />
    </div>
  )
}

/** What the chase button says: who Vivid will chase, or that it will remind the Person themselves. */
const chaseLabel = (task: Task, me: PersonSummary): string =>
  tasksData.TaskOwner.match(tasksData.ownerOf(task), {
    Person: ({ person }) => (person.id === me.id ? 'Remind me now' : `Chase ${person.name} now`),
    Outsider: ({ name }) => `Chase ${name} now`,
  })

/** Settle or reopen, chase, open the Thread it reports into, delete. */
function TaskControls({
  task,
  me,
  actions,
  onOpenThread,
}: {
  task: Task
  me: PersonSummary
  actions: TodayActions
  onOpenThread: () => void
}) {
  // Asking for a chase has no result to predict, so the button itself says it was pressed until
  // the server's next result shows the follow-up it started.
  const [asking, setAsking] = useState(false)
  const open = task.status === 'open'
  const chasing = task.followUps.some((followUp) => followUp.status === 'running')

  async function chase() {
    setAsking(true)
    await actions.nudge(task)
    setAsking(false)
  }

  return (
    <div className="mb-5 flex flex-wrap items-center gap-2 border-b border-line-1 pb-4">
      <Button
        icon={open ? <Check className="size-3.5" /> : <RotateCcw className="size-3.5" />}
        onClick={() => void actions.toggle(task)}
      >
        {open ? 'Mark done' : 'Reopen'}
      </Button>
      {open && (
        <Button
          variant="primary"
          disabled={asking || chasing}
          icon={<BellRing className="size-3.5" />}
          onClick={() => void chase()}
        >
          {asking || chasing ? 'Vivid is on it' : chaseLabel(task, me)}
        </Button>
      )}
      <Button
        variant="ghost"
        icon={<MessageSquareText className="size-3.5" />}
        onClick={onOpenThread}
      >
        Open Thread
      </Button>
      <button
        type="button"
        onClick={() => void actions.remove(task)}
        className="ml-auto inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-control px-3 text-label text-danger transition-colors duration-(--dur-fast) hover:bg-danger-soft"
      >
        <Trash2 className="size-3.5" />
        Delete
      </button>
    </div>
  )
}

/** Who made the Task and when, and the Thread or Routine it came out of. */
function TaskOrigin({
  task,
  now,
  onOpenThread,
}: {
  task: Task
  now: number
  onOpenThread: (threadId: string, title: string) => void
}) {
  const origin = task.origin
  return (
    <p className="mt-5 text-meta font-meta text-ink-4">
      Added by {tasksData.authorName(task.createdBy)},{' '}
      {tasksData.formatWhen(task.createdAt, now, true)}
      {origin.kind === 'thread' && (
        <>
          {' · '}
          <button
            type="button"
            onClick={() => onOpenThread(origin.threadId, task.title)}
            className="cursor-pointer rounded-xs text-ink-3 underline underline-offset-2 transition-colors duration-(--dur-fast) hover:text-ink"
          >
            from a Thread
          </button>
        </>
      )}
      {origin.kind === 'routine' && ' · from a Routine'}
    </p>
  )
}

// ── The fields ───────────────────────────────────────────────────────────────

const PRIORITY = { normal: 'Normal', urgent: 'Urgent' } satisfies Record<Task['priority'], string>

/** The fields a Person edits, the same for a new Task and one that exists. */
function TaskFieldset({
  fields,
  workspace,
  focusTitle,
  onChange,
}: {
  fields: tasksData.TaskFields
  workspace: Workspace
  focusTitle: boolean
  onChange: (fields: tasksData.TaskFields) => void
}) {
  return (
    <>
      <Field label="What">
        <Input
          autoFocus={focusTitle}
          required
          maxLength={200}
          value={fields.title}
          onChange={(event) => onChange({ ...fields, title: event.currentTarget.value })}
          placeholder="Get the signed contract back from Dami"
        />
      </Field>
      <Field label="Detail" hint="optional">
        <Textarea
          maxLength={2000}
          rows={3}
          value={fields.detail}
          onChange={(event) => onChange({ ...fields, detail: event.currentTarget.value })}
          placeholder="Anything Vivid should know when it follows up."
        />
      </Field>
      <div className="grid items-start gap-3 sm:grid-cols-3">
        <AssigneePicker
          workspace={workspace}
          value={fields.assignee}
          onChange={(assignee) => onChange({ ...fields, assignee })}
        />
        <Field label="Due">
          <Input
            type="datetime-local"
            value={toLocalInput(fields.dueAt)}
            onChange={(event) =>
              onChange({ ...fields, dueAt: fromLocalInput(event.currentTarget.value) })
            }
          />
        </Field>
        <Field label="Priority">
          <Select
            value={fields.priority}
            onChange={(event) => {
              const priority = event.currentTarget.value
              if (priority === 'normal' || priority === 'urgent') onChange({ ...fields, priority })
            }}
          >
            {(['normal', 'urgent'] as const).map((priority) => (
              <option key={priority} value={priority}>
                {PRIORITY[priority]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </>
  )
}

/**
 * Who owes the Task. In a Company the choice is nobody, a Member, or someone outside Vivid; in a
 * personal space there are no Members to offer, and the People query is never asked for.
 */
function AssigneePicker({
  workspace,
  value,
  onChange,
}: {
  workspace: Workspace
  value: Assignee
  onChange: (assignee: Assignee) => void
}) {
  return Workspace.match(workspace, {
    Personal: () => (
      <AssigneeChoice members={[]} refused={Option.none()} value={value} onChange={onChange} />
    ),
    Company: () => <CompanyAssignee value={value} onChange={onChange} />,
  })
}

/** The picker with the Company's Members in it, as soon as the People query has answered. */
function CompanyAssignee({
  value,
  onChange,
}: {
  value: Assignee
  onChange: (assignee: Assignee) => void
}) {
  const people = useLive(live.people)
  const { members, refused } = LiveState.$match(people, {
    Loading: () => ({ members: [], refused: Option.none<string>() }),
    Failed: ({ failure }) => ({ members: [], refused: Option.some(failure.message) }),
    Ready: ({ value: answer }) => ({
      members: answer.members.map((member) => member.person),
      refused: Option.none<string>(),
    }),
  })
  return <AssigneeChoice members={members} refused={refused} value={value} onChange={onChange} />
}

const NOBODY = 'nobody'
const OUTSIDER = 'outsider'

/** The select value that stands for one assignee, so the chosen option can be found again. */
const choiceOf = (assignee: Assignee): string =>
  Assignee.match(assignee, {
    Nobody: () => NOBODY,
    Member: ({ person }) => `member:${person.id}`,
    Outsider: () => OUTSIDER,
  })

/** The select, and a name field beside it once "someone outside Vivid" is chosen. */
function AssigneeChoice({
  members,
  refused,
  value,
  onChange,
}: {
  members: ReadonlyArray<PersonSummary>
  refused: Option.Option<string>
  value: Assignee
  onChange: (assignee: Assignee) => void
}) {
  // The Member a Task is already assigned to stays choosable while the People query is loading,
  // and after they have left the Company: the Task still says who they are.
  const current = Assignee.guards.Member(value) ? [value.person] : []
  const offered = [
    ...current.filter((person) => members.every((member) => member.id !== person.id)),
    ...members,
  ]
  const choices = [
    { key: NOBODY, label: 'Nobody', assignee: Assignee.cases.Nobody.make({}) },
    ...offered.map((person) => {
      const assignee = Assignee.cases.Member.make({ person })
      return { key: choiceOf(assignee), label: person.name, assignee }
    }),
    {
      key: OUTSIDER,
      label: 'Someone outside Vivid',
      // Choosing "outside" again keeps the name already typed.
      assignee: Assignee.guards.Outsider(value)
        ? value
        : Assignee.cases.Outsider.make({ name: '' }),
    },
  ]
  return (
    <div className="flex flex-col gap-2">
      <Field label="Assigned to">
        <Select
          value={choiceOf(value)}
          onChange={(event) => {
            const chosen = choices.find((choice) => choice.key === event.currentTarget.value)
            if (chosen !== undefined) onChange(chosen.assignee)
          }}
        >
          {choices.map((choice) => (
            <option key={choice.key} value={choice.key}>
              {choice.label}
            </option>
          ))}
        </Select>
      </Field>
      {Assignee.guards.Outsider(value) && (
        <Input
          required
          maxLength={120}
          aria-label="Their name"
          placeholder="Their name"
          value={value.name}
          onChange={(event) =>
            onChange(Assignee.cases.Outsider.make({ name: event.currentTarget.value }))
          }
        />
      )}
      {Option.isSome(refused) && <Notice>{refused.value}</Notice>}
    </div>
  )
}

// ── A new Task ───────────────────────────────────────────────────────────────

/** The form for a new Task, with an optional first follow-up. It starts from the draft it is given. */
function NewTask({
  draft,
  session,
  onCancel,
  onCreate,
}: {
  draft: NewTaskDraft
  session: Session
  onCancel: () => void
  onCreate: (draft: NewTaskDraft) => void
}) {
  const [fields, setFields] = useState(draft.fields)
  const [followUp, setFollowUp] = useState(draft.followUp)
  const savable =
    fields.title.trim() !== '' && Option.isSome(tasksData.assigneeInput(fields.assignee))
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        onCreate({ fields, followUp })
      }}
      className="space-y-4 pt-2"
    >
      <TaskFieldset fields={fields} workspace={session.workspace} focusTitle onChange={setFields} />
      <div className="rounded-card bg-surface-2 p-4 smooth-shadow-ring-xs">
        <div className="flex items-center gap-2 text-label font-title text-ink-2">
          <Face size={16} />
          First follow-up <span className="font-meta text-ink-4">optional</span>
        </div>
        <FollowUpFields draft={followUp} onChange={setFollowUp} />
      </div>
      <div className="flex items-center justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!savable}>
          Add task
        </Button>
      </div>
    </form>
  )
}

// ── Follow-ups ───────────────────────────────────────────────────────────────

/** When Vivid acts on this Task: what is scheduled or has run, and a form to schedule one more. */
function TaskFollowUps({
  task,
  now,
  actions,
  onOpenThread,
}: {
  task: Task
  now: number
  actions: TodayActions
  onOpenThread: () => void
}) {
  const [draft, setDraft] = useState(NO_FOLLOW_UP)

  /** The row appears and the form clears at once; a refused follow-up puts the form back. */
  async function add(event: FormEvent) {
    event.preventDefault()
    const followUp = followUpOf(draft)
    if (Option.isNone(followUp)) return
    setDraft(NO_FOLLOW_UP)
    if (!(await actions.addFollowUp(task, followUp.value))) setDraft(draft)
  }

  return (
    <div className="mt-7 border-t border-line-1 pt-4">
      <div className="flex items-baseline gap-2.5">
        <h2 className="text-label font-title text-ink-2">Follow-ups</h2>
        <p className="text-meta font-meta text-ink-4">When Vivid acts on this.</p>
      </div>
      {task.followUps.length === 0 ? (
        <p className="mt-2 text-label text-ink-4">None yet.</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {task.followUps.map((followUp) => (
            <li key={followUp.id}>
              <FollowUpRow
                followUp={followUp}
                now={now}
                onAction={(action) => void actions.actOnFollowUp(task, followUp, action)}
                onOpen={onOpenThread}
              />
            </li>
          ))}
        </ul>
      )}
      {task.status === 'open' && (
        <form
          onSubmit={(event) => void add(event)}
          className="mt-3 rounded-card bg-surface-2 p-4 smooth-shadow-ring-xs"
        >
          <div className="flex items-center gap-2 text-label font-title text-ink-2">
            <Plus className="size-3.5" />
            Add a follow-up
          </div>
          <FollowUpFields draft={draft} onChange={setDraft} />
          <div className="mt-3 flex justify-end">
            <Button
              type="submit"
              disabled={draft.at === null}
              icon={<Clock3 className="size-3.5" />}
            >
              Schedule
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}

/** Shortcuts for the times people actually pick. Each is computed when it is pressed. */
const QUICK_TIMES: ReadonlyArray<{ label: string; at: (now: number) => number }> = [
  { label: 'Tomorrow 9:00', at: (now) => tasksData.startOfDay(now) + DAY_MS + 9 * HOUR_MS },
  { label: 'In 3 days', at: (now) => tasksData.startOfDay(now) + 3 * DAY_MS + 9 * HOUR_MS },
  {
    label: 'Next Monday',
    at: (now) => {
      const day = new Date(tasksData.startOfDay(now))
      const delta = (8 - day.getDay()) % 7 || 7
      return day.getTime() + delta * DAY_MS + 9 * HOUR_MS
    },
  },
]

const REPEAT_OPTIONS: ReadonlyArray<{ label: string; every: number | null }> = [
  { label: 'Once', every: null },
  { label: 'Every day', every: DAY_MS },
  { label: 'Every week', every: 7 * DAY_MS },
]

/** When, what to say, and how often: the three things a follow-up is made of. */
function FollowUpFields({
  draft,
  onChange,
}: {
  draft: FollowUpDraft
  onChange: (draft: FollowUpDraft) => void
}) {
  return (
    <div className="mt-3 space-y-2.5">
      <div className="flex flex-wrap gap-1.5">
        {QUICK_TIMES.map((quick) => (
          <Button
            key={quick.label}
            type="button"
            size="sm"
            onClick={() => onChange({ ...draft, at: quick.at(Date.now()) })}
          >
            {quick.label}
          </Button>
        ))}
      </div>
      <div className="grid gap-2 sm:grid-cols-followup">
        <Input
          type="datetime-local"
          aria-label="When"
          value={toLocalInput(draft.at)}
          onChange={(event) =>
            onChange({ ...draft, at: fromLocalInput(event.currentTarget.value) })
          }
        />
        <Input
          maxLength={500}
          aria-label="What to check or say"
          value={draft.note}
          onChange={(event) => onChange({ ...draft, note: event.currentTarget.value })}
          placeholder="What to check or say"
        />
        <Select
          aria-label="Repeat"
          value={String(draft.repeatEveryMs)}
          onChange={(event) => {
            const chosen = REPEAT_OPTIONS.find(
              (option) => String(option.every) === event.currentTarget.value,
            )
            if (chosen !== undefined) onChange({ ...draft, repeatEveryMs: chosen.every })
          }}
        >
          {REPEAT_OPTIONS.map((option) => (
            <option key={option.label} value={String(option.every)}>
              {option.label}
            </option>
          ))}
        </Select>
      </div>
    </div>
  )
}

const FOLLOW_UP = {
  scheduled: { label: 'Scheduled', tone: 'bg-accent' },
  running: { label: 'Vivid is on it', tone: 'animate-status-pulse bg-working' },
  fired: { label: 'Followed up', tone: 'bg-success' },
  failed: { label: 'Failed', tone: 'bg-danger' },
  cancelled: { label: 'Cancelled', tone: 'bg-ink-4' },
} satisfies Record<FollowUp['status'], { label: string; tone: string }>

/** One follow-up: where it stands, when, who scheduled it, and what Vivid said when it ran. */
function FollowUpRow({
  followUp,
  now,
  onAction,
  onOpen,
}: {
  followUp: FollowUp
  now: number
  onAction: (action: FollowUpAction) => void
  onOpen: () => void
}) {
  const repeat = tasksData.describeRepeat(followUp.repeatEveryMs)
  const when = followUp.firedAt === null ? followUp.at : followUp.firedAt
  return (
    <div
      className={cn(
        'rounded-row bg-surface-2 px-3 py-2.5 smooth-shadow-ring-xs',
        followUp.status === 'cancelled' && 'opacity-60',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <i
          className={cn('size-2 shrink-0 rounded-full', FOLLOW_UP[followUp.status].tone)}
          aria-hidden
        />
        <span className="text-label text-ink">{FOLLOW_UP[followUp.status].label}</span>
        <time className="text-meta font-meta text-ink-4 tabular-nums">
          {tasksData.formatWhen(when, now, true)}
        </time>
        {Option.isSome(repeat) && (
          <span className="inline-flex items-center gap-1 text-meta font-meta text-ink-4">
            <Repeat2 className="size-3" />
            {repeat.value}
          </span>
        )}
        <span className="sep-dot text-meta font-meta text-ink-4">
          {tasksData.authorName(followUp.createdBy)}
        </span>
        <FollowUpActions status={followUp.status} onAction={onAction} onOpen={onOpen} />
      </div>
      {followUp.note !== '' && <p className="mt-1 text-meta text-ink-3">{followUp.note}</p>}
      {followUp.output !== null && (
        <p className="mt-1.5 line-clamp-3 text-label whitespace-pre-wrap text-ink-2">
          {followUp.output}
        </p>
      )}
      {followUp.error !== null && <p className="mt-1 text-meta text-danger">{followUp.error}</p>}
    </div>
  )
}

/** What can be done to a follow-up in each state. A running one can only be waited for. */
function FollowUpActions({
  status,
  onAction,
  onOpen,
}: {
  status: FollowUp['status']
  onAction: (action: FollowUpAction) => void
  onOpen: () => void
}) {
  return (
    <span className="ml-auto flex items-center gap-1">
      {status === 'scheduled' && (
        <>
          <Button variant="ghost" size="sm" onClick={() => onAction('run')}>
            Run now
          </Button>
          <Button variant="quiet" size="sm" onClick={() => onAction('cancel')}>
            Cancel
          </Button>
        </>
      )}
      {(status === 'fired' || status === 'failed') && (
        <Button
          variant="ghost"
          size="sm"
          icon={<MessageSquareText className="size-3" />}
          onClick={onOpen}
        >
          Open Thread
        </Button>
      )}
      {(status === 'cancelled' || status === 'failed') && (
        <IconButton label="Remove follow-up" onClick={() => onAction('delete')}>
          <Trash2 className="size-3.5" />
        </IconButton>
      )}
    </span>
  )
}

/** A titled group in the list, with a quieter note beside the title and room for one action. */
function Section({
  title,
  note,
  action,
  children,
}: {
  title: string
  note: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="mt-7">
      <div className="mb-1 flex items-center gap-2.5 border-t border-line-1 px-0.5 pt-4">
        <h2 className="text-label font-title text-ink-2">{title}</h2>
        <p className="truncate text-meta font-meta text-ink-4">{note}</p>
        {action !== undefined && <span className="ml-auto">{action}</span>}
      </div>
      {children}
    </div>
  )
}
