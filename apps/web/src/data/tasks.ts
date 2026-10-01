import {
  Assignee,
  AssigneeInput,
  Author,
  ThreadId,
  type FollowUp,
  type FollowUpId,
  type Notification,
  type NotificationId,
  type NotificationListResponse,
  PersonSummary,
  type PersonId,
  type Task,
  type TaskId,
  type TaskListResponse,
} from '@vivid/contracts'
import { Array as Arr, Option, Order, Schema } from 'effect'

/**
 * Today's Tasks, as pure functions over what the server sends.
 *
 * Nothing here talks to the server. The screen reads `live.tasks` and `live.notifications`; this
 * module decides how those results are grouped, who a Task is waiting on, and what each result
 * will look like once a change the Person just made has been accepted. Those last functions are
 * the expectations handed to `change(...)`: each takes the current result and returns the one the
 * server is expected to send next, so the screen moves at once and is corrected if the server
 * answers differently.
 */

export type TaskStatus = Task['status']
export type TaskPriority = Task['priority']
export type TaskList = typeof TaskListResponse.Type
export type NotificationList = typeof NotificationListResponse.Type
export type { FollowUp, Notification, Task }

const DAY_MS = 86_400_000

/** The Person a Task or a follow-up was made for: its author, or the one Vivid was acting for. */
export const madeFor = (author: Author): PersonSummary =>
  Author.match(author, {
    Person: ({ person }) => person,
    Vivid: ({ onBehalfOf }) => onBehalfOf,
  })

/** How an author is named in the product: a Person by name, Vivid with whom it acted for. */
export const authorName = (author: Author): string =>
  Author.match(author, {
    Person: ({ person }) => person.name,
    Vivid: ({ onBehalfOf }) => `Vivid, for ${onBehalfOf.name}`,
  })

/**
 * Who owes a Task. An unassigned Task is its creator's own, so the owner is always someone: a
 * Person in Vivid, or somebody outside it who is known only by name.
 */
export const TaskOwner = Schema.TaggedUnion({
  Person: { person: PersonSummary },
  Outsider: { name: Schema.String },
})
export type TaskOwner = typeof TaskOwner.Type

/** Who is expected to do the work: the assignee, or the creator when nobody is assigned. */
export const ownerOf = (task: Task): TaskOwner =>
  Assignee.match(task.assignee, {
    Nobody: (): TaskOwner => TaskOwner.cases.Person.make({ person: madeFor(task.createdBy) }),
    Member: ({ person }): TaskOwner => TaskOwner.cases.Person.make({ person }),
    Outsider: ({ name }): TaskOwner => TaskOwner.cases.Outsider.make({ name }),
  })

/**
 * The three groups of Today, from the point of view of the Person looking at it.
 *
 * - `Yours`: you made it (or Vivid made it for you) and nobody else owes it.
 * - `Assigned`: somebody else gave it to you.
 * - `Waiting`: somebody else owes it, a Member or someone outside Vivid. In a Company this also
 *   holds Tasks from shared Threads that another Member made for themselves.
 */
export const BUCKETS = ['Yours', 'Assigned', 'Waiting'] as const
export type Bucket = (typeof BUCKETS)[number]

/** Places one Task in exactly one group. */
export const bucketOf = (task: Task, me: PersonId): Bucket => {
  const mine = madeFor(task.createdBy).id === me
  return Assignee.match(task.assignee, {
    Nobody: () => (mine ? 'Yours' : 'Waiting'),
    Member: ({ person }) => {
      if (person.id !== me) return 'Waiting'
      return mine ? 'Yours' : 'Assigned'
    },
    Outsider: () => 'Waiting',
  })
}

/** An open Task whose due time has passed. A settled Task is never overdue. */
export const isOverdue = (task: Task, now: number): boolean =>
  task.status === 'open' && task.dueAt !== null && task.dueAt < now

/**
 * Orders Tasks inside a group: overdue first (longest overdue at the top), then by due time, and
 * Tasks without a due time last, newest first. `Infinity` stands in for "no due time" only inside
 * this comparison.
 */
