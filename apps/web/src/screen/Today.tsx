import * as Result from 'effect/Result'
import {
  AlertTriangle,
  BellRing,
  Check,
  ChevronRight,
  Circle,
  CircleCheck,
  Clock3,
  LoaderCircle,
  MessageSquareText,
  Plus,
  Repeat2,
  RotateCcw,
  Trash2,
  UserRound,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useState, useSyncExternalStore, type FormEvent } from 'react'
import * as tasksData from '../data/tasks'
import { run } from '../data/runtime'
import { cn } from '../ui/cn'
import { Face } from '../ui/Face'

export type TaskStatus = tasksData.TaskStatus
export type TaskPriority = tasksData.TaskPriority
export type FollowUp = tasksData.FollowUp
export type Task = tasksData.Task
export type Notification = tasksData.Notification

const DAY_MS = 86_400_000
const CURRENT_TIME_REFRESH_MS = 15_000
const currentTimeListeners = new Set<() => void>()
let currentTime = Date.now()
let currentTimeTimer: number | null = null

/**
 * Keeps render-time date comparisons on one stable snapshot while the Today screen is mounted.
 * The shared timer matches the screen's idle refresh cadence and is released with the last row.
 */
function subscribeCurrentTime(listener: () => void) {
  currentTimeListeners.add(listener)
  if (currentTimeTimer === null) {
    const update = () => {
      currentTime = Date.now()
      for (const currentListener of currentTimeListeners) currentListener()
    }
    update()
    currentTimeTimer = window.setInterval(update, CURRENT_TIME_REFRESH_MS)
  }
  return () => {
    currentTimeListeners.delete(listener)
    if (currentTimeListeners.size === 0 && currentTimeTimer !== null) {
      window.clearInterval(currentTimeTimer)
      currentTimeTimer = null
    }
  }
}

function getCurrentTime() {
  return currentTime
}

function useCurrentTime() {
  return useSyncExternalStore(subscribeCurrentTime, getCurrentTime, getCurrentTime)
}

const REPEAT_OPTIONS = [
  { label: 'Once', value: '' },
  { label: 'Every day', value: String(DAY_MS) },
  { label: 'Every week', value: String(7 * DAY_MS) },
] as const

const NOTIFICATION_TONE = {
  tracked: 'bg-accent',
  overdue: 'bg-danger',
  'follow-up': 'bg-working',
  'follow-up-failed': 'bg-danger',
} satisfies Record<Notification['kind'], string>

