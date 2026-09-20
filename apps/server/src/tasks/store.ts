import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { createSelectSchema } from 'drizzle-orm/effect-schema'
import type { EffectPgQueryEffectHKT, EffectPgQueryResultHKT } from 'drizzle-orm/effect-postgres'
import type { PgEffectTransaction } from 'drizzle-orm/pg-core/effect/session'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import {
  DatabaseFailure,
  FollowUp as FollowUpSchema,
  type FollowUp,
  type FollowUpId,
  type FollowUpInput,
  Notification as NotificationSchema,
  type Notification,
  type NotificationId,
  Task as TaskSchema,
  type Task,
  type TaskId,
  TaskStatus as TaskStatusSchema,
  type CreateTaskRequest,
  PatchFollowUpRequest,
  type PatchTaskRequest,
} from '@vivid/contracts'
import { Database, type DatabaseInfrastructureError, returned } from '../database/client.ts'
import { followUps, notifications, tasks } from './tables.ts'

const TaskRow = createSelectSchema(tasks)
const FollowUpRow = createSelectSchema(followUps)
const NotificationRow = createSelectSchema(notifications)
/** A raw `RETURNING` result: the claim statement is SQL text, so its rows are decoded here. */
const RawRows = Schema.Struct({ rows: Schema.Array(FollowUpRow) })

type TaskRecord = Omit<Task, 'followUps' | 'nextFollowUpAt'>
type Author = 'you' | 'vivid'
type TaskStatus = typeof TaskStatusSchema.Type
type PatchFollowUpInput = typeof PatchFollowUpRequest.Type

const databaseDecodeFailure = (subject: string) =>
  new DatabaseFailure({ message: `Database returned an invalid ${subject}` })

const taskRowDecoder = Schema.decodeUnknownEffect(TaskRow)
const taskSchemaDecoder = Schema.decodeUnknownEffect(TaskSchema)

/** Converts the normalized persistence origin columns back into the wire tagged shape. */
const decodeTask = Effect.fn('TaskStore.decodeTask')(function* (value: typeof tasks.$inferSelect) {
  const row = yield* taskRowDecoder(value).pipe(
    Effect.mapError(() => databaseDecodeFailure('Task')),
  )
  const origin =
    row.originKind === 'conversation' && row.originId !== null
      ? { kind: 'conversation' as const, conversationId: row.originId }
      : row.originKind === 'routine' && row.originId !== null
        ? { kind: 'routine' as const, routineId: row.originId }
        : { kind: 'manual' as const }
  const decoded = yield* taskSchemaDecoder({
    ...row,
    origin,
    followUps: [],
    nextFollowUpAt: null,
  }).pipe(Effect.mapError(() => databaseDecodeFailure('Task')))
  const { followUps: _followUps, nextFollowUpAt: _nextFollowUpAt, ...record } = decoded
  return record
})

const followUpRowDecoder = Schema.decodeUnknownEffect(FollowUpRow)
const followUpSchemaDecoder = Schema.decodeUnknownEffect(FollowUpSchema)

const decodeFollowUp = Effect.fn('TaskStore.decodeFollowUp')(function* (
  value: typeof followUps.$inferSelect,
) {
  const row = yield* followUpRowDecoder(value).pipe(
    Effect.mapError(() => databaseDecodeFailure('follow-up')),
  )
  return yield* followUpSchemaDecoder(row).pipe(
    Effect.mapError(() => databaseDecodeFailure('follow-up')),
  )
})

const notificationRowDecoder = Schema.decodeUnknownEffect(NotificationRow)
const notificationSchemaDecoder = Schema.decodeUnknownEffect(NotificationSchema)

const decodeNotification = Effect.fn('TaskStore.decodeNotification')(function* (
  value: typeof notifications.$inferSelect,
) {
  const row = yield* notificationRowDecoder(value).pipe(
    Effect.mapError(() => databaseDecodeFailure('notification')),
  )
  return yield* notificationSchemaDecoder(row).pipe(
    Effect.mapError(() => databaseDecodeFailure('notification')),
  )
})

