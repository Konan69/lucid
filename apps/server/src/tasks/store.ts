import { and, asc, desc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm'
import * as Clock from 'effect/Clock'
import * as Array from 'effect/Array'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Record from 'effect/Record'
import {
  AssigneeInput,
  Conflict,
  FollowUpId,
  InvalidRequest,
  NotFound,
  TaskId,
  ThreadId,
  type CreateTaskRequest,
  type FollowUp,
  type FollowUpInput,
  type PatchFollowUpRequest,
  type PatchTaskRequest,
  type TaskListQuery,
} from '@vivid/contracts'
import { companyColumnOf, loadSummaries, type Actor } from '../auth/access.ts'
import { Database, returned } from '../database/client.ts'
import { Changes } from '../live/changes.ts'
import { Notifier } from '../notifications/notifier.ts'
import { requireThread } from '../threads/access.ts'
import { ThreadStore } from '../threads/store.ts'
import { threads } from '../threads/tables.ts'
import { visible, visibleIds, publishTask } from './access.ts'
import { assignment, timestamp, scheduleInput } from './input.ts'
import {
  decodeTaskRow,
  decodeStoredFollowUp,
  projectStoredFollowUp,
  projectFollowUp,
  projectTask,
  originOf,
  originColumn,
  storedFollowUpAuthor,
  DeliveryOutcome,
  DeliveryRecord,
  type StoredTask,
} from './projection.ts'
import { followUps, tasks } from './tables.ts'

/** Ten minutes exceeds normal admission; stale claims keep their original fired-at replay identity. */
export const FOLLOW_UP_ABANDONED_MS = 10 * 60_000

/** Batch dependent rows and identities once, independent of the number of Tasks returned. */
const makeViews = (database: Database['Service']) => {
  /** One IN read for follow-ups and one summary read keep list cost independent of Task count. */
  const views = Effect.fn('TaskStore.views')(function* (rows: ReadonlyArray<StoredTask>) {
    if (rows.length === 0) return []
    const records = yield* database.run(
      database
        .select()
        .from(followUps)
        .where(
          inArray(
            followUps.taskId,
            rows.map((row) => row.id),
          ),
        )
        .orderBy(desc(followUps.at), asc(followUps.id)),
    )
    const stored = yield* Effect.forEach(records, decodeStoredFollowUp)
    const ids = rows.flatMap((row) =>
      row.assigneePersonId === null ? [row.personId] : [row.personId, row.assigneePersonId],
    )
    const people = yield* loadSummaries([
      ...ids,
      ...stored.map((item) => item.author.personId),
    ]).pipe(Effect.provideService(Database, database))
    const followUpViews = yield* Effect.forEach(stored, (item) =>
      projectStoredFollowUp(item, people),
    )
    const grouped = Array.groupBy(followUpViews, (item) => item.taskId)
    return yield* Effect.forEach(rows, (row) => {
      const items = Option.getOrElse(Record.get(grouped, row.id), () => [])
      return projectTask(row, items, people)
    })
  })
  /** A single-record projection shares the exact batched path used by search, List and Watch. */
  const view = Effect.fn('TaskStore.view')(function* (row: StoredTask) {
    return yield* returned(yield* views([row]), 'Task')
  })
  return { view, views }
}

/** Scoped reads and wire projection are shared by every Task entry point, including search. */
const makeReads = (database: Database['Service']) => {
  const { view, views } = makeViews(database)
  /** Another workspace's id and an absent id produce the same failure. */
  const record = Effect.fn('TaskStore.record')(function* (actor: Actor, id: TaskId) {
    const rows = yield* database.run(
      database
        .select({ task: tasks })
        .from(tasks)
        .innerJoin(threads, eq(tasks.conversationId, threads.id))
        .where(and(visible(database, actor), eq(tasks.id, id)))
        .limit(1),
    )
    const row = rows[0]
    if (row === undefined) return yield* Effect.fail(new NotFound({ message: 'Task not found' }))
    return yield* decodeTaskRow(row.task)
  })
  /** A single Task uses exactly the access condition of the list. */
  const get = Effect.fn('TaskStore.get')(function* (actor: Actor, id: TaskId) {
    return yield* view(yield* record(actor, id))
  })
  /** SQL joins and a correlated participant existence check keep private Tasks out of the result. */
  const list = Effect.fn('TaskStore.list')(function* (
    actor: Actor,
    query: typeof TaskListQuery.Type,
  ) {
    const status = query.status === undefined ? undefined : eq(tasks.status, query.status)
    const rows = yield* database.run(
      database
        .select({ task: tasks })
        .from(tasks)
        .innerJoin(threads, eq(tasks.conversationId, threads.id))
        .where(and(visible(database, actor), status))
        .orderBy(
          desc(sql`(${tasks.status} = 'open')`),
          asc(sql`(${tasks.dueAt} IS NULL)`),
          asc(tasks.dueAt),
          desc(tasks.createdAt),
          asc(tasks.id),
        ),
    )
    const records = yield* Effect.forEach(rows, (row) => decodeTaskRow(row.task))
    return yield* views(records)
  })
  /** Caller-chosen ids replay visible records; an occupied inaccessible id reveals no record content. */
  const replay = Effect.fn('TaskStore.replay')(function* (actor: Actor, id: TaskId) {
    const existing = yield* database.run(
      database.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, id)).limit(1),
    )
    if (existing.length === 0) return Option.none<StoredTask>()
    const task = yield* record(actor, id).pipe(
      Effect.catchTag('NotFound', () =>
        Effect.fail(new Conflict({ message: 'Task id is already in use' })),
      ),
    )
    return Option.some(task)
  })
  return { view, record, get, list, replay }
}

