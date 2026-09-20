import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schedule from 'effect/Schedule'
import {
  Thread as ThreadSchema,
  type FollowUp,
  type FollowUpId,
  type Task,
  type TaskId,
} from '@vivid/contracts'
import { RuntimeUnavailable } from '@vivid/contracts/rpc'
import type { DatabaseInfrastructureError } from '../database/client.ts'
import { Runtime } from '../runtime/client.ts'
import { ThreadStore } from '../threads/store.ts'
import { TaskStore } from './store.ts'

export const FOLLOW_UP_TICK_MS = 20_000

/** Builds the model instruction without introducing absent lines into its string collection. */
const instruction = (task: Task, followUp: FollowUp) => {
  const lines = [`A follow-up you scheduled is due for the task "${task.title}".`]
  if (task.detail.length > 0) lines.push(`Detail: ${task.detail}`)
  lines.push(`Waiting on: ${task.assignee ?? 'the user (this is their own task)'}.`)
  if (followUp.note.length > 0) lines.push(`Follow-up note: ${followUp.note}`)
  lines.push('Act on it now. Do not claim you contacted anyone yourself.')
  return lines.join('\n')
}

export interface FollowUpsService {
  readonly run: (
    id: FollowUpId,
  ) => Effect.Effect<Option.Option<FollowUp>, DatabaseInfrastructureError | RuntimeUnavailable>
  readonly nudge: (
    taskId: TaskId,
    note: string,
  ) => Effect.Effect<Option.Option<FollowUp>, DatabaseInfrastructureError | RuntimeUnavailable>
  readonly runDue: () => Effect.Effect<void, DatabaseInfrastructureError | RuntimeUnavailable>
}

export class FollowUps extends Context.Service<FollowUps, FollowUpsService>()('vivid/FollowUps') {}

export const followUpsLayer = Layer.effect(
  FollowUps,
  Effect.gen(function* () {
    const tasks = yield* TaskStore
    const threads = yield* ThreadStore
    const runtime = yield* Runtime

    const submit = Effect.fn('FollowUps.submit')(function* (task: Task, followUp: FollowUp) {
      const claimed =
        followUp.status === 'running'
          ? Option.some(followUp)
          : yield* tasks.claimFollowUp(followUp.id)
      if (Option.isNone(claimed)) return Option.none<FollowUp>()
      const claimedFollowUp = claimed.value
      if (claimedFollowUp.status !== 'running') return claimed
      yield* threads.put(
        ThreadSchema.make({
          id: task.conversationId,
          title: task.title,
          preview: `Following up: ${task.title}`,
          updatedAt: claimedFollowUp.firedAt ?? claimedFollowUp.at,
          archived: false,
        }),
      )
      if (claimedFollowUp.submissionId !== null) return claimed
      const receipt = yield* runtime.start({
        threadId: task.conversationId,
        idempotencyKey: `${claimedFollowUp.id}:${claimedFollowUp.firedAt ?? claimedFollowUp.at}`,
        type: 'follow-up',
        body: instruction(task, claimedFollowUp),
        attributes: {
          taskId: task.id,
          taskTitle: task.title,
          followUpId: claimedFollowUp.id,
          scheduledAt: new Date(claimedFollowUp.at).toISOString(),
        },
      })
      yield* tasks.attachSubmission(claimedFollowUp.id, receipt.submissionId)
      return yield* tasks.getFollowUp(claimedFollowUp.id)
    })

    const run = Effect.fn('FollowUps.run')(function* (id: FollowUpId) {
      const existing = yield* tasks.getFollowUp(id)
      if (Option.isNone(existing)) return Option.none<FollowUp>()
      const task = yield* tasks.get(existing.value.taskId)
      if (Option.isNone(task) || task.value.status !== 'open') return existing
      const scheduled =
        existing.value.status === 'scheduled' || existing.value.status === 'running'
          ? existing
          : yield* tasks.patchFollowUp(id, { status: 'scheduled' })
      if (Option.isNone(scheduled)) return Option.none<FollowUp>()
      return yield* submit(task.value, scheduled.value)
    })

    const nudge = Effect.fn('FollowUps.nudge')(function* (taskId: TaskId, note: string) {
      const task = yield* tasks.get(taskId)
      if (Option.isNone(task) || task.value.status !== 'open') return Option.none<FollowUp>()
      const followUp = yield* tasks.addFollowUp(task.value.id, { at: Date.now(), note }, 'you')
      return yield* submit(task.value, followUp)
    })

    /** Processes one claimed row so the scheduler's collection traversal stays flat. */
    const runDueFollowUp = Effect.fn('FollowUps.runDueFollowUp')(function* (followUp: FollowUp) {
      const task = yield* tasks.get(followUp.taskId)
      if (Option.isNone(task) || task.value.status !== 'open') return yield* Effect.void
      yield* submit(task.value, followUp)
      return yield* Effect.void
    })

    const runDue = Effect.fn('FollowUps.runDue')(function* () {
      const due = yield* tasks.claimDueFollowUps()
      yield* Effect.forEach(due, runDueFollowUp, { discard: true, concurrency: 1 })
    })

    return FollowUps.of({ run, nudge, runDue })
  }),
)

/** Owns the interruptible polling fiber; `TestClock` drives its Schedule in tests. */
export const followUpSchedulerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const followUps = yield* FollowUps
    const pass = followUps.runDue().pipe(
      Effect.tapError((error) => Effect.logError('Follow-up scheduler pass failed', error)),
      Effect.ignore,
    )
    yield* pass.pipe(
      Effect.repeat(Schedule.spaced(`${FOLLOW_UP_TICK_MS} millis`)),
      Effect.forkScoped,
    )
  }),
)