function startOfDay(value: number) {
  const date = new Date(value)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** "Today 14:30", "Tomorrow 09:00", "Fri 5 Sep, 09:00". Dates matter here, so we never say "2h ago". */
export function formatWhen(value: number, withTime = true) {
  const days = Math.round((startOfDay(value) - startOfDay(Date.now())) / DAY_MS)
  const time = withTime
    ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(value)
    : ''
  const day =
    days === 0
      ? 'Today'
      : days === 1
        ? 'Tomorrow'
        : days === -1
          ? 'Yesterday'
          : new Intl.DateTimeFormat(undefined, {
              weekday: 'short',
              day: 'numeric',
              month: 'short',
            }).format(value)
  return withTime ? `${day} ${time}`.trim() : day
}

function toLocalInput(value: number | null) {
  if (value === null) return ''
  const date = new Date(value)
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function fromLocalInput(value: string): number | null {
  if (!value) return null
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : null
}

function describeRepeat(repeatEveryMs: number | null) {
  if (!repeatEveryMs) return null
  if (repeatEveryMs === DAY_MS) return 'every day'
  if (repeatEveryMs === 7 * DAY_MS) return 'every week'
  return `every ${Math.round(repeatEveryMs / 3_600_000)}h`
}

type Group = { key: string; label: string; note?: string; tasks: Task[] }

function groupTasks(tasks: Task[], now: number): Group[] {
  const endOfToday = startOfDay(now) + DAY_MS
  const open = tasks.filter((task) => task.status === 'open')
  const taken = new Set<string>()
  const pick = (
    key: string,
    label: string,
    note: string | null,
    test: (task: Task) => boolean,
  ): Group => {
    const picked = open.filter((task) => !taken.has(task.id) && test(task))
    for (const task of picked) taken.add(task.id)
    const group = { key, label, tasks: picked }
    if (note === null) return group
    return { ...group, note }
  }
  return [
    pick(
      'overdue',
      'Overdue',
      'Vivid has already started chasing these.',
      (task) => task.dueAt !== null && task.dueAt < now,
    ),
    pick('today', 'Due today', null, (task) => task.dueAt !== null && task.dueAt < endOfToday),
    pick(
      'waiting',
      'Waiting on others',
      'Vivid drafts the nudge; you send it.',
      (task) => task.assignee !== null,
    ),
    pick('upcoming', 'Vivid follows up', null, (task) => task.nextFollowUpAt !== null),
    pick('later', 'Later', null, () => true),
  ].filter((group) => group.tasks.length > 0)
}

/** Owns Today hooks in their original order while exposing typed state to screen actions. */
function useTodayState() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [doneOpen, setDoneOpen] = useState(false)

  const load = useCallback(async () => {
    const result = await run(tasksData.load())
    setReady(true)
    if (Result.isFailure(result)) {
      setError(result.failure.message)
      return
    }
    setTasks(result.success.tasks)
    setNotifications(result.success.notifications)
    setError(null)
  }, [])

  useEffect(() => {
    let cancelled = false

    // Initial hydration is an external request. Polling and user-triggered refreshes continue to
    // use `load`, while this mount request ignores responses after the screen is removed.
    void run(tasksData.load()).then((result) => {
      if (cancelled) return
      setReady(true)
      if (Result.isFailure(result)) {
        setError(result.failure.message)
        return
      }
      setTasks(result.success.tasks)
      setNotifications(result.success.notifications)
      setError(null)
    })

    return () => {
      cancelled = true
    }
  }, [])
  useEffect(() => {
    const running = tasks.some((task) =>
      task.followUps.some((followUp) => followUp.status === 'running'),
    )
    const timer = window.setInterval(
      () => {
        void load()
      },
      running ? 1500 : 15_000,
    )
    return () => window.clearInterval(timer)
  }, [load, tasks])

  return {
    creating,
    doneOpen,
    error,
    load,
    notifications,
    ready,
    selectedId,
    setCreating,
    setDoneOpen,
    setError,
    setSelectedId,
    tasks,
  }
}

type TodayState = ReturnType<typeof useTodayState>

/** Owns task and notification mutations outside the screen's render decisions. */
function createTodayActions(
  state: TodayState,
  onOpenConversation: (conversationId: string, fallbackTitle: string) => void,
) {
  const { load, setError, setSelectedId, tasks } = state

  async function toggleDone(task: Task) {
    const status = task.status === 'open' ? 'done' : 'open'
    const result = await run(tasksData.setStatus(task.id, status))
    if (Result.isFailure(result)) {
      setError(result.failure.message)
      return
    }
    await load()
  }

  async function markAllRead() {
    const result = await run(tasksData.markAllNotificationsRead())
    if (Result.isFailure(result)) {
      setError(result.failure.message)
      return
    }
    await load()
  }

  async function openNotification(notification: Notification) {
    if (notification.readAt === null) {
      void run(tasksData.markNotificationRead(notification.id)).then((result) => {
        if (Result.isFailure(result)) {
          return
        }
        void load()
      })
    }
    if (notification.taskId && tasks.some((task) => task.id === notification.taskId))
      setSelectedId(notification.taskId)
    else if (notification.conversationId)
      onOpenConversation(notification.conversationId, notification.title)
  }

  return { markAllRead, openNotification, toggleDone }
}

export function Today({
  onOpenConversation,
}: {
  onOpenConversation: (conversationId: string, fallbackTitle: string) => void
}) {
  const state = useTodayState()
  const {
    creating,
    doneOpen,
    error,
    load,
    notifications,
    ready,
    selectedId,
    setCreating,
    setDoneOpen,
    setSelectedId,
    tasks,
  } = state
  const now = useCurrentTime()
  const selected = tasks.find((task) => task.id === selectedId) ?? null
  const unread = notifications.filter((notification) => notification.readAt === null)
  const groups = groupTasks(tasks, now)
  const settled = tasks.filter((task) => task.status !== 'open').slice(0, 12)
  const inDetail = selected !== null || creating
  const actions = createTodayActions(state, onOpenConversation)
  const back = () => {
    setSelectedId(null)
    setCreating(false)
  }

  const today = new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(now)

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-surface-0 content-edge">
      <TodayHeader
        inDetail={inDetail}
        selected={selected}
        creating={creating}
        onBack={back}
        onCreate={() => setCreating(true)}
      />

      <TodayContent
        error={error}
        selected={selected}
        creating={creating}
        today={today}
        unread={unread}
        ready={ready}
        groups={groups}
        settled={settled}
        tasks={tasks}
        doneOpen={doneOpen}
        onOpenConversation={onOpenConversation}
        onBack={back}
        onCreate={() => setCreating(true)}
        onSelectTask={setSelectedId}
        onDoneOpenChange={setDoneOpen}
        onToggleTask={actions.toggleDone}
        onMarkAllRead={actions.markAllRead}
        onOpenNotification={actions.openNotification}
        onChanged={async (id) => {
          await load()
          setCreating(false)
          setSelectedId(id)
        }}
        onDeleted={async () => {
          back()
          await load()
        }}
      />
    </section>
  )
}

/** Renders detail navigation and the unchanged Today title controls. */
function TodayHeader({
  inDetail,
  selected,
  creating,
  onBack,
  onCreate,
}: {
  inDetail: boolean
  selected: Task | null
  creating: boolean
  onBack: () => void
  onCreate: () => void
}) {
  return (
    <header className="flex h-(--topbar-h) shrink-0 items-center gap-2 px-4">
      {inDetail && (
        <button
          onClick={onBack}
          aria-label="Back to today"
          className="mr-1 inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-wash-hover hover:text-ink"
        >
          <ChevronRight className="size-4 rotate-180" />
        </button>
      )}
      <h1 className="min-w-0 flex-1 truncate text-title font-title text-ink">
        {selected ? selected.title : creating ? 'New task' : 'Today'}
      </h1>
      {!inDetail && (
        <button
          aria-label="New task"
          onClick={onCreate}
          className="inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-wash-hover hover:text-ink"
        >
          <Plus className="size-4" />
        </button>
      )}
    </header>
  )
}

/** Selects the task editor or overview inside the unchanged scrolling container. */
function TodayContent({
  error,
  selected,
  creating,
  today,
  unread,
  ready,
  groups,
  settled,
  tasks,
  doneOpen,
  onOpenConversation,
  onBack,
  onCreate,
  onSelectTask,
  onDoneOpenChange,
  onToggleTask,
  onMarkAllRead,
  onOpenNotification,
  onChanged,
  onDeleted,
}: {
  error: string | null
  selected: Task | null
  creating: boolean
  today: string
  unread: Notification[]
  ready: boolean
  groups: Group[]
  settled: Task[]
  tasks: Task[]
  doneOpen: boolean
  onOpenConversation: (conversationId: string, fallbackTitle: string) => void
  onBack: () => void
  onCreate: () => void
  onSelectTask: (id: string) => void
  onDoneOpenChange: (open: boolean | ((current: boolean) => boolean)) => void
  onToggleTask: (task: Task) => Promise<void>
  onMarkAllRead: () => Promise<void>
  onOpenNotification: (notification: Notification) => Promise<void>
  onChanged: (id: string) => Promise<void>
  onDeleted: () => Promise<void>
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto scroll-fade-y">
      <div className="mx-auto w-full max-w-230 px-5 pt-1 pb-10 sm:px-8">
        {error && (
          <div
            className="mb-3 rounded-control bg-danger-soft px-3 py-2 text-label text-danger"
            role="alert"
          >
            {error}
          </div>
        )}
        {selected || creating ? (
          <TaskDetail
            task={selected}
            onOpenConversation={onOpenConversation}
            onCancel={onBack}
            onChanged={onChanged}
            onDeleted={onDeleted}
          />
        ) : (
          <TodayOverview
            today={today}
            unread={unread}
            ready={ready}
            groups={groups}
            settled={settled}
            tasks={tasks}
            doneOpen={doneOpen}
            onCreate={onCreate}
            onSelectTask={onSelectTask}
            onDoneOpenChange={onDoneOpenChange}
            onToggleTask={onToggleTask}
            onMarkAllRead={onMarkAllRead}
            onOpenNotification={onOpenNotification}
          />
        )}
      </div>
    </div>
  )
}