/** Task notices always return to its creator, with assignment notices sent to the new Member too. */
const notifyAssignment = Effect.fn('Tasks.notifyAssignment')(function* (
  notifier: Notifier['Service'],
  row: StoredTask,
  assignedBy: Actor,
) {
  if (row.assigneePersonId === null || row.assigneePersonId === assignedBy.person.id) return
  yield* notifier.notify({
    personId: row.assigneePersonId,
    companyId: row.companyId,
    kind: 'assigned',
    title: row.title,
    body: 'A Task was assigned to you.',
    taskId: row.id,
    threadId: row.conversationId,
  })
})

/** Validate Thread access and workspace before creating a Task; manual work gets its own private Thread. */
const reportingThread = Effect.fn('Tasks.reportingThread')(function* (
  actor: Actor,
  request: CreateTaskRequest,
  id: TaskId,
  threadStore: ThreadStore['Service'],
) {
  const supplied = request.threadId === undefined ? actor.threadId : Option.some(request.threadId)
  if (Option.isSome(supplied)) {
    const thread = yield* requireThread(supplied.value, actor.person.id)
    if (thread.companyId !== companyColumnOf(actor.workspace))
      return yield* Effect.fail(new NotFound({ message: 'Thread not found' }))
    return { threadId: supplied.value, manual: false }
  }
  const threadId = ThreadId.make(`task-${id}`)
  yield* threadStore.ensure({
    id: threadId,
    title: request.title,
    personId: actor.person.id,
    companyId: companyColumnOf(actor.workspace),
  })
  return { threadId, manual: true }
})