const byUrgency: Order.Order<Task> = Order.combine(
  Order.mapInput(Order.Number, (task: Task) =>
    task.dueAt === null ? Number.POSITIVE_INFINITY : task.dueAt,
  ),
  Order.mapInput(Order.flip(Order.Number), (task: Task) => task.createdAt),
)

/** Most recently changed first. */
const byLastChange: Order.Order<Task> = Order.mapInput(
  Order.flip(Order.Number),
  (task: Task) => task.updatedAt,
)

export interface TaskGroup {
  readonly bucket: Bucket
  readonly tasks: ReadonlyArray<Task>
}

/** Open Tasks in Today's groups, in order, leaving out a group with nothing in it. */
export const groupOpen = (tasks: ReadonlyArray<Task>, me: PersonId): ReadonlyArray<TaskGroup> => {
  const open = tasks.filter((task) => task.status === 'open')
  return BUCKETS.flatMap((bucket) => {
    const inside = Arr.sort(
      open.filter((task) => bucketOf(task, me) === bucket),
      byUrgency,
    )
    return inside.length === 0 ? [] : [{ bucket, tasks: inside }]
  })
}

/** Done and dropped Tasks, most recently settled first. */
export const settledOf = (tasks: ReadonlyArray<Task>): ReadonlyArray<Task> =>
  Arr.sort(
    tasks.filter((task) => task.status !== 'open'),
    byLastChange,
  )

