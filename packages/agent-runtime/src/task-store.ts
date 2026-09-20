import * as NodeCrypto from 'node:crypto'
import { and, asc, desc, eq, gte, inArray, isNull, isNotNull, lte, lt, or, sql } from 'drizzle-orm'
import { db, schemaReady } from './runtime-db.ts'
import { followUps, notifications, tasks } from './runtime-schema.ts'
import { decodeFollowUp, decodeNotification, decodeTaskRow } from './runtime-codecs.ts'

export type TaskStatus = 'open' | 'done' | 'dropped'
export type TaskPriority = 'normal' | 'urgent'
export type Author = 'you' | 'vivid'
export type TaskOrigin =
  | { kind: 'conversation'; conversationId: string }
  | { kind: 'routine'; routineId: string }
  | { kind: 'manual' }
export type Task = {
  id: string
  title: string
  detail: string
  status: TaskStatus
  priority: TaskPriority
  assignee: string | null
  dueAt: number | null
  origin: TaskOrigin
  createdBy: Author
  conversationId: string
  overdueNotifiedAt: number | null
  completedAt: number | null
  createdAt: number
  updatedAt: number
}
export type FollowUpStatus = 'scheduled' | 'running' | 'fired' | 'cancelled' | 'failed'
export type FollowUp = {
  id: string
  taskId: string
  at: number
  note: string
  repeatEveryMs: number | null
  status: FollowUpStatus
  submissionId: string | null
  firedAt: number | null
  output: string | null
  error: string | null
  createdBy: Author
  createdAt: number
}
export type NotificationKind = 'tracked' | 'overdue' | 'follow-up' | 'follow-up-failed'
export type Notification = {
  id: string
  kind: NotificationKind
  title: string
  body: string
  taskId: string | null
  conversationId: string | null
  createdAt: number
  readAt: number | null
}
export type TaskView = Task & { followUps: FollowUp[]; nextFollowUpAt: number | null }
export const TASK_STATUSES: readonly TaskStatus[] = ['open', 'done', 'dropped']
export const TASK_PRIORITIES: readonly TaskPriority[] = ['normal', 'urgent']

const taskSelection = {
  id: tasks.id,
  title: tasks.title,
  detail: tasks.detail,
  status: tasks.status,
  priority: tasks.priority,
  assignee: tasks.assignee,
  dueAt: tasks.dueAt,
  originKind: tasks.originKind,
  originId: tasks.originId,
  createdBy: tasks.createdBy,
  conversationId: tasks.conversationId,
  overdueNotifiedAt: tasks.overdueNotifiedAt,
  completedAt: tasks.completedAt,
  createdAt: tasks.createdAt,
  updatedAt: tasks.updatedAt,
}
const followUpSelection = {
  id: followUps.id,
  taskId: followUps.taskId,
  at: followUps.at,
  note: followUps.note,
  repeatEveryMs: followUps.repeatEveryMs,
  status: followUps.status,
  submissionId: followUps.submissionId,
  firedAt: followUps.firedAt,
  output: followUps.output,
  error: followUps.error,
  createdBy: followUps.createdBy,
  createdAt: followUps.createdAt,
}
const notificationSelection = {
  id: notifications.id,
  kind: notifications.kind,
  title: notifications.title,
  body: notifications.body,
  taskId: notifications.taskId,
  conversationId: notifications.conversationId,
  createdAt: notifications.createdAt,
  readAt: notifications.readAt,
}

function mapTask(row: Parameters<typeof decodeTaskRow>[0]): Task {
  const { originKind, originId, ...value } = decodeTaskRow(row)
  const origin: TaskOrigin =
    originKind === 'conversation' && originId
      ? { kind: 'conversation', conversationId: originId }
      : originKind === 'routine' && originId
        ? { kind: 'routine', routineId: originId }
        : { kind: 'manual' }
  return { ...value, origin }
}

export async function listTasks(status?: TaskStatus): Promise<Task[]> {
  await schemaReady
  const rows = await db
    .select(taskSelection)
    .from(tasks)
    .where(status ? eq(tasks.status, status) : undefined)
    .orderBy(
      desc(sql`(${tasks.status} = 'open')`),
      asc(sql`(${tasks.dueAt} IS NULL)`),
      asc(tasks.dueAt),
      desc(tasks.createdAt),
    )
  return rows.map(mapTask)
}

export async function getTask(id: string): Promise<Task | null> {
  await schemaReady
  const rows = await db.select(taskSelection).from(tasks).where(eq(tasks.id, id))
  return rows[0] ? mapTask(rows[0]) : null
}

