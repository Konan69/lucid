import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import {
  defineDocFamily,
  LiveDoc,
  type Harness,
  type ReportTask,
  type SubmissionRecord,
} from '@earendil-works/pi-durable'
import type { PersonId } from '@vivid/contracts'
import { Effect } from 'effect'
import { pi, type PiRejected } from './threads.ts'

/** A host-ended reply failed, even though Pi's public task abort settles it as `aborted`.
 * Written before abort so a restart and every reader retain the distinction from a Person's stop. */
const FailedReply = defineDocFamily<{ reason: 'restart_limit' }, null>({
  kind: 'vivid.failed',
  version: 1,
  scope: 'conversation',
  family: true,
  history: 'latest',
  fork: 'initial',
  checkpointWhen: () => false,
  initial: () => ({ reason: 'restart_limit' }),
})

/** End the current reply through Pi's abort protocol, which also drains its owned tools.
 * Abort the run task rather than the conversation, preserving inputs queued behind it. */
export const endParked: (
  harness: Harness,
  task: ReportTask,
  personId: PersonId,
) => Effect.Effect<void, PiRejected> = Effect.fn('Recovery.endParked')(function* (
  harness: Harness,
  task: ReportTask,
  personId: PersonId,
) {
  const live = yield* pi(() => harness.snapshot(LiveDoc, task.conversationId, BACKGROUND_CONTEXT))
  if (live === undefined || live.run === undefined) return
  const run = live.run
  yield* pi(() =>
    // @effect-diagnostics-next-line asyncFunction:off -- Pi's transaction callback is Promise-only; document writes stay on its mutation line.
    harness.commit(async (tx) => {
      for (const input of run.inputs)
        await tx.doc(FailedReply, task.conversationId, String(input), null)
    }, BACKGROUND_CONTEXT),
  )
  yield* Effect.logWarning('Reply ended after repeated runtime crashes', {
    personId,
    taskKind: task.kind,
  })
  yield* pi(() => harness.abortTask(run.taskId, BACKGROUND_CONTEXT))
})

/** Translate only a host-aborted crash loop; Pi's receipt and ordinary stops remain authoritative. */
export const replyRecord: (
  harness: Harness,
  record: SubmissionRecord,
) => Effect.Effect<SubmissionRecord, PiRejected> = Effect.fn('Recovery.replyRecord')(function* (
  harness: Harness,
  record: SubmissionRecord,
) {
  if (record.status !== 'unanswered' || record.reason !== 'aborted') return record
  const failed = yield* pi(() =>
    harness.snapshot(FailedReply, record.conversationId, String(record.id), BACKGROUND_CONTEXT),
  )
  return failed === undefined ? record : { ...record, reason: failed.reason }
})