/** Composes the date, notifications, open tasks, and settled tasks without adding DOM. */
function TodayOverview({
  today,
  unread,
  ready,
  groups,
  settled,
  tasks,
  doneOpen,
  onCreate,
  onSelectTask,
  onDoneOpenChange,
  onToggleTask,
  onMarkAllRead,
  onOpenNotification,
}: {
  today: string
  unread: Notification[]
  ready: boolean
  groups: Group[]
  settled: Task[]
  tasks: Task[]
  doneOpen: boolean
  onCreate: () => void
  onSelectTask: (id: string) => void
  onDoneOpenChange: (open: boolean | ((current: boolean) => boolean)) => void
  onToggleTask: (task: Task) => Promise<void>
  onMarkAllRead: () => Promise<void>
  onOpenNotification: (notification: Notification) => Promise<void>
}) {
  return (
    <>
      <p className="px-0.5 text-meta font-meta text-ink-4">{today}</p>
      <TodayNotifications
        notifications={unread}
        onMarkAllRead={onMarkAllRead}
        onOpen={onOpenNotification}
      />
      <OpenTaskSections
        ready={ready}
        groups={groups}
        unreadCount={unread.length}
        onCreate={onCreate}
        onSelect={onSelectTask}
        onToggle={onToggleTask}
      />
      <DoneTasks
        settled={settled}
        total={tasks.filter((task) => task.status !== 'open').length}
        open={doneOpen}
        onOpenChange={onDoneOpenChange}
        onSelect={onSelectTask}
        onToggle={onToggleTask}
      />
    </>
  )
}

/** Renders unread notification rows only when the person has something new to review. */
function TodayNotifications({
  notifications,
  onMarkAllRead,
  onOpen,
}: {
  notifications: Notification[]
  onMarkAllRead: () => Promise<void>
  onOpen: (notification: Notification) => Promise<void>
}) {
  if (notifications.length === 0) return null
  return (
    <Section
      title="Needs you"
      note={`${notifications.length} new`}
      action={
        <button
          onClick={() => void onMarkAllRead()}
          className="text-meta font-title text-ink-3 hover:text-ink"
        >
          Mark all read
        </button>
      }
    >
      <ul className="flex flex-col gap-1">
        {notifications.map((notification) => (
          <li key={notification.id}>
            <button
              onClick={() => void onOpen(notification)}
              className="group/row flex w-full items-start gap-3 rounded-row bg-surface-2 px-3 py-2.5 text-left smooth-shadow-ring-xs transition-surface duration-(--dur-fast) hover:bg-wash-hover hover:smooth-shadow-ring-sm"
            >
              <i
                className={cn(
                  'mt-1.75 size-2 shrink-0 rounded-full',
                  NOTIFICATION_TONE[notification.kind],
                )}
                aria-hidden
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-label font-title text-ink">
                  {notification.title}
                </span>
                {notification.body && (
                  <span className="mt-0.5 block text-label text-ink-3">{notification.body}</span>
                )}
              </span>
              <time className="shrink-0 pt-0.5 text-meta font-meta text-ink-4 tabular-nums">
                {formatWhen(notification.createdAt)}
              </time>
            </button>
          </li>
        ))}
      </ul>
    </Section>
  )
}

/** Selects loading, empty, or grouped open-task content and preserves the add-task affordance. */
function OpenTaskSections({
  ready,
  groups,
  unreadCount,
  onCreate,
  onSelect,
  onToggle,
}: {
  ready: boolean
  groups: Group[]
  unreadCount: number
  onCreate: () => void
  onSelect: (id: string) => void
  onToggle: (task: Task) => Promise<void>
}) {
  return (
    <>
      {!ready ? (
        <div className="flex items-center gap-2 px-2.5 py-8 text-label text-ink-4">
          <LoaderCircle className="size-4 animate-spin" />
          Loading…
        </div>
      ) : groups.length === 0 && unreadCount === 0 ? (
        <div className="mt-7 rounded-card bg-surface-2 px-6 py-10 text-center smooth-shadow-ring-xs">
          <Face size={32} mood="happy" className="mx-auto" />
          <p className="mt-3 text-title font-title text-ink">Nothing needs you.</p>
          <p className="mx-auto mt-1 max-w-sm text-label text-ink-3">
            Ask Vivid to remind you, chase someone, or check on something later, and it lands here.
            Or add a task yourself.
          </p>
          <button
            onClick={onCreate}
            className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-control bg-surface-3 px-3 text-label font-title text-ink smooth-shadow-ring-xs hover:bg-wash-hover"
          >
            <Plus className="size-3.5" />
            New task
          </button>
        </div>
      ) : (
        groups.map((group) => (
          <Section key={group.key} title={group.label} note={group.note}>
            <TaskList
              tasks={group.tasks}
              className="flex flex-col gap-px"
              onSelect={onSelect}
              onToggle={onToggle}
            />
          </Section>
        ))
      )}
      {ready && groups.length > 0 && (
        <button
          onClick={onCreate}
          className="mt-2 flex w-full items-center gap-2.5 rounded-row p-2.5 text-left text-ink-3 transition-colors duration-(--dur-fast) hover:bg-wash-hover hover:text-ink"
        >
          <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-control bg-surface-2">
            <Plus className="size-4" />
          </span>
          <span className="text-title">New task</span>
        </button>
      )}
    </>
  )
}