/** Creation owns validating inputs and committing the Task with its initial schedule atomically. */
const makeCreate = (
  database: Database['Service'],
  notifier: Notifier['Service'],
  threadStore: ThreadStore['Service'],
  replay: ReturnType<typeof makeReads>['replay'],
) => {
  /** Ownership, attribution and assignment are validated before the Task becomes visible. */
  return Effect.fn('TaskStore.create')(function* (actor: Actor, request: CreateTaskRequest) {
    const id = request.id === undefined ? TaskId.make(crypto.randomUUID()) : request.id
    if (request.id !== undefined) {
      const existing = yield* replay(actor, id)
      if (Option.isSome(existing)) return existing.value
    }
    const assigned = yield* assignment(
      actor,
      request.assignee === undefined ? AssigneeInput.cases.Nobody.make({}) : request.assignee,
    ).pipe(Effect.provideService(Database, database))
    const dueAt =
      request.dueAt === undefined || request.dueAt === null ? null : yield* timestamp(request.dueAt)
    const scheduled =
      request.followUp === undefined
        ? Option.none()
        : Option.some(yield* scheduleInput(request.followUp))
    const report = yield* reportingThread(actor, request, id, threadStore).pipe(
      Effect.provideService(Database, database),
    )
    const origin = originOf(report.threadId, report.manual)
    const originId = originColumn(origin)
    const now = yield* Clock.currentTimeMillis
    const rows = yield* database.transaction((tx) =>
      Effect.gen(function* () {
        const inserted = yield* tx
          .insert(tasks)
          .values({
            id,
            title: request.title,
            detail: request.detail === undefined ? '' : request.detail,
            status: 'open',
            priority: request.priority === undefined ? 'normal' : request.priority,
            assignee: assigned.assignee,
            assigneePersonId: assigned.assigneePersonId,
            dueAt,
            personId: actor.person.id,
            companyId: companyColumnOf(actor.workspace),
            createdBy: actor.by,
            conversationId: report.threadId,
            originKind: origin.kind,
            originId,
            createdAt: now,
            updatedAt: now,
            overdueNotifiedAt: null,
            completedAt: null,
          })
          .onConflictDoNothing({ target: tasks.id })
          .returning()
        if (inserted.length === 0) return inserted
        if (Option.isSome(scheduled))
          yield* tx.insert(followUps).values({
            id: scheduled.value.id,
            taskId: id,
            at: scheduled.value.at,
            note: scheduled.value.note,
            repeatEveryMs: scheduled.value.repeatEveryMs,
            createdBy: storedFollowUpAuthor(actor),
            createdAt: now,
            status: 'scheduled',
            submissionId: null,
            firedAt: null,
            output: null,
            error: null,
          })
        return inserted
      }),
    )
    if (rows.length === 0) {
      const existing = yield* replay(actor, id)
      if (Option.isNone(existing))
        return yield* Effect.fail(new Conflict({ message: 'Task id is already in use' }))
      return existing.value
    }
    const row = yield* decodeTaskRow(yield* returned(rows, 'Task'))
    yield* notifier.notify({
      personId: row.personId,
      companyId: row.companyId,
      kind: 'tracked',
      title: row.title,
      body: 'Vivid is tracking this Task.',
      taskId: row.id,
      threadId: row.conversationId,
    })
    yield* notifyAssignment(notifier, row, actor)
    return row
  })
}