const timestamp = (value: number | string): number => new Date(value).getTime()

const originId = (origin: TaskRecord['origin']) => {
  if (origin.kind === 'conversation') return origin.conversationId
  if (origin.kind === 'routine') return origin.routineId
  return null
}

export interface CreateTaskStoreInput {
  readonly request: CreateTaskRequest
  readonly origin: TaskRecord['origin']
  readonly createdBy: Author
}

export interface TaskStoreService {
  readonly list: (
    status?: TaskStatus,
  ) => Effect.Effect<ReadonlyArray<Task>, DatabaseInfrastructureError>
  readonly get: (id: TaskId) => Effect.Effect<Option.Option<Task>, DatabaseInfrastructureError>
  readonly create: (input: CreateTaskStoreInput) => Effect.Effect<Task, DatabaseInfrastructureError>
  readonly patch: (
    id: TaskId,
    patch: PatchTaskRequest,
  ) => Effect.Effect<Option.Option<Task>, DatabaseInfrastructureError>
  readonly remove: (id: TaskId) => Effect.Effect<boolean, DatabaseInfrastructureError>
  readonly addFollowUp: (
    taskId: TaskId,
    input: FollowUpInput,
    createdBy: Author,
  ) => Effect.Effect<FollowUp, DatabaseInfrastructureError>
  readonly getFollowUp: (
    id: FollowUpId,
  ) => Effect.Effect<Option.Option<FollowUp>, DatabaseInfrastructureError>
  readonly patchFollowUp: (
    id: FollowUpId,
    patch: PatchFollowUpInput,
  ) => Effect.Effect<Option.Option<FollowUp>, DatabaseInfrastructureError>
  readonly removeFollowUp: (id: FollowUpId) => Effect.Effect<boolean, DatabaseInfrastructureError>
  readonly claimFollowUp: (
    id: FollowUpId,
  ) => Effect.Effect<Option.Option<FollowUp>, DatabaseInfrastructureError>
  readonly claimDueFollowUps: () => Effect.Effect<
    ReadonlyArray<FollowUp>,
    DatabaseInfrastructureError
  >
  readonly attachSubmission: (
    id: FollowUpId,
    submissionId: string,
  ) => Effect.Effect<boolean, DatabaseInfrastructureError>
  readonly listNotifications: () => Effect.Effect<
    ReadonlyArray<Notification>,
    DatabaseInfrastructureError
  >
  readonly markNotificationsRead: (
    ids?: ReadonlyArray<NotificationId>,
  ) => Effect.Effect<number, DatabaseInfrastructureError>
  readonly unreadNotificationCount: () => Effect.Effect<number, DatabaseInfrastructureError>
}

export class TaskStore extends Context.Service<TaskStore, TaskStoreService>()('vivid/TaskStore') {}

const rawRowsDecoder = Schema.decodeUnknownEffect(RawRows)

type TaskDatabase = Database['Service']
type TaskTransaction = PgEffectTransaction<EffectPgQueryEffectHKT, EffectPgQueryResultHKT>

/** Claims due follow-ups inside the transaction supplied by the database adapter. */
const claimDueInTransaction = Effect.fn('TaskStore.claimDueInTransaction')(function* (
  tx: TaskTransaction,
  now: number,
) {
  const result = yield* tx.execute(sql`
    WITH due AS (
      SELECT id FROM vivid_follow_ups
      WHERE status = 'scheduled' AND at <= ${now}
      ORDER BY at ASC FOR UPDATE SKIP LOCKED
    )
    UPDATE vivid_follow_ups target SET status = 'running', fired_at = ${now}, error = NULL
    FROM due WHERE target.id = due.id
    RETURNING target.id, target.task_id AS "taskId", target.at::float8 AS at, target.note,
      target.repeat_every_ms::float8 AS "repeatEveryMs", target.status,
      target.submission_id AS "submissionId", target.fired_at::float8 AS "firedAt",
      target.output, target.error, target.created_by AS "createdBy",
      target.created_at::float8 AS "createdAt"
  `)
  const claimed = yield* rawRowsDecoder(result).pipe(
    Effect.mapError(() => databaseDecodeFailure('follow-up claim')),
  )
  return yield* Effect.forEach(claimed.rows, decodeFollowUp)
})

