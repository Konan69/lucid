import { init } from '@flue/runtime'
import { Effect, Schema } from 'effect'
import { Vivid } from './agents/vivid.ts'
import {
  attachFollowUpSubmission,
  completeFollowUp,
  createFollowUp,
  createNotification,
  dueFollowUps,
  failFollowUp,
  getFollowUp,
  getTask,
  hasFollowUpCovering,
  listRunningFollowUps,
  markTaskOverdueNotified,
  overdueTasks,
  startFollowUp,
  updateFollowUp,
  type FollowUp,
  type Task,
} from './task-store.ts'
import { upsertConversation } from './thread-store.ts'

export const FOLLOW_UP_TICK_MS = 20_000
const OVERDUE_GRACE_MS = 60 * 60 * 1000
type FollowUpSignalAttributes = {
  taskId: string
  taskTitle: string
  followUpId: string
  assignee: string
  dueAt?: string
  scheduledAt: string
}

/** A persistence adapter rejected a follow-up scheduler operation. */
class FollowUpStoreFailure extends Schema.TaggedError<FollowUpStoreFailure>()(
  'FollowUpStoreFailure',
  {
    operation: Schema.String,
    message: Schema.String,
  },
  { title: 'Follow-up store failure' },
) {}

/** Flue could not dispatch or read a scheduled follow-up. */
class FollowUpExecutionFailure extends Schema.TaggedError<FollowUpExecutionFailure>()(
  'FollowUpExecutionFailure',
  {
    operation: Schema.String,
    message: Schema.String,
  },
  { title: 'Follow-up execution failure' },
) {}

const inFlight = new Set<string>()

/** Lifts the legacy Promise store seam into the scheduler's typed failure channel. */
const storeOperation = <Value>(operation: string, evaluate: () => Promise<Value>) =>
  Effect.tryPromise(evaluate).pipe(
    Effect.mapError((error) => new FollowUpStoreFailure({ operation, message: error.message })),
  )

/** Lifts one Flue Promise into a distinct execution failure. */
const executionOperation = <Value>(operation: string, evaluate: () => Promise<Value>) =>
  Effect.tryPromise(evaluate).pipe(
    Effect.mapError((error) => new FollowUpExecutionFailure({ operation, message: error.message })),
  )

/** Produces the stable instruction sent for one due follow-up. */
function followUpInstruction(task: Task, followUp: FollowUp): string {
  const due = task.dueAt === null ? 'no due date' : new Date(task.dueAt).toISOString()
  return [
    `A follow-up you scheduled is due for the task "${task.title}".`,
    task.detail.length > 0 ? `Detail: ${task.detail}` : null,
    `Waiting on: ${task.assignee ?? 'the user (this is their own task)'}.`,
    `Due: ${due}. Priority: ${task.priority}.`,
    followUp.note.length > 0 ? `Your note for this follow-up: ${followUp.note}` : null,
    'Act on it now, in under 120 words:',
    '1. Say in one line what is outstanding.',
    '2. If the task waits on someone else, write the exact short, friendly nudge the user can send them.',
    "3. If the task is the user's own, remind them and propose the single next step.",
    '4. If the task is clearly finished, call update_task with status "done" and say so.',
    'You cannot contact anyone yourself; do not claim that you did.',
  ]
    .filter((line) => line !== null)
    .join('\n')
}

/** Calculates the next cadence without replaying missed historical occurrences. */
function nextOnCadence(anchor: number, everyMs: number, now: number): number {
  return anchor + (Math.max(0, Math.floor((now - anchor) / everyMs)) + 1) * everyMs
}

/** Persists one typed execution failure and its user-visible notification. */
const recordFollowUpFailure = Effect.fn('FollowUpScheduler.recordFailure')(function* (
  task: Task,
  followUp: FollowUp,
  failure: FollowUpStoreFailure | FollowUpExecutionFailure,
) {
  const message = failure.message.slice(0, 1000)
  const failed = yield* storeOperation('fail follow-up', () => failFollowUp(followUp.id, message))
  if (!failed) return
  yield* storeOperation('create failure notification', () =>
    createNotification({
      kind: 'follow-up-failed',
      title: `Could not follow up: ${task.title}`,
      body: message,
      taskId: task.id,
      conversationId: task.conversationId,
    }),
  )
})