/** Mutation defaults describe actual new Task state; patches preserve absence rather than inventing values. */
const makeMutations = (
  database: Database['Service'],
  reads: ReturnType<typeof makeReads>,
  notifier: Notifier['Service'],
  threadStore: ThreadStore['Service'],
) => {
  const create = makeCreate(database, notifier, threadStore, reads.replay)
  /** Anybody who sees a Task can patch it, but assignment still requires a workspace Member. */
  const patch = Effect.fn('TaskStore.patch')(function* (
    actor: Actor,
    id: TaskId,
    input: PatchTaskRequest,
  ) {
    const current = yield* reads.record(actor, id)
    const assigned =
      input.assignee === undefined
        ? { assignee: current.assignee, assigneePersonId: current.assigneePersonId }
        : yield* assignment(actor, input.assignee).pipe(Effect.provideService(Database, database))
    const dueAt =
      input.dueAt === undefined
        ? current.dueAt
        : input.dueAt === null
          ? null
          : yield* timestamp(input.dueAt)
    const now = yield* Clock.currentTimeMillis
    const status = input.status === undefined ? current.status : input.status
    const completedAt =
      status === 'done' ? (current.completedAt === null ? now : current.completedAt) : null
    const rows = yield* database.transaction((tx) =>
      Effect.gen(function* () {
        const updated = yield* tx
          .update(tasks)
          .set({
            title: input.title === undefined ? current.title : input.title,
            detail: input.detail === undefined ? current.detail : input.detail,
            assignee: assigned.assignee,
            assigneePersonId: assigned.assigneePersonId,
            dueAt,
            status,
            completedAt,
            updatedAt: now,
            priority: input.priority === undefined ? current.priority : input.priority,
            overdueNotifiedAt: input.dueAt === undefined ? current.overdueNotifiedAt : null,
          })
          .where(and(eq(tasks.id, id), inArray(tasks.id, visibleIds(database, actor))))
          .returning()
        if (updated.length === 0) return updated
        if (status !== 'open')
          yield* tx
            .update(followUps)
            .set({ status: 'cancelled' })
            .where(and(eq(followUps.taskId, id), eq(followUps.status, 'scheduled')))
        return updated
      }),
    )
    const result = rows[0]
    if (result === undefined) return yield* Effect.fail(new NotFound({ message: 'Task not found' }))
    const row = yield* decodeTaskRow(result)
    if (row.assigneePersonId !== current.assigneePersonId)
      yield* notifyAssignment(notifier, row, actor)
    return yield* reads.view(row)
  })
  /** Thread readers may edit, but only the creator or current Member assignee may delete. */
  const remove = Effect.fn('TaskStore.remove')(function* (actor: Actor, id: TaskId) {
    const rows = yield* database.run(
      database
        .delete(tasks)
        .where(
          and(
            eq(tasks.id, id),
            inArray(tasks.id, visibleIds(database, actor)),
            or(eq(tasks.personId, actor.person.id), eq(tasks.assigneePersonId, actor.person.id)),
          ),
        )
        .returning({ id: tasks.id }),
    )
    if (rows.length === 0) return yield* Effect.fail(new NotFound({ message: 'Task not found' }))
    return yield* Effect.void
  })
  return { create, patch, remove }
}

/** Follow-up reads resolve their parent Task's workspace policy before projection. */
const makeFollowUpReads = (database: Database['Service']) => {
  /** Resolves ids through the visible Task subquery rather than exposing a global follow-up lookup. */
  const record = Effect.fn('TaskStore.followUpRecord')(function* (actor: Actor, id: FollowUpId) {
    const rows = yield* database.run(
      database
        .select({ followUp: followUps, task: tasks })
        .from(followUps)
        .innerJoin(tasks, eq(followUps.taskId, tasks.id))
        .where(and(eq(followUps.id, id), inArray(tasks.id, visibleIds(database, actor))))
        .limit(1),
    )
    const row = rows[0]
    if (row === undefined)
      return yield* Effect.fail(new NotFound({ message: 'Follow-up not found' }))
    return { task: yield* decodeTaskRow(row.task), followUp: row.followUp }
  })
  /** Follow-up attribution is decoded from its own persisted author. */
  const getFollowUp = Effect.fn('TaskStore.getFollowUp')(function* (actor: Actor, id: FollowUpId) {
    const row = yield* record(actor, id)
    return yield* projectFollowUp(row.followUp).pipe(Effect.provideService(Database, database))
  })
  /** A replay returns the existing visible follow-up even after the Task has closed. */
  const replay = Effect.fn('TaskStore.replayFollowUp')(function* (actor: Actor, id: FollowUpId) {
    const existing = yield* database.run(
      database.select({ id: followUps.id }).from(followUps).where(eq(followUps.id, id)).limit(1),
    )
    if (existing.length === 0) return Option.none<FollowUp>()
    const followUp = yield* getFollowUp(actor, id).pipe(
      Effect.catchTag('NotFound', () =>
        Effect.fail(new Conflict({ message: 'Follow-up id is already in use' })),
      ),
    )
    return Option.some(followUp)
  })
  return { record, getFollowUp, replay }
}