/** Renders settled tasks behind the existing disclosure without changing list structure. */
function DoneTasks({
  settled,
  total,
  open,
  onOpenChange,
  onSelect,
  onToggle,
}: {
  settled: Task[]
  total: number
  open: boolean
  onOpenChange: (open: boolean | ((current: boolean) => boolean)) => void
  onSelect: (id: string) => void
  onToggle: (task: Task) => Promise<void>
}) {
  if (settled.length === 0) return null
  return (
    <div className="mt-6">
      <button
        onClick={() => onOpenChange((current) => !current)}
        className="flex h-(--caption-h) items-center gap-1.5 px-0.5 text-meta font-title text-ink-4 hover:text-ink-2"
      >
        <Check className="size-3.5" />
        Done <span className="font-meta">{total}</span>
      </button>
      {open && (
        <TaskList
          tasks={settled}
          className="mt-1 flex flex-col gap-px"
          onSelect={onSelect}
          onToggle={onToggle}
        />
      )}
    </div>
  )
}

/** Renders task rows with their stable task identifiers as list keys. */
function TaskList({
  tasks,
  className,
  onSelect,
  onToggle,
}: {
  tasks: Task[]
  className: string
  onSelect: (id: string) => void
  onToggle: (task: Task) => Promise<void>
}) {
  return (
    <ul className={className}>
      {tasks.map((task) => (
        <li key={task.id}>
          <TaskRow
            task={task}
            onOpen={() => onSelect(task.id)}
            onToggle={() => void onToggle(task)}
          />
        </li>
      ))}
    </ul>
  )
}

/** Builds visible row metadata without making the visual component own date-state branching. */
function taskRowMeta(task: Task, settled: boolean, overdue: boolean): string[] {
  const meta: string[] = []
  if (task.assignee) meta.push(`Waiting on ${task.assignee}`)
  if (task.dueAt !== null && !settled) {
    meta.push(
      overdue ? `Was due ${formatWhen(task.dueAt, false)}` : `Due ${formatWhen(task.dueAt, false)}`,
    )
  }
  if (task.status === 'done' && task.completedAt)
    meta.push(`Done ${formatWhen(task.completedAt, false)}`)
  else if (task.status === 'dropped') meta.push('Dropped')
  return meta
}

/** Renders the mutually exclusive done, dropped, and open task marks. */
function TaskStatusIcon({ status }: { status: TaskStatus }) {
  if (status === 'done') return <CircleCheck className="size-4.5 text-success" />
  if (status === 'dropped') return <X className="size-4" />
  return <Circle className="size-4.5" strokeWidth={1.6} />
}

/** Renders scheduled follow-up context only for an open task with a next run. */
function TaskFollowUpSummary({
  task,
  running,
  hasMeta,
}: {
  task: Task
  running: boolean
  hasMeta: boolean
}) {
  if (task.status !== 'open' || task.nextFollowUpAt === null) return null
  return (
    <span
      className={cn('inline-flex shrink-0 items-center gap-1 text-ink-4', hasMeta && 'sep-dot')}
    >
      {running ? <LoaderCircle className="size-3 animate-spin text-working" /> : <Face size={12} />}
      {running ? 'Vivid is on it' : `Vivid follows up ${formatWhen(task.nextFollowUpAt)}`}
    </span>
  )
}

function TaskRow({
  task,
  onOpen,
  onToggle,
}: {
  task: Task
  onOpen: () => void
  onToggle: () => void
}) {
  const now = useCurrentTime()
  const overdue = task.status === 'open' && task.dueAt !== null && task.dueAt < now
  const running = task.followUps.some((followUp) => followUp.status === 'running')
  const settled = task.status !== 'open'
  const meta = taskRowMeta(task, settled, overdue)
  return (
    <div
      className={cn(
        'group/row flex items-center gap-2.5 rounded-row px-2.5 py-2 transition-colors duration-(--dur-fast) hover:bg-wash-hover',
        settled && 'opacity-70 hover:opacity-100',
      )}
    >
      <button
        onClick={onToggle}
        aria-label={settled ? 'Reopen' : 'Mark done'}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-control text-ink-3 hover:text-success"
      >
        <TaskStatusIcon status={task.status} />
      </button>
      <button onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              'block truncate text-title',
              settled ? 'text-ink-3 line-through decoration-line-4' : 'text-ink',
            )}
          >
            {task.title}
          </span>
          <span
            className={cn(
              'mt-0.5 flex min-w-0 items-center gap-1.5 truncate text-meta font-meta',
              overdue ? 'text-danger' : 'text-ink-4',
            )}
          >
            {meta.length > 0 && <span className="truncate">{meta.join(' · ')}</span>}
            <TaskFollowUpSummary task={task} running={running} hasMeta={meta.length > 0} />
          </span>
        </span>
        {task.priority === 'urgent' && task.status === 'open' && (
          <span className="shrink-0 rounded-full bg-approve-soft px-2 py-0.5 text-meta font-title text-approve">
            Urgent
          </span>
        )}
        <ChevronRight className="size-4 shrink-0 text-ink-4 opacity-0 transition-opacity group-hover/row:opacity-100" />
      </button>
    </div>
  )
}

const QUICK_TIMES: Array<{ label: string; at: () => number }> = [
  { label: 'Tomorrow 9:00', at: () => startOfDay(Date.now()) + DAY_MS + 9 * 3_600_000 },
  { label: 'In 3 days', at: () => startOfDay(Date.now()) + 3 * DAY_MS + 9 * 3_600_000 },
  {
    label: 'Next Monday',
    at: () => {
      const day = new Date(startOfDay(Date.now()))
      const delta = (8 - day.getDay()) % 7 || 7
      return day.getTime() + delta * DAY_MS + 9 * 3_600_000
    },
  },
]