/** Builds task reads so persistence access stays separate from mutation policy. */
const makeTaskReads = (database: TaskDatabase) => {
  const listFollowUps = Effect.fn('TaskStore.listFollowUps')(function* (taskId: TaskId) {
    const rows = yield* database.run(
      database
        .select()
        .from(followUps)
        .where(eq(followUps.taskId, taskId))
        .orderBy(desc(followUps.at)),
    )
    return yield* Effect.forEach(rows, decodeFollowUp)
  })

  const view = Effect.fn('TaskStore.view')(function* (record: TaskRecord) {
    const taskFollowUps = yield* listFollowUps(record.id)
    const nextFollowUpAt = taskFollowUps.reduce<number | null>((next, item) => {
      if (item.status !== 'scheduled') return next
      return next === null || item.at < next ? item.at : next
    }, null)
    return { ...record, followUps: taskFollowUps, nextFollowUpAt } satisfies Task
  })

  const getRecord = Effect.fn('TaskStore.getRecord')(function* (id: TaskId) {
    const rows = yield* database.run(database.select().from(tasks).where(eq(tasks.id, id)).limit(1))
    const row = rows[0]
    return row === undefined ? Option.none<TaskRecord>() : Option.some(yield* decodeTask(row))
  })

  const get = Effect.fn('TaskStore.get')(function* (id: TaskId) {
    const record = yield* getRecord(id)
    if (Option.isNone(record)) return Option.none<Task>()
    return Option.some(yield* view(record.value))
  })

  const list = Effect.fn('TaskStore.list')(function* (status?: TaskStatus) {
    const rows = yield* database.run(
      database
        .select()
        .from(tasks)
        .where(status === undefined ? undefined : eq(tasks.status, status))
        .orderBy(
          desc(sql`(${tasks.status} = 'open')`),
          asc(sql`(${tasks.dueAt} IS NULL)`),
          asc(tasks.dueAt),
          desc(tasks.createdAt),
        ),
    )
    const records = yield* Effect.forEach(rows, decodeTask)
    return yield* Effect.forEach(records, view, { concurrency: 1 })
  })

  return { listFollowUps, view, getRecord, get, list }
}