/** Schedule edits own the reset decision; read and mutation use the same Task visibility rule. */
const makePatchFollowUp = (
  database: Database['Service'],
  record: ReturnType<typeof makeFollowUpReads>['record'],
) => {
  /** Rescheduling clears the previous receipt; an already running delivery cannot be rewritten underneath it. */
  return Effect.fn('TaskStore.patchFollowUp')(function* (
    actor: Actor,
    id: FollowUpId,
    patch: typeof PatchFollowUpRequest.Type,
  ) {
    const current = yield* record(actor, id)
    if (current.followUp.status === 'running' && patch.status !== 'cancelled')
      return yield* Effect.fail(
        new InvalidRequest({ message: 'A running follow-up cannot be rescheduled' }),
      )
    const status = patch.status === undefined ? current.followUp.status : patch.status
    const rerun = status === 'scheduled' && current.followUp.status !== 'scheduled'
    const normalized = yield* scheduleInput({
      id,
      at: patch.at === undefined ? current.followUp.at : patch.at,
      note: patch.note === undefined ? current.followUp.note : patch.note,
      repeatEveryMs:
        patch.repeatEveryMs === undefined ? current.followUp.repeatEveryMs : patch.repeatEveryMs,
    })
    const rows = yield* database.run(
      database
        .update(followUps)
        .set({
          ...normalized,
          status,
          submissionId: rerun ? null : current.followUp.submissionId,
          firedAt: rerun ? null : current.followUp.firedAt,
          output: rerun ? null : current.followUp.output,
          error: rerun ? null : current.followUp.error,
        })
        .where(
          and(
            eq(followUps.id, id),
            inArray(followUps.taskId, visibleIds(database, actor)),
            eq(followUps.status, current.followUp.status),
          ),
        )
        .returning(),
    )
    return yield* projectFollowUp(yield* returned(rows, 'follow-up')).pipe(
      Effect.provideService(Database, database),
    )
  })
}

/** Follow-up access is inherited from its Task and enforced before projecting any row. */
const makeScheduling = (
  database: Database['Service'],
  reads: ReturnType<typeof makeReads>,
  changes: Changes['Service'],
) => {
  const { record, getFollowUp, replay } = makeFollowUpReads(database)
  /** Only a visible open Task may acquire a follow-up. */
  const addFollowUp = Effect.fn('TaskStore.addFollowUp')(function* (
    actor: Actor,
    taskId: TaskId,
    input: FollowUpInput,
  ) {
    if (input.id !== undefined) {
      const existing = yield* replay(actor, input.id)
      if (Option.isSome(existing)) return existing.value
    }
    const task = yield* reads.record(actor, taskId)
    if (task.status !== 'open')
      return yield* Effect.fail(new InvalidRequest({ message: 'Follow-ups need an open Task' }))
    const normalized = yield* scheduleInput(input)
    const now = yield* Clock.currentTimeMillis
    const rows = yield* database.run(
      database
        .insert(followUps)
        .values({
          ...normalized,
          taskId,
          createdBy: storedFollowUpAuthor(actor),
          createdAt: now,
          status: 'scheduled',
          submissionId: null,
          firedAt: null,
          output: null,
          error: null,
        })
        .onConflictDoNothing({ target: followUps.id })
        .returning(),
    )
    if (rows.length === 0) {
      const existing = yield* replay(actor, normalized.id)
      if (Option.isNone(existing))
        return yield* Effect.fail(new Conflict({ message: 'Follow-up id is already in use' }))
      return existing.value
    }
    return yield* projectFollowUp(yield* returned(rows, 'follow-up')).pipe(
      Effect.provideService(Database, database),
    )
  })
  const patchFollowUp = makePatchFollowUp(database, record)
  /** Deletion uses the Task's visibility condition in the mutation itself. */
  const removeFollowUp = Effect.fn('TaskStore.removeFollowUp')(function* (
    actor: Actor,
    id: FollowUpId,
  ) {
    const rows = yield* database.run(
      database
        .delete(followUps)
        .where(and(eq(followUps.id, id), inArray(followUps.taskId, visibleIds(database, actor))))
        .returning({ id: followUps.id }),
    )
    if (rows.length === 0)
      return yield* Effect.fail(new NotFound({ message: 'Follow-up not found' }))
    return yield* Effect.void
  })
  /** A duplicate claim reuses the stored timestamp, so Conversation receives the same idempotency key. */
  const claimFollowUp = Effect.fn('TaskStore.claimFollowUp')(function* (
    actor: Actor,
    id: FollowUpId,
  ) {
    const now = yield* Clock.currentTimeMillis
    const row = yield* database.transaction((tx) =>
      Effect.gen(function* () {
        const records = yield* tx
          .select({ task: tasks, followUp: followUps })
          .from(tasks)
          .innerJoin(followUps, eq(followUps.taskId, tasks.id))
          .where(and(eq(followUps.id, id), inArray(tasks.id, visibleIds(database, actor))))
          .for('update', { of: [tasks, followUps] })
        const current = records[0]
        if (current === undefined)
          return yield* Effect.fail(new NotFound({ message: 'Follow-up not found' }))
        if (current.task.status !== 'open') {
          const cancelled = yield* tx
            .update(followUps)
            .set({ status: 'cancelled' })
            .where(
              and(
                eq(followUps.id, id),
                inArray(followUps.status, ['scheduled', 'running']),
                isNull(followUps.submissionId),
              ),
            )
            .returning()
          const followUp = cancelled[0]
          return {
            task: current.task,
            followUp: followUp === undefined ? current.followUp : followUp,
          }
        }
        const claimed = yield* tx
          .update(followUps)
          .set({ status: 'running', firedAt: now, error: null })
          .where(and(eq(followUps.id, id), eq(followUps.status, 'scheduled')))
          .returning()
        const followUp = claimed[0]
        return {
          task: current.task,
          followUp: followUp === undefined ? current.followUp : followUp,
        }
      }),
    )
    const task = yield* decodeTaskRow(row.task)
    yield* publishTask(changes, task)
    return {
      task,
      followUp: yield* projectFollowUp(row.followUp).pipe(
        Effect.provideService(Database, database),
      ),
    }
  })
  return { getFollowUp, addFollowUp, patchFollowUp, removeFollowUp, claimFollowUp }
}