/** Midnight at the start of the local day `value` falls in. */
export const startOfDay = (value: number): number => {
  const date = new Date(value)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/**
 * "Today 14:30", "Tomorrow 09:00", "Fri 5 Sep 09:00". Dates matter on this screen, so it never
 * says "2h ago". `now` is passed in so the same value is used across one render.
 */
export const formatWhen = (value: number, now: number, withTime: boolean): string => {
  const days = Math.round((startOfDay(value) - startOfDay(now)) / DAY_MS)
  const named = new Map([
    [0, 'Today'],
    [1, 'Tomorrow'],
    [-1, 'Yesterday'],
  ]).get(days)
  const day =
    named === undefined
      ? new Intl.DateTimeFormat(undefined, {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
        }).format(value)
      : named
  if (!withTime) return day
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(
    value,
  )
  return `${day} ${time}`
}

/** A follow-up's repeat as a phrase, or nothing when it runs once. */
export const describeRepeat = (repeatEveryMs: number | null): Option.Option<string> => {
  if (repeatEveryMs === null || repeatEveryMs <= 0) return Option.none()
  if (repeatEveryMs === DAY_MS) return Option.some('every day')
  if (repeatEveryMs === 7 * DAY_MS) return Option.some('every week')
  return Option.some(`every ${Math.round(repeatEveryMs / 3_600_000)}h`)
}

// ── Assignees ──────────────────────────────────────────────────────────────

/**
 * Turns the assignee chosen in the editor into what the server accepts. A Member is named by id;
 * an Outsider by a trimmed, non-empty name. An Outsider with no name yet is not an assignee at
 * all, so there is nothing to send and the form cannot be saved.
 */
export const assigneeInput = (assignee: Assignee): Option.Option<AssigneeInput> =>
  Assignee.match(assignee, {
    Nobody: (): Option.Option<AssigneeInput> => Option.some(AssigneeInput.cases.Nobody.make({})),
    Member: ({ person }): Option.Option<AssigneeInput> =>
      Option.some(AssigneeInput.cases.Member.make({ personId: person.id })),
    Outsider: ({ name }): Option.Option<AssigneeInput> => {
      const trimmed = name.trim()
      return trimmed.length === 0 || trimmed.length > 120
        ? Option.none()
        : Option.some(AssigneeInput.cases.Outsider.make({ name: trimmed }))
    },
  })

/** The assignee as the server will store it: the same, with an Outsider's name trimmed. */
export const settledAssignee = (assignee: Assignee): Assignee =>
  Assignee.match(assignee, {
    Nobody: () => assignee,
    Member: () => assignee,
    Outsider: ({ name }) => Assignee.cases.Outsider.make({ name: name.trim() }),
  })

/** Whether two assignees name the same owner, for telling an edited form from a saved one. */
export const sameAssignee = (left: Assignee, right: Assignee): boolean =>
  Assignee.match(left, {
    Nobody: () => Assignee.guards.Nobody(right),
    Member: ({ person }) => Assignee.guards.Member(right) && right.person.id === person.id,
    Outsider: ({ name }) => Assignee.guards.Outsider(right) && right.name.trim() === name.trim(),
  })

// ── What the Person edits ──────────────────────────────────────────────────

/** The fields of a Task a Person edits, as the editor holds them. */
export interface TaskFields {
  readonly title: string
  readonly detail: string
  readonly assignee: Assignee
  readonly dueAt: number | null
  readonly priority: TaskPriority
}

/** A follow-up a Person scheduled, with the id the client chose for it. */
export interface NewFollowUp {
  readonly id: FollowUpId
  readonly at: number
  readonly note: string
  readonly repeatEveryMs: number | null
}

/** The editor's starting values for a Task that already exists. */
export const fieldsOf = (task: Task): TaskFields => ({
  title: task.title,
  detail: task.detail,
  assignee: task.assignee,
  dueAt: task.dueAt,
  priority: task.priority,
})

/** The editor's starting values for a new Task: nothing written, nobody assigned. */
export const emptyFields = (): TaskFields => ({
  title: '',
  detail: '',
  assignee: Assignee.cases.Nobody.make({}),
  dueAt: null,
  priority: 'normal',
})

/** The fields as they will be stored: text trimmed, an Outsider's name trimmed. */
export const settledFields = (fields: TaskFields): TaskFields => ({
  title: fields.title.trim(),
  detail: fields.detail.trim(),
  assignee: settledAssignee(fields.assignee),
  dueAt: fields.dueAt,
  priority: fields.priority,
})

/** Whether the editor holds something the Task does not. */
export const fieldsDiffer = (task: Task, fields: TaskFields): boolean =>
  fields.title.trim() !== task.title ||
  fields.detail.trim() !== task.detail ||
  !sameAssignee(fields.assignee, task.assignee) ||
  fields.dueAt !== task.dueAt ||
  fields.priority !== task.priority

// ── Expectations: the result the server is expected to send next ───────────

/** The next time Vivid acts on a Task: the earliest follow-up still scheduled, as the server computes it. */
const nextFollowUpAt = (followUps: ReadonlyArray<FollowUp>): number | null => {
  const scheduled = followUps.flatMap((item) => (item.status === 'scheduled' ? [item.at] : []))
  return scheduled.length === 0 ? null : Math.min(...scheduled)
}

/** Applies one change to the Task with this id and leaves every other Task as it is. */
const onTask =
  (id: TaskId, edit: (task: Task) => Task) =>
  (current: TaskList): TaskList => ({
    tasks: current.tasks.map((task) => (task.id === id ? edit(task) : task)),
  })

/**
 * A copy of a Task with some fields replaced. A Task is a plain decoded record, so copying its
 * own fields is a complete copy; the fields are named by the caller, never guessed.
 */
const revised = (task: Task, changes: Partial<Task>): Task => Object.assign({}, task, changes)

/** Replaces a Task's follow-ups and keeps `nextFollowUpAt` in step with them. */
const withFollowUps = (task: Task, followUps: ReadonlyArray<FollowUp>): Task =>
  revised(task, { followUps, nextFollowUpAt: nextFollowUpAt(followUps) })

/** A Task marked done, dropped or reopened. Only a done Task has a completion time. */
export const statusSet = (id: TaskId, status: TaskStatus, now: number) =>
  onTask(id, (task) =>
    revised(task, { status, completedAt: status === 'done' ? now : null, updatedAt: now }),
  )

/** A Task after its editor was saved. */
export const edited = (id: TaskId, fields: TaskFields, now: number) =>
  onTask(id, (task) => revised(task, { ...settledFields(fields), updatedAt: now }))

/** A new Task at the top of the list. */
export const added =
  (task: Task) =>
  (current: TaskList): TaskList => ({ tasks: [task, ...current.tasks] })

/** A deleted Task, gone with its follow-ups. */
export const removed =
  (id: TaskId) =>
  (current: TaskList): TaskList => ({ tasks: current.tasks.filter((task) => task.id !== id) })

/** A follow-up as it will exist once the server has scheduled it. */
export const scheduledFollowUp = (
  taskId: TaskId,
  input: NewFollowUp,
  context: { readonly me: PersonSummary; readonly now: number },
): FollowUp => ({
  id: input.id,
  taskId,
  at: input.at,
  note: input.note,
  repeatEveryMs: input.repeatEveryMs,
  status: 'scheduled',
  submissionId: null,
  firedAt: null,
  output: null,
  error: null,
  createdBy: Author.cases.Person.make({ person: context.me }),
  createdAt: context.now,
})

/** A Task with one more follow-up scheduled. */
export const followUpAdded = (followUp: FollowUp) =>
  onTask(followUp.taskId, (task) => withFollowUps(task, [...task.followUps, followUp]))

/** A follow-up cancelled by the Person, or started now instead of at its time. */
export const followUpSet = (
  taskId: TaskId,
  followUpId: FollowUpId,
  status: Extract<FollowUp['status'], 'cancelled' | 'running'>,
) =>
  onTask(taskId, (task) =>
    withFollowUps(
      task,
      task.followUps.map((item) => (item.id === followUpId ? { ...item, status } : item)),
    ),
  )

/** A Task with one follow-up deleted. */
export const followUpRemoved = (taskId: TaskId, followUpId: FollowUpId) =>
  onTask(taskId, (task) =>
    withFollowUps(
      task,
      task.followUps.filter((item) => item.id !== followUpId),
    ),
  )

/**
 * The Task the server is expected to answer with when a Person adds one by hand.
 *
 * A Task added from Today reports into a Thread of its own, which the server names after the
 * Task (`task-<id>`, see `reportingThread` in the server's Task store). The id is the client's, so
 * the same name can be predicted here. It is a prediction like every other field: the server's
 * next result replaces this Task, Thread included.
 */
export const draftTask = (
  id: TaskId,
  input: { readonly fields: TaskFields; readonly followUp: Option.Option<NewFollowUp> },
  context: { readonly me: PersonSummary; readonly now: number },
): Task => {
  const followUps = Option.match(input.followUp, {
    onNone: () => [],
    onSome: (followUp) => [scheduledFollowUp(id, followUp, context)],
  })
  return {
    id,
    ...settledFields(input.fields),
    status: 'open',
    origin: { kind: 'manual' },
    createdBy: Author.cases.Person.make({ person: context.me }),
    threadId: ThreadId.make(`task-${id}`),
    overdueNotifiedAt: null,
    completedAt: null,
    createdAt: context.now,
    updatedAt: context.now,
    followUps,
    nextFollowUpAt: nextFollowUpAt(followUps),
  }
}

/**
 * Notifications after some were opened, or all of them were. Nothing is removed: a read
 * notification keeps its place in the record and only stops counting as new.
 */
export const notificationsRead =
  (ids: Option.Option<ReadonlyArray<NotificationId>>, now: number) =>
  (current: NotificationList): NotificationList => {
    const chosen = Option.map(ids, (list) => new Set(list))
    const notifications = current.notifications.map((notification) => {
      const reading =
        notification.readAt === null &&
        Option.match(chosen, { onNone: () => true, onSome: (set) => set.has(notification.id) })
      return reading ? { ...notification, readAt: now } : notification
    })
    return {
      notifications,
      unreadCount: notifications.filter((notification) => notification.readAt === null).length,
    }
  }