export interface CreateTaskInput {
  readonly id?: string
  readonly title: string
  readonly detail?: string
  readonly assignee?: string | null
  readonly dueAt?: number | null
  readonly priority?: TaskPriority
  readonly origin: TaskOrigin
  readonly createdBy: Author
}

const taskOriginId = (origin: TaskOrigin) => {
  switch (origin.kind) {
    case 'conversation':
      return origin.conversationId
    case 'routine':
      return origin.routineId
    case 'manual':
      return null
  }
  return origin
}

/** Builds the canonical Task returned when an idempotent insert wins or already exists. */
function taskFromInput(input: CreateTaskInput, id: string, now: number): Task {
  return {
    id,
    title: input.title,
    detail: input.detail ?? '',
    status: 'open',
    priority: input.priority ?? 'normal',
    assignee: input.assignee ?? null,
    dueAt: input.dueAt ?? null,
    origin: input.origin,
    createdBy: input.createdBy,
    conversationId: `task-${id}`,
    overdueNotifiedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  }
}

export async function createTask(input: CreateTaskInput): Promise<Task> {
  await schemaReady
  const now = Date.now()
  const id = input.id ?? NodeCrypto.randomUUID()
  const task = taskFromInput(input, id, now)
  await db
    .insert(tasks)
    .values({
      id: task.id,
      title: task.title,
      detail: task.detail,
      status: task.status,
      priority: task.priority,
      assignee: task.assignee,
      dueAt: task.dueAt,
      originKind: task.origin.kind,
      originId: taskOriginId(task.origin),
      createdBy: task.createdBy,
      conversationId: task.conversationId,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    })
    .onConflictDoNothing({ target: tasks.id })
  return (await getTask(id)) ?? task
}

export type TaskPatch = Partial<
  Pick<Task, 'title' | 'detail' | 'assignee' | 'dueAt' | 'priority' | 'status'>
>

const taskCompletionAt = (current: Task, status: TaskStatus, now: number) => {
  if (status !== 'done') return null
  return current.status === 'done' ? current.completedAt : now
}

/** Derives one persistence update while preserving omitted nullable fields. */
function taskUpdateValues(current: Task, patch: TaskPatch, now: number) {
  const status = patch.status ?? current.status
  return {
    title: patch.title ?? current.title,
    detail: patch.detail ?? current.detail,
    assignee: patch.assignee === undefined ? current.assignee : patch.assignee,
    dueAt: patch.dueAt === undefined ? current.dueAt : patch.dueAt,
    priority: patch.priority ?? current.priority,
    status,
    completedAt: taskCompletionAt(current, status, now),
    overdueNotifiedAt:
      patch.dueAt !== undefined && patch.dueAt !== current.dueAt ? null : current.overdueNotifiedAt,
    updatedAt: now,
  }
}

export async function updateTask(id: string, patch: TaskPatch): Promise<Task | null> {
  const current = await getTask(id)
  if (!current) return null
  const values = taskUpdateValues(current, patch, Date.now())
  await db.update(tasks).set(values).where(eq(tasks.id, id))
  if (values.status !== 'open') {
    await db
      .update(followUps)
      .set({ status: 'cancelled' })
      .where(and(eq(followUps.taskId, id), eq(followUps.status, 'scheduled')))
  }
  return await getTask(id)
}

export async function deleteTask(id: string): Promise<boolean> {
  await schemaReady
  return (await db.delete(tasks).where(eq(tasks.id, id)).returning({ id: tasks.id })).length > 0
}

export async function overdueTasks(now: number): Promise<Task[]> {
  await schemaReady
  return (
    await db
      .select(taskSelection)
      .from(tasks)
      .where(
        and(
          eq(tasks.status, 'open'),
          isNotNull(tasks.dueAt),
          lt(tasks.dueAt, now),
          isNull(tasks.overdueNotifiedAt),
        ),
      )
  ).map(mapTask)
}

export async function markTaskOverdueNotified(id: string, at: number): Promise<void> {
  await db.update(tasks).set({ overdueNotifiedAt: at }).where(eq(tasks.id, id))
}

export async function listFollowUps(taskId: string): Promise<FollowUp[]> {
  await schemaReady
  return (
    await db
      .select(followUpSelection)
      .from(followUps)
      .where(eq(followUps.taskId, taskId))
      .orderBy(desc(followUps.at))
  ).map((row) => decodeFollowUp(row))
}