interface DeliveryColumns {
  readonly submissionId: string | null
  readonly status: 'fired' | 'failed'
  readonly error: string | null
}

/** Overdue notification claims are separate from delivery receipts and use their own conditional write. */
const makeClaimOverdue = (database: Database['Service'], changes: Changes['Service']) => {
  /** Marks open Tasks overdue exactly once per due-date revision and publishes their owners. */
  return Effect.fn('TaskStore.claimOverdue')(function* () {
    const now = yield* Clock.currentTimeMillis
    const rows = yield* database.run(
      database
        .update(tasks)
        .set({ overdueNotifiedAt: now })
        .where(
          sql`${tasks.status} = 'open' AND ${tasks.dueAt} <= ${now} AND ${tasks.overdueNotifiedAt} IS NULL`,
        )
        .returning(),
    )
    return yield* Effect.forEach(
      rows,
      Effect.fn('Tasks.projectOverdue')(function* (row) {
        const task = yield* decodeTaskRow(row)
        yield* publishTask(changes, task)
        return task
      }),
    )
  })
}

/** Receipt and recurrence state commit together; conditional writes suppress duplicate deliveries. */
const makeFinishDelivery = (database: Database['Service'], changes: Changes['Service']) => {
  /** A receipt or delivery failure belongs to the exact claim, so stale workers cannot overwrite newer schedules. */
  return Effect.fn('TaskStore.finishDelivery')(function* (
    claim: { readonly task: StoredTask; readonly followUp: FollowUp },
    result: DeliveryOutcome,
  ) {
    const now = yield* Clock.currentTimeMillis
    const values = DeliveryOutcome.match(result, {
      Delivered: ({ runId }): DeliveryColumns => ({
        submissionId: runId,
        status: 'fired',
        error: null,
      }),
      Failed: ({ message }): DeliveryColumns => ({
        submissionId: null,
        status: 'failed',
        error: message,
      }),
    })
    const rows = yield* database.transaction((tx) =>
      Effect.gen(function* () {
        const currentTasks = yield* tx
          .select({ status: tasks.status })
          .from(tasks)
          .where(eq(tasks.id, claim.task.id))
          .for('update')
        const task = currentTasks[0]
        if (task === undefined)
          return yield* Effect.fail(new NotFound({ message: 'Task not found' }))
        const updated = yield* tx
          .update(followUps)
          .set({
            ...values,
            firedAt: DeliveryOutcome.guards.Delivered(result) ? now : claim.followUp.firedAt,
          })
          .where(
            and(
              eq(followUps.id, claim.followUp.id),
              eq(followUps.status, 'running'),
              isNull(followUps.submissionId),
              sql`${followUps.firedAt} IS NOT DISTINCT FROM ${claim.followUp.firedAt}`,
            ),
          )
          .returning()
        const row = updated[0]
        if (
          row !== undefined &&
          DeliveryOutcome.guards.Delivered(result) &&
          row.repeatEveryMs !== null &&
          task.status === 'open'
        ) {
          const next = yield* scheduleInput({
            at: row.at + row.repeatEveryMs,
            note: row.note,
            repeatEveryMs: row.repeatEveryMs,
          })
          yield* tx.insert(followUps).values({
            ...next,
            taskId: row.taskId,
            createdBy: row.createdBy,
            createdAt: now,
            status: 'scheduled',
            submissionId: null,
            firedAt: null,
            output: null,
            error: null,
          })
        }
        return updated
      }),
    )
    if (rows.length === 0) {
      const current = yield* database.run(
        database
          .select()
          .from(followUps)
          .where(and(eq(followUps.id, claim.followUp.id), eq(followUps.taskId, claim.task.id)))
          .limit(1),
      )
      const row = current[0]
      if (row === undefined)
        return yield* Effect.fail(new NotFound({ message: 'Follow-up not found' }))
      return DeliveryRecord.cases.Unchanged.make({
        followUp: yield* projectFollowUp(row).pipe(Effect.provideService(Database, database)),
      })
    }
    yield* publishTask(changes, claim.task)
    return DeliveryRecord.cases.Recorded.make({
      followUp: yield* projectFollowUp(yield* returned(rows, 'follow-up')).pipe(
        Effect.provideService(Database, database),
      ),
    })
  })
}