/** Owns task-editor hooks and the shared request execution lifecycle. */
function useTaskEditorState(task: Task | null) {
  const [title, setTitle] = useState(task === null ? '' : task.title)
  const [detail, setDetail] = useState(task === null ? '' : task.detail)
  const [assignee, setAssignee] = useState(task === null ? '' : (task.assignee ?? ''))
  const [dueAt, setDueAt] = useState(toLocalInput(task === null ? null : task.dueAt))
  const [priority, setPriority] = useState<TaskPriority>(task === null ? 'normal' : task.priority)
  const [followUpAt, setFollowUpAt] = useState('')
  const [followUpNote, setFollowUpNote] = useState('')
  const [repeat, setRepeat] = useState<string>('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function execute<Value>(program: tasksData.Program<Value>) {
    setPending(true)
    setError(null)
    const result = await run(program)
    setPending(false)
    if (Result.isFailure(result)) {
      setError(result.failure.message)
      return null
    }
    return result.success
  }

  return {
    assignee,
    detail,
    dueAt,
    error,
    execute,
    followUpAt,
    followUpNote,
    pending,
    priority,
    repeat,
    setAssignee,
    setDetail,
    setDueAt,
    setError,
    setFollowUpAt,
    setFollowUpNote,
    setPriority,
    setRepeat,
    setTitle,
    title,
  }
}

type TaskEditorState = ReturnType<typeof useTaskEditorState>

/** Compares persisted task fields with their editor values without mixing rendering decisions. */
function taskEditorDirty(task: Task | null, editor: TaskEditorState): boolean {
  if (task === null) return true
  return (
    editor.title !== task.title ||
    editor.detail !== task.detail ||
    (editor.assignee.trim() || null) !== task.assignee ||
    fromLocalInput(editor.dueAt) !== task.dueAt ||
    editor.priority !== task.priority
  )
}

/** Owns task saves, status changes, deletion, nudges, and follow-up mutations. */
function createTaskEditorActions({
  task,
  editor,
  onChanged,
  onDeleted,
}: {
  task: Task | null
  editor: TaskEditorState
  onChanged: (id: string) => Promise<void>
  onDeleted: () => Promise<void>
}) {
  async function save(event: FormEvent) {
    event.preventDefault()
    const input = {
      title: editor.title.trim(),
      detail: editor.detail.trim(),
      assignee: editor.assignee.trim() || null,
      dueAt: fromLocalInput(editor.dueAt),
      priority: editor.priority,
    } satisfies tasksData.TaskInput
    const firstFollowUpAt = fromLocalInput(editor.followUpAt)
    const firstFollowUp =
      firstFollowUpAt === null
        ? null
        : ({
            at: firstFollowUpAt,
            note: editor.followUpNote.trim(),
            repeatEveryMs: editor.repeat ? Number(editor.repeat) : null,
          } satisfies tasksData.FollowUpInput)
    const saved =
      task === null
        ? await editor.execute(tasksData.create(input, firstFollowUp))
        : await editor.execute(tasksData.update(task.id, input))
    if (saved !== null) await onChanged(saved.id)
  }

  async function setStatus(status: TaskStatus) {
    if (!task) return
    if ((await editor.execute(tasksData.setStatus(task.id, status))) !== null)
      await onChanged(task.id)
  }

  async function chaseNow() {
    if (!task) return
    if ((await editor.execute(tasksData.nudge(task.id))) !== null) await onChanged(task.id)
  }

  async function remove() {
    if (!task || !window.confirm(`Delete “${task.title}”? Its follow-ups go with it.`)) return
    if ((await editor.execute(tasksData.remove(task.id))) !== null) await onDeleted()
  }

  async function addFollowUp(event: FormEvent) {
    event.preventDefault()
    if (!task) return
    const at = fromLocalInput(editor.followUpAt)
    if (at === null) {
      editor.setError('Pick a time for the follow-up')
      return
    }
    const added = await editor.execute(
      tasksData.addFollowUp(task.id, {
        at,
        note: editor.followUpNote.trim(),
        repeatEveryMs: editor.repeat ? Number(editor.repeat) : null,
      }),
    )
    if (added !== null) {
      editor.setFollowUpAt('')
      editor.setFollowUpNote('')
      editor.setRepeat('')
      await onChanged(task.id)
    }
  }

  async function followUpAction(followUp: FollowUp, action: 'run' | 'cancel' | 'delete') {
    if (!task) return
    const result =
      action === 'run'
        ? await editor.execute(tasksData.runFollowUp(followUp.id))
        : action === 'cancel'
          ? await editor.execute(tasksData.cancelFollowUp(followUp.id))
          : await editor.execute(tasksData.removeFollowUp(followUp.id))
    if (result !== null) await onChanged(task.id)
  }

  return { addFollowUp, chaseNow, followUpAction, remove, save, setStatus }
}

function TaskDetail({
  task,
  onChanged,
  onDeleted,
  onCancel,
  onOpenConversation,
}: {
  task: Task | null
  onChanged: (id: string) => Promise<void>
  onDeleted: () => Promise<void>
  onCancel: () => void
  onOpenConversation: (conversationId: string, fallbackTitle: string) => void
}) {
  const now = useCurrentTime()
  const editor = useTaskEditorState(task)
  const actions = createTaskEditorActions({ task, editor, onChanged, onDeleted })
  const chasing = task !== null && task.followUps.some((followUp) => followUp.status === 'running')
  const dirty = taskEditorDirty(task, editor)

  return (
    <div className="pt-2">
      <TaskDetailControls
        task={task}
        pending={editor.pending}
        chasing={chasing}
        onStatusChange={(status) => void actions.setStatus(status)}
        onChase={() => void actions.chaseNow()}
        onRemove={() => void actions.remove()}
        onOpenConversation={onOpenConversation}
      />
      <TaskOverdueNotice task={task} now={now} />

      <TaskEditorForm
        task={task}
        editor={editor}
        dirty={dirty}
        onSubmit={(event) => void actions.save(event)}
        onCancel={onCancel}
      />

      <TaskFollowUps
        task={task}
        editor={editor}
        onAdd={(event) => void actions.addFollowUp(event)}
        onAction={(followUp, action) => void actions.followUpAction(followUp, action)}
        onOpenConversation={onOpenConversation}
      />
      <TaskOrigin task={task} onOpenConversation={onOpenConversation} />
    </div>
  )
}