export async function getFollowUp(id: string): Promise<FollowUp | null> {
  await schemaReady
  const rows = await db.select(followUpSelection).from(followUps).where(eq(followUps.id, id))
  return rows[0] ? decodeFollowUp(rows[0]) : null
}

export async function createFollowUp(input: {
  id?: string
  taskId: string
  at: number
  note?: string
  repeatEveryMs?: number | null
  createdBy: Author
}): Promise<FollowUp> {
  await schemaReady
  const followUp: FollowUp = {
    id: input.id ?? NodeCrypto.randomUUID(),
    taskId: input.taskId,
    at: input.at,
    note: input.note ?? '',
    repeatEveryMs: input.repeatEveryMs ?? null,
    status: 'scheduled',
    submissionId: null,
    firedAt: null,
    output: null,
    error: null,
    createdBy: input.createdBy,
    createdAt: Date.now(),
  }
  await db.insert(followUps).values(followUp).onConflictDoNothing({ target: followUps.id })
  return (await getFollowUp(followUp.id)) ?? followUp
}

export async function updateFollowUp(
  id: string,
  patch: Partial<Pick<FollowUp, 'at' | 'note' | 'repeatEveryMs' | 'status'>>,
): Promise<FollowUp | null> {
  const current = await getFollowUp(id)
  if (!current) return null
  const status = patch.status ?? current.status
  const rerun = status === 'scheduled' && current.status !== 'scheduled'
  const values = {
    at: patch.at ?? current.at,
    note: patch.note ?? current.note,
    repeatEveryMs: patch.repeatEveryMs === undefined ? current.repeatEveryMs : patch.repeatEveryMs,
    status,
  }
  if (rerun)
    await db
      .update(followUps)
      .set({ ...values, submissionId: null, firedAt: null, output: null, error: null })
      .where(eq(followUps.id, id))
  else await db.update(followUps).set(values).where(eq(followUps.id, id))
  return await getFollowUp(id)
}

export async function deleteFollowUp(id: string): Promise<boolean> {
  await schemaReady
  return (
    (await db.delete(followUps).where(eq(followUps.id, id)).returning({ id: followUps.id }))
      .length > 0
  )
}

export async function dueFollowUps(now: number): Promise<FollowUp[]> {
  await schemaReady
  return (
    await db
      .select(followUpSelection)
      .from(followUps)
      .where(and(eq(followUps.status, 'scheduled'), lte(followUps.at, now)))
      .orderBy(asc(followUps.at))
  ).map((row) => decodeFollowUp(row))
}

export async function listRunningFollowUps(): Promise<FollowUp[]> {
  await schemaReady
  return (
    await db
      .select(followUpSelection)
      .from(followUps)
      .where(eq(followUps.status, 'running'))
      .orderBy(asc(followUps.firedAt))
  ).map((row) => decodeFollowUp(row))
}

export async function hasFollowUpCovering(taskId: string, since: number): Promise<boolean> {
  await schemaReady
  return (
    (
      await db
        .select({ id: followUps.id })
        .from(followUps)
        .where(
          and(
            eq(followUps.taskId, taskId),
            or(
              inArray(followUps.status, ['scheduled', 'running']),
              and(eq(followUps.status, 'fired'), gte(followUps.firedAt, since)),
            ),
          ),
        )
        .limit(1)
    ).length > 0
  )
}

export async function startFollowUp(id: string, firedAt: number): Promise<boolean> {
  const rows = await db
    .update(followUps)
    .set({ status: 'running', firedAt, error: null })
    .where(and(eq(followUps.id, id), eq(followUps.status, 'scheduled')))
    .returning({ id: followUps.id })
  return rows.length > 0
}

export async function attachFollowUpSubmission(id: string, submissionId: string): Promise<boolean> {
  const rows = await db
    .update(followUps)
    .set({ submissionId })
    .where(and(eq(followUps.id, id), eq(followUps.status, 'running')))
    .returning({ id: followUps.id })
  return rows.length > 0
}

export async function finishFollowUp(id: string, output: string): Promise<boolean> {
  const rows = await db
    .update(followUps)
    .set({ status: 'fired', output, error: null })
    .where(and(eq(followUps.id, id), eq(followUps.status, 'running')))
    .returning({ id: followUps.id })
  return rows.length > 0
}