/** Executes one claimed occurrence; the database compare-and-set preserves idempotency. */
const executeClaimedFollowUp = Effect.fn('FollowUpScheduler.executeClaimed')(function* (
  task: Task,
  initialFollowUp: FollowUp,
) {
  let followUp = initialFollowUp
  if (followUp.status === 'scheduled') {
    const started = yield* storeOperation('start follow-up', () =>
      startFollowUp(followUp.id, Date.now()),
    )
    if (!started) return
    const refreshed = yield* storeOperation('reload follow-up', () => getFollowUp(followUp.id))
    if (refreshed !== null) followUp = refreshed
  } else if (followUp.status !== 'running') {
    return
  }

  const firedAt = followUp.firedAt ?? Date.now()
  yield* storeOperation('upsert follow-up conversation', () =>
    upsertConversation({
      archived: false,
      id: task.conversationId,
      title: task.title,
      preview: `Following up: ${task.title}`,
      updatedAt: firedAt,
    }),
  )

  const agent = init(Vivid, { id: task.conversationId })
  let submissionId = followUp.submissionId
  if (submissionId === null) {
    const attributes: FollowUpSignalAttributes = {
      taskId: task.id,
      taskTitle: task.title,
      followUpId: followUp.id,
      assignee: task.assignee ?? 'you',
      scheduledAt: new Date(followUp.at).toISOString(),
    }
    if (task.dueAt !== null) attributes.dueAt = new Date(task.dueAt).toISOString()
    const receipt = yield* executionOperation('dispatch follow-up', () =>
      agent.dispatch({
        idempotencyKey: `${followUp.id}:${firedAt}`,
        message: {
          kind: 'signal',
          type: 'follow-up',
          body: followUpInstruction(task, followUp),
          attributes,
        },
      }),
    )
    submissionId = receipt.submissionId
    yield* storeOperation('attach follow-up submission', () =>
      attachFollowUpSubmission(followUp.id, receipt.submissionId),
    )
  }

  const reply = yield* executionOperation('read follow-up', () => agent.read(submissionId))
  const current = yield* storeOperation('read task after follow-up', () => getTask(task.id))
  const completion: Parameters<typeof completeFollowUp>[1] = {
    output: reply.text,
    notification: {
      kind: 'follow-up',
      title:
        task.assignee === null
          ? `Followed up: ${task.title}`
          : `Chased ${task.assignee}: ${task.title}`,
      body: reply.text,
      taskId: task.id,
      conversationId: task.conversationId,
    },
  }
  if (followUp.repeatEveryMs !== null && current !== null && current.status === 'open') {
    completion.nextFollowUp = {
      at: nextOnCadence(followUp.at, followUp.repeatEveryMs, Date.now()),
      note: followUp.note,
      repeatEveryMs: followUp.repeatEveryMs,
      createdBy: followUp.createdBy,
    }
  }
  const completed = yield* storeOperation('complete follow-up', () =>
    completeFollowUp(followUp.id, completion),
  )
  if (!completed) return
  yield* storeOperation('update follow-up conversation', () =>
    upsertConversation({
      archived: false,
      id: task.conversationId,
      title: task.title,
      preview: reply.text.slice(0, 500),
      updatedAt: Date.now(),
    }),
  )
})

/** Owns in-flight membership for the full execution and records every expected failure. */
const executeFollowUp = Effect.fn('FollowUpScheduler.execute')(function* (
  task: Task,
  followUp: FollowUp,
) {
  const acquired = yield* Effect.sync(() => {
    if (inFlight.has(followUp.id)) return false
    inFlight.add(followUp.id)
    return true
  })
  if (!acquired) return
  yield* Effect.acquireUseRelease(
    Effect.succeed(undefined),
    () =>
      executeClaimedFollowUp(task, followUp).pipe(
        Effect.catch((failure) => recordFollowUpFailure(task, followUp, failure)),
      ),
    () =>
      Effect.sync(() => {
        inFlight.delete(followUp.id)
      }),
  )
})

/** Starts or resumes one follow-up and returns its durable state immediately. */
export const runFollowUpNow = Effect.fn('FollowUpScheduler.runNow')(function* (followUpId: string) {
  const followUp = yield* storeOperation('read follow-up', () => getFollowUp(followUpId))
  const task =
    followUp === null
      ? null
      : yield* storeOperation('read follow-up task', () => getTask(followUp.taskId))
  if (followUp === null || task === null) return null
  if (followUp.status === 'running' || task.status !== 'open') return followUp
  const runnable =
    followUp.status === 'scheduled'
      ? followUp
      : yield* storeOperation('reschedule follow-up', () =>
          updateFollowUp(followUp.id, {
            at: Math.min(followUp.at, Date.now()),
            status: 'scheduled',
          }),
        )
  if (runnable === null) return null
  yield* Effect.forkDetach(executeFollowUp(task, runnable))
  return yield* storeOperation('reload scheduled follow-up', () => getFollowUp(followUpId))
})

