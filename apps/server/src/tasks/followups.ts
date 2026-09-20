import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schedule from 'effect/Schedule'
import { Thread as ThreadSchema, type FollowUp, type FollowUpId, type Task, type TaskId } from '@vivid/contracts'
import { RuntimeUnavailable } from '@vivid/contracts/rpc'
import type { DatabaseInfrastructureError } from '../database/client.ts'
import { Runtime } from '../runtime/client.ts'
import { ThreadStore } from '../threads/store.ts'
import { TaskStore } from './store.ts'

export const FOLLOW_UP_TICK_MS = 20_000

const instruction = (task: Task, followUp: FollowUp) => [
  `A follow-up you scheduled is due for the task "${task.title}".`,
  task.detail.length > 0 ? `Detail: ${task.detail}` : undefined,
  `Waiting on: ${task.assignee ?? 'the user (this is their own task)'}.`,
  followUp.note.length > 0 ? `Follow-up note: ${followUp.note}` : undefined,
  'Act on it now. Do not claim you contacted anyone yourself.',
].filter((line): line is string => line !== undefined).join('\n')

export interface FollowUpsService {
  readonly run: (id: FollowUpId) => Effect.Effect<FollowUp | undefined, DatabaseInfrastructureError | RuntimeUnavailable>
  readonly nudge: (taskId: TaskId, note: string) => Effect.Effect<FollowUp | undefined, DatabaseInfrastructureError | RuntimeUnavailable>
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
      const claimed = followUp.status === 'running' ? followUp : yield* tasks.claimFollowUp(followUp.id)
      if (claimed === undefined || claimed.status !== 'running') return claimed
      yield* threads.put(ThreadSchema.make({
        id: task.conversationId,
        title: task.title,
        preview: `Following up: ${task.title}`,
        updatedAt: claimed.firedAt ?? claimed.at,
        archived: false,
      }))
      if (claimed.submissionId !== null) return claimed
      const receipt = yield* runtime.start({
        threadId: task.conversationId,
        idempotencyKey: `${claimed.id}:${claimed.firedAt ?? claimed.at}`,
        type: 'follow-up',
        body: instruction(task, claimed),
        attributes: {
          taskId: task.id,
          taskTitle: task.title,
          followUpId: claimed.id,
          scheduledAt: new Date(claimed.at).toISOString(),
        },
      })
      yield* tasks.attachSubmission(claimed.id, receipt.submissionId)
      return yield* tasks.getFollowUp(claimed.id)
    })

    const run = Effect.fn('FollowUps.run')(function* (id: FollowUpId) {
      let followUp = yield* tasks.getFollowUp(id)
      if (followUp === undefined) return undefined
      const task = yield* tasks.get(followUp.taskId)
      if (task === undefined || task.status !== 'open') return followUp
      if (followUp.status !== 'scheduled' && followUp.status !== 'running') {
        followUp = yield* tasks.patchFollowUp(id, { status: 'scheduled' })
        if (followUp === undefined) return undefined
      }
      return yield* submit(task, followUp)
    })

    const nudge = Effect.fn('FollowUps.nudge')(function* (taskId: TaskId, note: string) {
      const task = yield* tasks.get(taskId)
      if (task === undefined || task.status !== 'open') return undefined
      const followUp = yield* tasks.addFollowUp(task.id, { at: Date.now(), note }, 'you')
      return yield* submit(task, followUp)
    })

    const runDue = Effect.fn('FollowUps.runDue')(function* () {
      const due = yield* tasks.claimDueFollowUps()
      yield* Effect.forEach(due, (followUp) =>
        tasks.get(followUp.taskId).pipe(
          Effect.flatMap((task) => task === undefined || task.status !== 'open' ? Effect.void : Effect.asVoid(submit(task, followUp))),
        ), { discard: true, concurrency: 1 })
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