/** A claim is refreshed immediately before external delivery, with a closed Task cancelling it. */
const makePrepareDelivery = (database: Database['Service'], changes: Changes['Service']) => {
  /** Closure after claiming cancels the pending delivery; the recheck also rejects stale or deleted claims. */
  return Effect.fn('TaskStore.prepareDelivery')(function* (claim: {
    readonly task: StoredTask
    readonly followUp: FollowUp
  }) {
    const row = yield* database.transaction((tx) =>
      Effect.gen(function* () {
        const records = yield* tx
          .select({ task: tasks, followUp: followUps })
          .from(tasks)
          .innerJoin(followUps, eq(followUps.taskId, tasks.id))
          .where(and(eq(tasks.id, claim.task.id), eq(followUps.id, claim.followUp.id)))
          .for('update', { of: [tasks, followUps] })
        const current = records[0]
        if (current === undefined)
          return yield* Effect.fail(new NotFound({ message: 'Follow-up not found' }))
        if (
          current.task.status === 'open' ||
          current.followUp.status !== 'running' ||
          current.followUp.submissionId !== null
        )
          return current
        const cancelled = yield* tx
          .update(followUps)
          .set({ status: 'cancelled' })
          .where(eq(followUps.id, claim.followUp.id))
          .returning()
        return { task: current.task, followUp: yield* returned(cancelled, 'cancelled follow-up') }
      }),
    )
    const task = yield* decodeTaskRow(row.task)
    if (row.followUp.status === 'cancelled') yield* publishTask(changes, task)
    return {
      task,
      followUp: yield* projectFollowUp(row.followUp).pipe(
        Effect.provideService(Database, database),
      ),
    }
  })
}