type DatabaseLike = Pick<typeof db, 'insert' | 'select'>
async function createNotificationWithDb(
  q: DatabaseLike,
  input: {
    id?: string
    kind: NotificationKind
    title: string
    body?: string
    taskId?: string | null
    conversationId?: string | null
  },
): Promise<Notification> {
  const notification: Notification = {
    id: input.id ?? NodeCrypto.randomUUID(),
    kind: input.kind,
    title: input.title.slice(0, 200),
    body: (input.body ?? '').slice(0, 600),
    taskId: input.taskId ?? null,
    conversationId: input.conversationId ?? null,
    createdAt: Date.now(),
    readAt: null,
  }
  await q
    .insert(notifications)
    .values(notification)
    .onConflictDoNothing({ target: notifications.id })
  const rows = await q
    .select(notificationSelection)
    .from(notifications)
    .where(eq(notifications.id, notification.id))
  return rows[0] ? decodeNotification(rows[0]) : notification
}

export async function createNotification(input: {
  id?: string
  kind: NotificationKind
  title: string
  body?: string
  taskId?: string | null
  conversationId?: string | null
}): Promise<Notification> {
  await schemaReady
  return createNotificationWithDb(db, input)
}

export async function completeFollowUp(
  id: string,
  completion: {
    output: string
    nextFollowUp?: { at: number; note?: string; repeatEveryMs?: number | null; createdBy: Author }
    notification: {
      kind: NotificationKind
      title: string
      body?: string
      taskId?: string | null
      conversationId?: string | null
    }
  },
): Promise<boolean> {
  await schemaReady
  return db.transaction(async (tx) => {
    const currentRows = await tx
      .select(followUpSelection)
      .from(followUps)
      .where(eq(followUps.id, id))
    const current = currentRows[0] ? decodeFollowUp(currentRows[0]) : undefined
    const changed = await tx
      .update(followUps)
      .set({ status: 'fired', output: completion.output, error: null })
      .where(and(eq(followUps.id, id), eq(followUps.status, 'running')))
      .returning({ id: followUps.id })
    if (!changed.length) return false
    await createNotificationWithDb(tx, completion.notification)
    if (current && completion.nextFollowUp) {
      const next = completion.nextFollowUp
      await tx
        .insert(followUps)
        .values({
          id: NodeCrypto.randomUUID(),
          taskId: current.taskId,
          at: next.at,
          note: next.note ?? '',
          repeatEveryMs: next.repeatEveryMs ?? null,
          status: 'scheduled',
          createdBy: next.createdBy,
          createdAt: Date.now(),
        })
        .onConflictDoNothing({ target: followUps.id })
    }
    return true
  })
}

export async function failFollowUp(id: string, error: string): Promise<boolean> {
  const rows = await db
    .update(followUps)
    .set({ status: 'failed', error })
    .where(and(eq(followUps.id, id), inArray(followUps.status, ['scheduled', 'running'])))
    .returning({ id: followUps.id })
  return rows.length > 0
}

export async function listNotifications(limit = 50): Promise<Notification[]> {
  await schemaReady
  return (
    await db
      .select(notificationSelection)
      .from(notifications)
      .orderBy(desc(notifications.createdAt))
      .limit(limit)
  ).map((row) => decodeNotification(row))
}

export async function unreadNotificationCount(): Promise<number> {
  await schemaReady
  const rows = await db
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(notifications)
    .where(isNull(notifications.readAt))
  const [row] = rows
  return row === undefined ? 0 : row.count
}

export async function markNotificationsRead(ids?: ReadonlyArray<string>): Promise<number> {
  await schemaReady
  const now = Date.now()
  if (!ids)
    return (
      await db
        .update(notifications)
        .set({ readAt: now })
        .where(isNull(notifications.readAt))
        .returning({ id: notifications.id })
    ).length
  if (ids.length === 0) return 0
  return (
    await db
      .update(notifications)
      .set({ readAt: now })
      .where(and(isNull(notifications.readAt), inArray(notifications.id, ids)))
      .returning({ id: notifications.id })
  ).length
}

export async function getTaskView(task: Task): Promise<TaskView> {
  const taskFollowUps = await listFollowUps(task.id)
  const next = taskFollowUps.reduce<number | null>((earliest, item) => {
    if (item.status !== 'scheduled') return earliest
    if (earliest === null || item.at < earliest) return item.at
    return earliest
  }, null)
  return { ...task, followUps: taskFollowUps, nextFollowUpAt: next }
}

export async function listTaskViews(status?: TaskStatus): Promise<TaskView[]> {
  return Promise.all((await listTasks(status)).map(getTaskView))
}