/** Builds task mutations while reusing the read projection and record lookup. */
const makeTaskWrites = (database: TaskDatabase, reads: ReturnType<typeof makeTaskReads>) => {
  const addFollowUp = Effect.fn('TaskStore.addFollowUp')(function* (
    taskId: TaskId,
    input: FollowUpInput,
    createdBy: Author,
  ) {
    const now = yield* Clock.currentTimeMillis
    const rows = yield* database.run(
      database
        .insert(followUps)
        .values({
          id: input.id ?? crypto.randomUUID(),
          taskId,
          at: timestamp(input.at),
          note: input.note ?? '',
          repeatEveryMs: input.repeatEveryMs ?? null,
          status: 'scheduled',
          submissionId: null,
          firedAt: null,
          output: null,
          error: null,
          createdBy,
          createdAt: now,
        })
        .returning(),
    )
    return yield* decodeFollowUp(yield* returned(rows, 'Task'))
  })

  const create = Effect.fn('TaskStore.create')(function* (input: CreateTaskStoreInput) {
    const now = yield* Clock.currentTimeMillis
    const id = input.request.id ?? crypto.randomUUID()
    const request = input.request
    const rows = yield* database.run(
      database
        .insert(tasks)
        .values({
          id,
          title: request.title,
          detail: request.detail ?? '',
          status: 'open',
          priority: request.priority ?? 'normal',
          assignee: request.assignee ?? null,
          dueAt:
            request.dueAt === undefined || request.dueAt === null ? null : timestamp(request.dueAt),
          originKind: input.origin.kind,
          originId: originId(input.origin),
          createdBy: input.createdBy,
          conversationId: `task-${id}`,
          overdueNotifiedAt: null,
          completedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning(),
    )
    const record = yield* decodeTask(yield* returned(rows, 'Task'))
    if (request.followUp !== undefined)
      yield* addFollowUp(record.id, request.followUp, input.createdBy)
    return yield* reads.view(record)
  })

  const patch = Effect.fn('TaskStore.patch')(function* (id: TaskId, patchInput: PatchTaskRequest) {
    const current = yield* reads.getRecord(id)
    if (Option.isNone(current)) return Option.none<Task>()
    const now = yield* Clock.currentTimeMillis
    const update = taskUpdateValues(current.value, patchInput, now)
    const rows = yield* database.run(
      database.update(tasks).set(update.values).where(eq(tasks.id, id)).returning(),
    )
    if (update.status !== 'open') {
      yield* database.run(
        database
          .update(followUps)
          .set({ status: 'cancelled' })
          .where(and(eq(followUps.taskId, id), eq(followUps.status, 'scheduled'))),
      )
    }
    const row = rows[0]
    if (row === undefined) return Option.none<Task>()
    return Option.some(yield* reads.view(yield* decodeTask(row)))
  })

  const remove = Effect.fn('TaskStore.remove')(function* (id: TaskId) {
    const rows = yield* database.run(
      database.delete(tasks).where(eq(tasks.id, id)).returning({ id: tasks.id }),
    )
    return rows.length > 0
  })

  return { addFollowUp, create, patch, remove }
}

/** Computes a task update once so the persistence operation has one status decision. */
const taskUpdateValues = (current: TaskRecord, patchInput: PatchTaskRequest, now: number) => {
  const status = patchInput.status ?? current.status
  return {
    status,
    values: {
      title: patchInput.title ?? current.title,
      detail: patchInput.detail ?? current.detail,
      assignee: patchInput.assignee === undefined ? current.assignee : patchInput.assignee,
      dueAt:
        patchInput.dueAt === undefined
          ? current.dueAt
          : patchInput.dueAt === null
            ? null
            : timestamp(patchInput.dueAt),
      priority: patchInput.priority ?? current.priority,
      status,
      completedAt: status === 'done' ? (current.completedAt ?? now) : null,
      overdueNotifiedAt: patchInput.dueAt === undefined ? current.overdueNotifiedAt : null,
      updatedAt: now,
    },
  }
}

/** Builds follow-up persistence operations, including the transactionally safe claim path. */
const makeFollowUpOperations = (database: TaskDatabase) => {
  const getFollowUp = Effect.fn('TaskStore.getFollowUp')(function* (id: FollowUpId) {
    const rows = yield* database.run(
      database.select().from(followUps).where(eq(followUps.id, id)).limit(1),
    )
    const row = rows[0]
    return row === undefined ? Option.none<FollowUp>() : Option.some(yield* decodeFollowUp(row))
  })

  const patchFollowUp = Effect.fn('TaskStore.patchFollowUp')(function* (
    id: FollowUpId,
    patchInput: PatchFollowUpInput,
  ) {
    const current = yield* getFollowUp(id)
    if (Option.isNone(current)) return Option.none<FollowUp>()
    const status = patchInput.status ?? current.value.status
    const rerun = status === 'scheduled' && current.value.status !== 'scheduled'
    const rows = yield* database.run(
      database
        .update(followUps)
        .set({
          at: patchInput.at === undefined ? current.value.at : timestamp(patchInput.at),
          note: patchInput.note ?? current.value.note,
          repeatEveryMs:
            patchInput.repeatEveryMs === undefined
              ? current.value.repeatEveryMs
              : patchInput.repeatEveryMs,
          status,
          submissionId: rerun ? null : current.value.submissionId,
          firedAt: rerun ? null : current.value.firedAt,
          output: rerun ? null : current.value.output,
          error: rerun ? null : current.value.error,
        })
        .where(eq(followUps.id, id))
        .returning(),
    )
    const row = rows[0]
    return row === undefined ? Option.none<FollowUp>() : Option.some(yield* decodeFollowUp(row))
  })

  const removeFollowUp = Effect.fn('TaskStore.removeFollowUp')(function* (id: FollowUpId) {
    const rows = yield* database.run(
      database.delete(followUps).where(eq(followUps.id, id)).returning({ id: followUps.id }),
    )
    return rows.length > 0
  })

  const claimFollowUp = Effect.fn('TaskStore.claimFollowUp')(function* (id: FollowUpId) {
    const now = yield* Clock.currentTimeMillis
    const rows = yield* database.run(
      database
        .update(followUps)
        .set({ status: 'running', firedAt: now, error: null })
        .where(and(eq(followUps.id, id), eq(followUps.status, 'scheduled')))
        .returning(),
    )
    const row = rows[0]
    return row === undefined ? yield* getFollowUp(id) : Option.some(yield* decodeFollowUp(row))
  })

  const claimDueFollowUps = Effect.fn('TaskStore.claimDueFollowUps')(function* () {
    const now = yield* Clock.currentTimeMillis
    return yield* database.transaction((tx) => claimDueInTransaction(tx, now))
  })

  const attachSubmission = Effect.fn('TaskStore.attachSubmission')(function* (
    id: FollowUpId,
    submissionId: string,
  ) {
    const rows = yield* database.run(
      database
        .update(followUps)
        .set({ submissionId })
        .where(and(eq(followUps.id, id), eq(followUps.status, 'running')))
        .returning({ id: followUps.id }),
    )
    return rows.length > 0
  })

  return {
    getFollowUp,
    patchFollowUp,
    removeFollowUp,
    claimFollowUp,
    claimDueFollowUps,
    attachSubmission,
  }
}

/** Builds the read and mutation operations for Person attention indicators. */
const makeNotificationOperations = (database: TaskDatabase) => {
  const listNotifications = Effect.fn('TaskStore.listNotifications')(function* () {
    const rows = yield* database.run(
      database.select().from(notifications).orderBy(desc(notifications.createdAt)).limit(50),
    )
    return yield* Effect.forEach(rows, decodeNotification)
  })

  const unreadNotificationCount = Effect.fn('TaskStore.unreadNotificationCount')(function* () {
    const rows = yield* database.run(
      database
        .select({ count: sql<number>`count(*)`.mapWith(Number) })
        .from(notifications)
        .where(isNull(notifications.readAt)),
    )
    const row = rows[0]
    return row === undefined ? 0 : row.count
  })

  const markNotificationsRead = Effect.fn('TaskStore.markNotificationsRead')(function* (
    ids?: ReadonlyArray<NotificationId>,
  ) {
    if (ids !== undefined && ids.length === 0) return 0
    const now = yield* Clock.currentTimeMillis
    const condition =
      ids === undefined
        ? isNull(notifications.readAt)
        : and(isNull(notifications.readAt), inArray(notifications.id, ids))
    const rows = yield* database.run(
      database
        .update(notifications)
        .set({ readAt: now })
        .where(condition)
        .returning({ id: notifications.id }),
    )
    return rows.length
  })

  return { listNotifications, markNotificationsRead, unreadNotificationCount }
}

export const taskStoreLayer = Layer.effect(
  TaskStore,
  Effect.gen(function* () {
    const database = yield* Database
    const reads = makeTaskReads(database)
    const writes = makeTaskWrites(database, reads)
    const followUpOperations = makeFollowUpOperations(database)
    const notificationOperations = makeNotificationOperations(database)

    return TaskStore.of({
      list: reads.list,
      get: reads.get,
      create: writes.create,
      patch: writes.patch,
      remove: writes.remove,
      addFollowUp: writes.addFollowUp,
      getFollowUp: followUpOperations.getFollowUp,
      patchFollowUp: followUpOperations.patchFollowUp,
      removeFollowUp: followUpOperations.removeFollowUp,
      claimFollowUp: followUpOperations.claimFollowUp,
      claimDueFollowUps: followUpOperations.claimDueFollowUps,
      attachSubmission: followUpOperations.attachSubmission,
      listNotifications: notificationOperations.listNotifications,
      markNotificationsRead: notificationOperations.markNotificationsRead,
      unreadNotificationCount: notificationOperations.unreadNotificationCount,
    })
  }),
)