/** Renders existing-task controls without making the editor own their status branches. */
function TaskDetailControls({
  task,
  pending,
  chasing,
  onStatusChange,
  onChase,
  onRemove,
  onOpenConversation,
}: {
  task: Task | null
  pending: boolean
  chasing: boolean
  onStatusChange: (status: TaskStatus) => void
  onChase: () => void
  onRemove: () => void
  onOpenConversation: (conversationId: string, fallbackTitle: string) => void
}) {
  if (task === null) return null
  const hasFiredFollowUp = task.followUps.some((followUp) => followUp.status === 'fired')
  return (
    <div className="mb-5 flex flex-wrap items-center gap-2 border-b border-line-1 pb-4">
      {task.status === 'open' ? (
        <button
          disabled={pending}
          onClick={() => onStatusChange('done')}
          className="inline-flex h-8 items-center gap-1.5 rounded-control bg-surface-2 px-3 text-label text-ink smooth-shadow-ring-xs disabled:opacity-50"
        >
          <Check className="size-3.5" />
          Mark done
        </button>
      ) : (
        <button
          disabled={pending}
          onClick={() => onStatusChange('open')}
          className="inline-flex h-8 items-center gap-1.5 rounded-control bg-surface-2 px-3 text-label text-ink smooth-shadow-ring-xs disabled:opacity-50"
        >
          <RotateCcw className="size-3.5" />
          Reopen
        </button>
      )}
      {task.status === 'open' && (
        <TaskChaseButton task={task} pending={pending} chasing={chasing} onChase={onChase} />
      )}
      {task.status === 'open' && hasFiredFollowUp && (
        <button
          onClick={() => onOpenConversation(task.conversationId, task.title)}
          className="inline-flex h-8 items-center gap-1.5 rounded-control px-3 text-label text-ink-2 hover:bg-wash-hover hover:text-ink"
        >
          <MessageSquareText className="size-3.5" />
          Open conversation
        </button>
      )}
      <button
        disabled={pending}
        onClick={onRemove}
        className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-control px-3 text-label text-danger hover:bg-danger-soft disabled:opacity-50"
      >
        <Trash2 className="size-3.5" />
        Delete
      </button>
    </div>
  )
}

/** Renders the current nudge state and person-specific action label. */
function TaskChaseButton({
  task,
  pending,
  chasing,
  onChase,
}: {
  task: Task
  pending: boolean
  chasing: boolean
  onChase: () => void
}) {
  return (
    <button
      disabled={pending || chasing}
      onClick={onChase}
      className="inline-flex h-8 items-center gap-1.5 rounded-control bg-accent px-3 text-label font-title text-ink-on-accent disabled:opacity-50"
    >
      {chasing ? (
        <LoaderCircle className="size-3.5 animate-spin" />
      ) : (
        <BellRing className="size-3.5" />
      )}
      {chasing ? 'Vivid is on it…' : task.assignee ? `Chase ${task.assignee} now` : 'Remind me now'}
    </button>
  )
}

/** Shows the overdue warning only for open tasks whose due time has passed. */
function TaskOverdueNotice({ task, now }: { task: Task | null; now: number }) {
  if (task === null || task.status !== 'open' || task.dueAt === null || task.dueAt >= now)
    return null
  return (
    <div className="mb-4 flex items-start gap-2 rounded-control bg-danger-soft px-3 py-2.5 text-label text-danger">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <p>
        Past due since {formatWhen(task.dueAt)}. Vivid chased it once automatically; chase again,
        move the date, or close it.
      </p>
    </div>
  )
}

/** Renders task fields, optional first follow-up, error, and submit controls in one form. */
function TaskEditorForm({
  task,
  editor,
  dirty,
  onSubmit,
  onCancel,
}: {
  task: Task | null
  editor: TaskEditorState
  dirty: boolean
  onSubmit: (event: FormEvent) => void
  onCancel: () => void
}) {
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <TaskCoreFields editor={editor} creating={task === null} />
      <NewTaskFollowUp task={task} editor={editor} />
      {editor.error && (
        <p className="text-label text-danger" role="alert">
          {editor.error}
        </p>
      )}
      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="h-9 rounded-control px-3 text-label text-ink-3 hover:bg-wash-hover"
        >
          {task ? 'Back' : 'Cancel'}
        </button>
        <button
          disabled={editor.pending || !dirty || !editor.title.trim()}
          className="inline-flex h-9 items-center gap-2 rounded-control bg-accent px-4 text-label font-title text-ink-on-accent disabled:opacity-50"
        >
          {editor.pending && <LoaderCircle className="size-3.5 animate-spin" />}
          {task ? 'Save changes' : 'Add task'}
        </button>
      </div>
    </form>
  )
}