/** The scheduler has global authority only over due rows selected and locked by PostgreSQL. */
const makeBackground = (database: Database['Service'], changes: Changes['Service']) => {
  /** SKIP LOCKED claims new rows; unsubmitted running rows are replayed after ten minutes.
   * Preserve firedAt on recovery: changing it would create a new delivery rather than recover one.
   */
  const claimDueFollowUps = Effect.fn('TaskStore.claimDueFollowUps')(function* () {
    const now = yield* Clock.currentTimeMillis
    /** Only a new claim changes replay identity; recovered rows keep the durable original timestamp. */
    const claimRow = (row: {
      readonly task: typeof tasks.$inferSelect
      readonly followUp: typeof followUps.$inferSelect
    }) => {
      if (row.followUp.status === 'running') return row
      return {
        task: row.task,
        followUp: { ...row.followUp, status: 'running', firedAt: now, error: null },
      }
    }
    const claimId = (row: { readonly followUp: typeof followUps.$inferSelect }) => row.followUp.id
    const rows = yield* database.transaction((tx) =>
      Effect.gen(function* () {
        const due = yield* tx
          .select({ followUp: followUps, task: tasks })
          .from(tasks)
          .innerJoin(followUps, eq(followUps.taskId, tasks.id))
          .where(
            and(
              eq(tasks.status, 'open'),
              or(
                and(eq(followUps.status, 'scheduled'), lte(followUps.at, now)),
                and(
                  eq(followUps.status, 'running'),
                  isNull(followUps.submissionId),
                  lt(followUps.firedAt, now - FOLLOW_UP_ABANDONED_MS),
                ),
              ),
            ),
          )
          .orderBy(followUps.at)
          .for('update', { skipLocked: true, of: [tasks, followUps] })
        if (due.length === 0) return []
        yield* tx
          .update(followUps)
          .set({ status: 'running', firedAt: now, error: null })
          .where(and(inArray(followUps.id, due.map(claimId)), eq(followUps.status, 'scheduled')))
        return due.map(claimRow)
      }),
    )
    const claimed = yield* Effect.forEach(
      rows,
      Effect.fn('Tasks.projectClaim')(function* (row) {
        const task = yield* decodeTaskRow(row.task)
        yield* publishTask(changes, task)
        return {
          task,
          followUp: yield* projectFollowUp(row.followUp).pipe(
            Effect.provideService(Database, database),
          ),
        }
      }),
    )
    return claimed
  })
  const finishDelivery = makeFinishDelivery(database, changes)
  const prepareDelivery = makePrepareDelivery(database, changes)
  const claimOverdue = makeClaimOverdue(database, changes)
  return { claimDueFollowUps, finishDelivery, prepareDelivery, claimOverdue }
}

/** One persistence authority shares access policy and projection across RPC, search and scheduling. */
const makeStore = (
  database: Database['Service'],
  changes: Changes['Service'],
  notifier: Notifier['Service'],
  threadStore: ThreadStore['Service'],
) => {
  const reads = makeReads(database)
  const writes = makeMutations(database, reads, notifier, threadStore)
  const scheduling = makeScheduling(database, reads, changes)
  const background = makeBackground(database, changes)
  /** Project the committed Task and its atomically inserted initial follow-up. */
  const create = Effect.fn('TaskStore.create')(function* (
    actor: Actor,
    request: CreateTaskRequest,
  ) {
    const row = yield* writes.create(actor, request)
    return yield* reads.view(row)
  })
  return {
    list: reads.list,
    get: reads.get,
    create,
    patch: writes.patch,
    remove: writes.remove,
    ...scheduling,
    ...background,
  }
}

export class TaskStore extends Context.Service<TaskStore, ReturnType<typeof makeStore>>()(
  'vivid/TaskStore',
) {}

/** Dependencies are captured once; ThreadStore is retained by creation's reporting-Thread operation. */
export const taskStoreLayer = Layer.effect(
  TaskStore,
  Effect.gen(function* () {
    return TaskStore.of(
      makeStore(yield* Database, yield* Changes, yield* Notifier, yield* ThreadStore),
    )
  }),
)
