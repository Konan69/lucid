import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schedule from 'effect/Schedule'
import {
  InvalidRequest,
  type FollowUp,
  type FollowUpId,
  type NudgeTaskRequest,
  type TaskId,
} from '@vivid/contracts'
import { type Actor } from '../auth/access.ts'
import { Notifier } from '../notifications/notifier.ts'
import { Conversation, DeliveryMessage, StoredRunOrigin } from '../threads/conversation.ts'
import { DeliveryOutcome, DeliveryRecord, type StoredTask } from './projection.ts'
import { TaskStore } from './store.ts'

export const FOLLOW_UP_TICK_MS = 20_000

/** Include recorded Task context and the scheduled note without inventing an absent assignee. */
const instruction = (task: StoredTask, followUp: FollowUp) => {
  const lines = [`A follow-up is due for the Task "${task.title}".`]
  if (task.detail.length > 0) lines.push(`Detail: ${task.detail}`)
  if (task.assignee !== null) lines.push(`Waiting on: ${task.assignee}.`)
  if (followUp.note.length > 0) lines.push(`Follow-up note: ${followUp.note}`)
  lines.push('Act on it now. Do not claim you contacted anyone yourself.')
  return lines.join('\n')
}

/** Delivery belongs to the stored creator even when a different Member clicks Run or Nudge. */
const makeFollowUps = (
  tasks: TaskStore['Service'],
  conversation: Conversation['Service'],
  notifier: Notifier['Service'],
) => {
  /** Run creation has exactly one authority; the claim timestamp makes retries use the same key. */
  const submit = Effect.fn('FollowUps.submit')(function* (claim: {
    readonly task: StoredTask
    readonly followUp: FollowUp
  }) {
    const { task, followUp } = claim
    if (followUp.status !== 'running' || followUp.submissionId !== null) return followUp
    if (followUp.firedAt === null)
      return yield* Effect.fail(
        new InvalidRequest({ message: 'A running follow-up needs a claim timestamp' }),
      )
    const receipt = yield* conversation
      .deliver({
        threadId: task.conversationId,
        personId: task.personId,
        message: DeliveryMessage.cases.Signal.make({
          type: 'follow-up',
          body: instruction(task, followUp),
          attributes: { task: task.id },
        }),
        origin: StoredRunOrigin.cases.FollowUp.make({ taskTitle: task.title }),
        idempotencyKey: `${followUp.id}:${followUp.firedAt}`,
      })
      .pipe(
        Effect.matchEffect({
          onFailure: Effect.fn('FollowUps.deliveryFailed')(function* (error) {
            const failed = yield* tasks.finishDelivery(
              claim,
              DeliveryOutcome.cases.Failed.make({ message: error.message }),
            )
            if (DeliveryRecord.guards.Unchanged(failed)) return failed.followUp
            yield* notifier.notify({
              personId: task.personId,
              companyId: task.companyId,
              kind: 'follow-up-failed',
              title: task.title,
              body: 'Vivid could not start this follow-up.',
              taskId: task.id,
              threadId: task.conversationId,
            })
            return failed.followUp
          }),
          onSuccess: Effect.fn('FollowUps.delivered')(function* (run) {
            const attached = yield* tasks.finishDelivery(
              claim,
              DeliveryOutcome.cases.Delivered.make({ runId: run.id }),
            )
            if (DeliveryRecord.guards.Unchanged(attached)) return attached.followUp
            yield* notifier.notify({
              personId: task.personId,
              companyId: task.companyId,
              kind: 'follow-up',
              title: task.title,
              body: 'Vivid started following up on this Task.',
              taskId: task.id,
              threadId: task.conversationId,
            })
            return attached.followUp
          }),
        }),
      )
    return receipt
  })
  /** Explicit retry reopens a settled follow-up before the atomic scheduled-to-running claim. */
  const run = Effect.fn('FollowUps.run')(function* (actor: Actor, id: FollowUpId) {
    const current = yield* tasks.getFollowUp(actor, id)
    if (current.status !== 'scheduled' && current.status !== 'running')
      yield* tasks.patchFollowUp(actor, id, { status: 'scheduled' })
    return yield* submit(yield* tasks.claimFollowUp(actor, id))
  })
  /** A nudge is an immediate follow-up using Clock and the same scoped claim/delivery path. */
  const nudge = Effect.fn('FollowUps.nudge')(function* (
    actor: Actor,
    taskId: TaskId,
    input: typeof NudgeTaskRequest.Type,
  ) {
    const now = yield* Clock.currentTimeMillis
    const followUp = yield* tasks.addFollowUp(actor, taskId, { at: now, note: input.note })
    return yield* run(actor, followUp.id)
  })
  /** Each pass reports overdue Tasks once and submits only database-claimed follow-ups. */
  const runDue = Effect.fn('FollowUps.runDue')(function* () {
    const overdue = yield* tasks.claimOverdue()
    yield* Effect.forEach(
      overdue,
      (task) =>
        notifier.notify({
          personId: task.personId,
          companyId: task.companyId,
          kind: 'overdue',
          title: task.title,
          body: 'This Task is overdue.',
          taskId: task.id,
          threadId: task.conversationId,
        }),
      { discard: true },
    )
    const due = yield* tasks.claimDueFollowUps()
    yield* Effect.forEach(due, submit, { discard: true, concurrency: 1 })
  })
  return { run, nudge, runDue }
}

export class FollowUps extends Context.Service<FollowUps, ReturnType<typeof makeFollowUps>>()(
  'vivid/FollowUps',
) {}

/** The service owns delivery sequencing; no handler or worker calls Runtime directly. */
export const followUpsLayer = Layer.effect(
  FollowUps,
  Effect.gen(function* () {
    return FollowUps.of(makeFollowUps(yield* TaskStore, yield* Conversation, yield* Notifier))
  }),
)

/** Scoped polling keeps startup nonblocking; typed pass failures are logged and retried next pass. */
export const followUpSchedulerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const followUps = yield* FollowUps
    const pass = followUps
      .runDue()
      .pipe(Effect.catch((error) => Effect.logError('Follow-up scheduler pass failed', error._tag)))
    yield* pass.pipe(
      Effect.repeat(Schedule.spaced(`${FOLLOW_UP_TICK_MS} millis`)),
      Effect.forkScoped,
    )
  }),
)
