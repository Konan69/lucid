import { copyJson, isJsonValue, type JsonValue } from '@earendil-works/chord'
import type { SubmissionId, TaskId } from '@earendil-works/pi-durable'
import { Predicate, Schema } from 'effect'

const SubmissionIdentity = Schema.declare<SubmissionId>((value): value is SubmissionId =>
  Predicate.isNumber(value),
)
const Output = Schema.declare<JsonValue>(isJsonValue)

/** Reserve first output before admission; a crash retries the same attempt and authoritative content. */
export const Delivery = Schema.TaggedUnion({
  Open: {},
  Reserved: { attempt: Schema.Natural, output: Output },
  Submitted: { attempt: Schema.Natural, output: Output, submissionId: SubmissionIdentity },
})
export type Delivery = typeof Delivery.Type
export type Question = { taskId: TaskId; callId: string; toolName: string; delivery: Delivery }

/** Pi transaction drafts expire: return a detached question and JSON tree to every continuation. */
export function copyQuestion(question: Question): Question {
  const delivery = Delivery.match(question.delivery, {
    Open: (): Delivery => Delivery.cases.Open.make({}),
    Reserved: (reserved): Delivery =>
      Delivery.cases.Reserved.make({
        attempt: reserved.attempt,
        output: copyJson(reserved.output),
      }),
    Submitted: (submitted): Delivery =>
      Delivery.cases.Submitted.make({
        attempt: submitted.attempt,
        output: copyJson(submitted.output),
        submissionId: submitted.submissionId,
      }),
  })
  return { taskId: question.taskId, callId: question.callId, toolName: question.toolName, delivery }
}