/** Creates an immediate follow-up and starts one observed execution fiber. */
export const chaseTaskNow = Effect.fn('FollowUpScheduler.chaseTaskNow')(function* (
  task: Task,
  note: string,
  createdBy: 'you' | 'vivid',
) {
  const followUp = yield* storeOperation('create immediate follow-up', () =>
    createFollowUp({
      taskId: task.id,
      at: Date.now(),
      note,
      createdBy,
    }),
  )
  yield* Effect.forkDetach(executeFollowUp(task, followUp))
  const refreshed = yield* storeOperation('reload immediate follow-up', () =>
    getFollowUp(followUp.id),
  )
  return refreshed ?? followUp
})

/** Sweeps due follow-ups and overdue tasks without overlapping timer ticks. */
const tick = Effect.fn('FollowUpScheduler.tick')(function* () {
  const now = Date.now()
  const due = yield* storeOperation('list due follow-ups', () => dueFollowUps(now))
  for (const followUp of due) {
    const task = yield* storeOperation('read due task', () => getTask(followUp.taskId))
    if (task === null) continue
    if (task.status !== 'open') {
      yield* storeOperation('fail closed-task follow-up', () =>
        failFollowUp(followUp.id, 'Task is no longer open'),
      )
      continue
    }
    yield* Effect.forkDetach(executeFollowUp(task, followUp))
  }

  const overdue = yield* storeOperation('list overdue tasks', () => overdueTasks(now))
  for (const task of overdue) {
    yield* storeOperation('mark task overdue', () => markTaskOverdueNotified(task.id, now))
    yield* storeOperation('create overdue notification', () =>
      createNotification({
        kind: 'overdue',
        title: `Overdue: ${task.title}`,
        body:
          task.assignee === null
            ? `Was due ${new Date(task.dueAt ?? now).toLocaleDateString()}.`
            : `Waiting on ${task.assignee} since ${new Date(task.dueAt ?? now).toLocaleDateString()}.`,
        taskId: task.id,
        conversationId: task.conversationId,
      }),
    )
    const covered = yield* storeOperation('check overdue follow-up', () =>
      hasFollowUpCovering(task.id, (task.dueAt ?? now) - OVERDUE_GRACE_MS),
    )
    if (!covered) {
      yield* Effect.forkDetach(
        chaseTask(task, 'The task went past its due date without being closed.', 'vivid'),
      )
    }
  }
})

/** Effect-native form used when the scheduler calls the immediate chase path. */
const chaseTask = Effect.fn('FollowUpScheduler.chaseTask')(function* (
  task: Task,
  note: string,
  createdBy: 'you' | 'vivid',
) {
  const followUp = yield* storeOperation('create immediate follow-up', () =>
    createFollowUp({
      taskId: task.id,
      at: Date.now(),
      note,
      createdBy,
    }),
  )
  yield* Effect.forkDetach(executeFollowUp(task, followUp))
})

/** Resumes durable running occurrences after process startup. */
const recoverRunningFollowUps = Effect.fn('FollowUpScheduler.recoverRunning')(function* () {
  const running = yield* storeOperation('list running follow-ups', listRunningFollowUps)
  for (const followUp of running) {
    const task = yield* storeOperation('read recovering task', () => getTask(followUp.taskId))
    if (task === null) {
      yield* storeOperation('fail orphan follow-up', () =>
        failFollowUp(followUp.id, 'The task for this follow-up no longer exists'),
      )
      continue
    }
    yield* Effect.forkDetach(executeFollowUp(task, followUp))
  }
})

let ticking = false
const guardedTick = Effect.fn('FollowUpScheduler.guardedTick')(function* () {
  const acquired = yield* Effect.sync(() => {
    if (ticking) return false
    ticking = true
    return true
  })
  if (!acquired) return
  yield* Effect.acquireUseRelease(
    Effect.succeed(undefined),
    () => tick(),
    () =>
      Effect.sync(() => {
        ticking = false
      }),
  )
})

/** Performs startup recovery before the first guarded due-item sweep. */
export const initializeFollowUpScheduler = Effect.fn('FollowUpScheduler.initialize')(function* () {
  yield* recoverRunningFollowUps()
  yield* guardedTick()
})

/** Exposes one guarded sweep for the owning runtime timer. */
export const runFollowUpSchedulerTick = guardedTick