/** Renders the persisted task fields without owning submit or follow-up behavior. */
function TaskCoreFields({ editor, creating }: { editor: TaskEditorState; creating: boolean }) {
  const fieldClass =
    'h-10 w-full rounded-control bg-surface-2 px-3 text-label text-ink smooth-shadow-ring-xs outline-none focus:smooth-shadow-ring-sm'
  const labelClass = 'mb-1.5 block text-label font-title text-ink-2'
  return (
    <>
      <label className="block">
        <span className={labelClass}>What</span>
        <input
          autoFocus={creating}
          required
          maxLength={200}
          value={editor.title}
          onChange={(event) => editor.setTitle(event.currentTarget.value)}
          placeholder="Get the signed contract back from Dami"
          className={fieldClass}
        />
      </label>
      <label className="block">
        <span className={labelClass}>
          Detail <span className="font-meta text-ink-4">optional</span>
        </span>
        <textarea
          maxLength={2000}
          rows={3}
          value={editor.detail}
          onChange={(event) => editor.setDetail(event.currentTarget.value)}
          placeholder="Anything Vivid should know when it follows up."
          className="w-full resize-y rounded-control bg-surface-2 px-3 py-2.5 text-label text-ink smooth-shadow-ring-xs outline-none focus:smooth-shadow-ring-sm"
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className={labelClass}>Waiting on</span>
          <span className="relative block">
            <UserRound className="pointer-events-none absolute top-3 left-3 size-4 text-ink-4" />
            <input
              maxLength={80}
              value={editor.assignee}
              onChange={(event) => editor.setAssignee(event.currentTarget.value)}
              placeholder="You"
              className={cn(fieldClass, 'pl-9')}
            />
          </span>
        </label>
        <label className="block">
          <span className={labelClass}>Due</span>
          <input
            type="datetime-local"
            value={editor.dueAt}
            onChange={(event) => editor.setDueAt(event.currentTarget.value)}
            className={fieldClass}
          />
        </label>
        <label className="block">
          <span className={labelClass}>Priority</span>
          <select
            value={editor.priority}
            onChange={(event) => {
              const value = event.currentTarget.value
              if (value === 'normal' || value === 'urgent') editor.setPriority(value)
            }}
            className={fieldClass}
          >
            <option value="normal">Normal</option>
            <option value="urgent">Urgent</option>
          </select>
        </label>
      </div>
    </>
  )
}

/** Renders first-follow-up fields only while creating a task. */
function NewTaskFollowUp({ task, editor }: { task: Task | null; editor: TaskEditorState }) {
  if (task !== null) return null
  return (
    <div className="rounded-card bg-surface-2 p-4 smooth-shadow-ring-xs">
      <div className="flex items-center gap-2 text-label font-title text-ink-2">
        <Face size={16} />
        First follow-up <span className="font-meta text-ink-4">optional</span>
      </div>
      <FollowUpFields
        at={editor.followUpAt}
        note={editor.followUpNote}
        repeat={editor.repeat}
        onAt={editor.setFollowUpAt}
        onNote={editor.setFollowUpNote}
        onRepeat={editor.setRepeat}
        quickTimes={QUICK_TIMES}
      />
    </div>
  )
}

/** Renders existing follow-ups and the add-follow-up form for open tasks. */
function TaskFollowUps({
  task,
  editor,
  onAdd,
  onAction,
  onOpenConversation,
}: {
  task: Task | null
  editor: TaskEditorState
  onAdd: (event: FormEvent) => void
  onAction: (followUp: FollowUp, action: 'run' | 'cancel' | 'delete') => void
  onOpenConversation: (conversationId: string, fallbackTitle: string) => void
}) {
  if (task === null) return null
  return (
    <div className="mt-7 border-t border-line-1 pt-4">
      <div className="flex items-baseline gap-2.5">
        <h2 className="text-label font-title text-ink-2">Follow-ups</h2>
        <p className="text-meta font-meta text-ink-4">When Vivid wakes up and acts on this.</p>
      </div>
      {task.followUps.length === 0 ? (
        <p className="mt-2 text-label text-ink-4">None yet.</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {task.followUps.map((followUp) => (
            <li key={followUp.id}>
              <FollowUpRow
                followUp={followUp}
                onAction={(action) => onAction(followUp, action)}
                onOpen={() => onOpenConversation(task.conversationId, task.title)}
              />
            </li>
          ))}
        </ul>
      )}
      {task.status === 'open' && (
        <form onSubmit={onAdd} className="mt-3 rounded-card bg-surface-2 p-4 smooth-shadow-ring-xs">
          <div className="flex items-center gap-2 text-label font-title text-ink-2">
            <Plus className="size-3.5" />
            Add a follow-up
          </div>
          <FollowUpFields
            at={editor.followUpAt}
            note={editor.followUpNote}
            repeat={editor.repeat}
            onAt={editor.setFollowUpAt}
            onNote={editor.setFollowUpNote}
            onRepeat={editor.setRepeat}
            quickTimes={QUICK_TIMES}
          />
          <div className="mt-3 flex justify-end">
            <button
              disabled={editor.pending || !editor.followUpAt}
              className="inline-flex h-8 items-center gap-1.5 rounded-control bg-surface-3 px-3 text-label font-title text-ink smooth-shadow-ring-xs hover:bg-wash-hover disabled:opacity-50"
            >
              <Clock3 className="size-3.5" />
              Schedule
            </button>
          </div>
        </form>
      )}
    </div>
  )
}

/** Renders source attribution for non-manual tasks without inventing missing origin data. */
function TaskOrigin({
  task,
  onOpenConversation,
}: {
  task: Task | null
  onOpenConversation: (conversationId: string, fallbackTitle: string) => void
}) {
  if (task === null || task.origin.kind === 'manual') return null
  return (
    <p className="mt-5 text-meta font-meta text-ink-4">
      {task.createdBy === 'vivid' ? 'Vivid started tracking this' : 'Added'}{' '}
      {formatWhen(task.createdAt)}
      {task.origin.kind === 'conversation' && (
        <>
          {' '}
          ·{' '}
          <button
            onClick={() =>
              onOpenConversation(
                task.origin.kind === 'conversation'
                  ? task.origin.conversationId
                  : task.conversationId,
                task.title,
              )
            }
            className="text-ink-3 underline underline-offset-2 hover:text-ink"
          >
            from a conversation
          </button>
        </>
      )}
      {task.origin.kind === 'routine' && ' · from a routine'}
    </p>
  )
}

function FollowUpFields({
  at,
  note,
  repeat,
  onAt,
  onNote,
  onRepeat,
  quickTimes,
}: {
  at: string
  note: string
  repeat: string
  onAt: (value: string) => void
  onNote: (value: string) => void
  onRepeat: (value: string) => void
  quickTimes: Array<{ label: string; at: () => number }>
}) {
  const fieldClass =
    'h-9 w-full rounded-control bg-surface-3 px-3 text-label text-ink smooth-shadow-ring-xs outline-none focus:smooth-shadow-ring-sm'
  return (
    <div className="mt-3 space-y-2.5">
      <div className="flex flex-wrap gap-1.5">
        {quickTimes.map((quick) => (
          <button
            key={quick.label}
            type="button"
            onClick={() => onAt(toLocalInput(quick.at()))}
            className="h-7 rounded-full bg-surface-3 px-2.5 text-meta font-title text-ink-2 smooth-shadow-ring-xs hover:bg-wash-hover hover:text-ink"
          >
            {quick.label}
          </button>
        ))}
      </div>
      <div className="grid gap-2 sm:grid-cols-followup">
        <input
          type="datetime-local"
          aria-label="When"
          value={at}
          onChange={(event) => onAt(event.currentTarget.value)}
          className={fieldClass}
        />
        <input
          maxLength={500}
          value={note}
          onChange={(event) => onNote(event.currentTarget.value)}
          placeholder="What to check or say"
          className={fieldClass}
        />
        <select
          aria-label="Repeat"
          value={repeat}
          onChange={(event) => onRepeat(event.currentTarget.value)}
          className={cn(fieldClass, 'w-auto')}
        >
          {REPEAT_OPTIONS.map((option) => (
            <option key={option.label} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}

const FOLLOW_UP_TONE = {
  scheduled: 'bg-accent',
  running: 'animate-status-pulse bg-working',
  fired: 'bg-success',
  failed: 'bg-danger',
  cancelled: 'bg-ink-4',
} satisfies Record<FollowUp['status'], string>

const FOLLOW_UP_LABEL = {
  scheduled: 'Scheduled',
  running: 'Vivid is on it',
  fired: 'Followed up',
  failed: 'Failed',
  cancelled: 'Cancelled',
} satisfies Record<FollowUp['status'], string>

function FollowUpRow({
  followUp,
  onAction,
  onOpen,
}: {
  followUp: FollowUp
  onAction: (action: 'run' | 'cancel' | 'delete') => void
  onOpen: () => void
}) {
  const repeat = describeRepeat(followUp.repeatEveryMs)
  return (
    <div
      className={cn(
        'rounded-row bg-surface-2 px-3 py-2.5 smooth-shadow-ring-xs',
        followUp.status === 'cancelled' && 'opacity-60',
      )}
    >
      <div className="flex items-center gap-2">
        <i
          className={cn('size-2 shrink-0 rounded-full', FOLLOW_UP_TONE[followUp.status])}
          aria-hidden
        />
        <span className="text-label text-ink">{FOLLOW_UP_LABEL[followUp.status]}</span>
        <time className="text-meta font-meta text-ink-4 tabular-nums">
          {formatWhen(followUp.firedAt ?? followUp.at)}
        </time>
        {repeat && (
          <span className="inline-flex items-center gap-1 text-meta font-meta text-ink-4">
            <Repeat2 className="size-3" />
            {repeat}
          </span>
        )}
        {followUp.createdBy === 'vivid' && (
          <span className="text-meta font-meta text-ink-4">· by Vivid</span>
        )}
        <FollowUpActions status={followUp.status} onAction={onAction} onOpen={onOpen} />
      </div>
      {followUp.note && <p className="mt-1 text-meta text-ink-3">{followUp.note}</p>}
      {followUp.output && (
        <p className="mt-1.5 line-clamp-3 text-label whitespace-pre-wrap text-ink-2">
          {followUp.output}
        </p>
      )}
      {followUp.error && <p className="mt-1 text-meta text-danger">{followUp.error}</p>}
    </div>
  )
}

/** Renders the legal action set for each follow-up lifecycle state. */
function FollowUpActions({
  status,
  onAction,
  onOpen,
}: {
  status: FollowUp['status']
  onAction: (action: 'run' | 'cancel' | 'delete') => void
  onOpen: () => void
}) {
  return (
    <span className="ml-auto flex items-center gap-1">
      {status === 'scheduled' && (
        <>
          <button
            onClick={() => onAction('run')}
            className="h-7 rounded-control px-2 text-meta font-title text-ink-2 hover:bg-wash-hover hover:text-ink"
          >
            Run now
          </button>
          <button
            onClick={() => onAction('cancel')}
            className="h-7 rounded-control px-2 text-meta font-title text-ink-3 hover:bg-wash-hover hover:text-ink"
          >
            Cancel
          </button>
        </>
      )}
      {(status === 'fired' || status === 'failed') && (
        <button
          onClick={onOpen}
          className="inline-flex h-7 items-center gap-1 rounded-control px-2 text-meta font-title text-ink-2 hover:bg-wash-hover hover:text-ink"
        >
          <MessageSquareText className="size-3" />
          Open
        </button>
      )}
      {(status === 'cancelled' || status === 'failed') && (
        <button
          onClick={() => onAction('delete')}
          aria-label="Remove follow-up"
          className="inline-flex size-7 items-center justify-center rounded-control text-ink-4 hover:bg-danger-soft hover:text-danger"
        >
          <Trash2 className="size-3" />
        </button>
      )}
    </span>
  )
}

function Section({
  title,
  note,
  action,
  children,
}: {
  title: string
  note?: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="mt-7">
      <div className="mb-1 flex items-baseline gap-2.5 border-t border-line-1 px-0.5 pt-4">
        <h2 className="text-label font-title text-ink-2">{title}</h2>
        {note && <p className="truncate text-meta font-meta text-ink-4">{note}</p>}
        {action && <span className="ml-auto">{action}</span>}
      </div>
      {children}
    </div>
  )
}
