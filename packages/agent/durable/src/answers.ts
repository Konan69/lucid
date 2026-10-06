import { copyJson, type Context, type JsonValue } from '@earendil-works/chord'
import type { Conversation, Harness } from '@earendil-works/pi-durable'
import { Effect, Option, Predicate } from 'effect'
import { Delivery, copyQuestion, type Question } from './delivery.ts'
import { type HoldId, CallNotWaiting } from './errors.ts'
import { holdIdOf, Holds, type Answer, type Settlement } from './holds.ts'
import * as Pi from './pi.ts'

/** A recorded submission must exist in the same durable authority that admitted it. */
const receipt = Effect.fn('Durable.answerReceipt')(function* (
  harness: Harness,
  submitted: typeof Delivery.cases.Submitted.Type,
  context: Context,
) {
  const input = yield* Pi.submission(harness, submitted.submissionId, context)
  if (Option.isNone(input)) throw new Error('Recorded answer submission is missing')
  return yield* Pi.status(input.value, context)
})

/** Queued/placed answers are closed to changes; withdrawal reopens the same question for resubmission. */
export const questionOpen = Effect.fn('Durable.questionOpen')(function* (
  harness: Harness,
  conversation: Conversation,
  question: Question,
  context: Context,
) {
  return yield* Delivery.match(question.delivery, {
    Open: () => Effect.succeed(true),
    Reserved: () => Effect.succeed(true),
    Submitted: (submitted) =>
      observePlacement(harness, conversation, { question, delivery: submitted }, context),
  })
})

/** Observation retires a question only after durable placement; withdrawal exposes it again. */
const observePlacement = Effect.fn('Durable.observeAnswerPlacement')(function* (
  harness: Harness,
  conversation: Conversation,
  input: { readonly question: Question; readonly delivery: typeof Delivery.cases.Submitted.Type },
  context: Context,
) {
  const status = yield* receipt(harness, input.delivery, context)
  if (status.entry !== undefined) {
    yield* finish(
      conversation,
      {
        holdId: holdIdOf(input.question.taskId),
        delivery: input.delivery,
      },
      context,
    )
    return false
  }
  return status.status === 'unanswered'
})

/** First output is selected before Pi admission, fixing different-output retries across crashes. */
const reserve = Effect.fn('Durable.reserveAnswer')(function* (
  conversation: Conversation,
  input: { readonly given: Answer; readonly withdrawn: Option.Option<number> },
  context: Context,
) {
  return yield* Pi.commit(
    conversation,
    {
      token: Holds,
      conversationId: conversation.id,
      change: (document) => {
        const question = document.asked[input.given.holdId]
        if (question === undefined) return Option.none<Question>()
        question.delivery = Delivery.match(question.delivery, {
          Open: () =>
            Delivery.cases.Reserved.make({ attempt: 0, output: copyJson(input.given.output) }),
          Reserved: (reserved) =>
            Delivery.cases.Reserved.make({
              attempt: reserved.attempt,
              output: copyJson(reserved.output),
            }),
          Submitted: (submitted) =>
            Option.contains(input.withdrawn, submitted.attempt)
              ? Delivery.cases.Reserved.make({
                  attempt: submitted.attempt + 1,
                  output: copyJson(submitted.output),
                })
              : Delivery.cases.Submitted.make({
                  attempt: submitted.attempt,
                  output: copyJson(submitted.output),
                  submissionId: submitted.submissionId,
                }),
        })
        return Option.some(copyQuestion(question))
      },
    },
    context,
  )
})

/** Only placement clears asked. A queued answer remains durable and can reopen after abort. */
const finish = Effect.fn('Durable.finishAnswer')(function* (
  conversation: Conversation,
  input: { readonly holdId: HoldId; readonly delivery: typeof Delivery.cases.Submitted.Type },
  context: Context,
) {
  return yield* Pi.commit(
    conversation,
    {
      token: Holds,
      conversationId: conversation.id,
      change: (document) => {
        const question = document.asked[input.holdId]
        if (
          question !== undefined &&
          Delivery.guards.Submitted(question.delivery) &&
          question.delivery.submissionId === input.delivery.submissionId
        ) {
          document.settled[input.holdId] = {
            taskId: question.taskId,
            callId: question.callId,
            settlement: { kind: 'answered', output: copyJson(input.delivery.output) },
          }
          delete document.asked[input.holdId]
        }
      },
    },
    context,
  )
})

/** Late-answer messages are ordinary user input; deduplication keys are scoped to the delivery attempt. */
const answerText = (name: string, output: JsonValue) =>
  `[answer to ${name}] ${Predicate.isString(output) ? output : JSON.stringify(output)}`

/** Persist the actual admission receipt without deleting an unplaced question. */
const admit = Effect.fn('Durable.admitAnswer')(function* (
  conversation: Conversation,
  input: {
    readonly given: Answer
    readonly question: Question
    readonly delivery: typeof Delivery.cases.Reserved.Type
  },
  context: Context,
) {
  const submitted = yield* Pi.submit(
    conversation,
    {
      type: 'input',
      content: answerText(input.question.toolName, input.delivery.output),
      requestId: `answer:${input.given.holdId}:${input.delivery.attempt}`,
      whenBusy: 'followUp',
    },
    context,
  )
  const delivery = Delivery.cases.Submitted.make({
    attempt: input.delivery.attempt,
    output: copyJson(input.delivery.output),
    submissionId: submitted.id,
  })
  yield* Pi.commit(
    conversation,
    {
      token: Holds,
      conversationId: conversation.id,
      change: (document) => {
        const question = document.asked[input.given.holdId]
        if (
          question !== undefined &&
          Delivery.guards.Reserved(question.delivery) &&
          question.delivery.attempt === input.delivery.attempt
        )
          question.delivery = delivery
      },
    },
    context,
  )
  return delivery
})

/** Withdrawn follow-ups retry with a fresh key and the first reserved output; repeats cannot alter it. */
export const deliver = Effect.fn('Durable.deliverAnswer')(function* (
  harness: Harness,
  conversation: Conversation,
  given: Answer,
  context: Context,
): Effect.fn.Return<Settlement, import('./errors.ts').PiFailed | CallNotWaiting> {
  const holds = yield* Pi.snapshot(harness, Holds, conversation.id, context)
  const question = Option.flatMapNullishOr(holds, (document) => document.asked[given.holdId])
  if (Option.isNone(question)) {
    const recorded = Option.flatMapNullishOr(holds, (document) => document.settled[given.holdId])
    if (Option.isSome(recorded) && recorded.value.settlement.kind === 'answered')
      return { kind: 'answered', output: copyJson(recorded.value.settlement.output) }
    return yield* new CallNotWaiting({ conversationId: conversation.id, holdId: given.holdId })
  }
  let withdrawn = Option.none<number>()
  if (Delivery.guards.Submitted(question.value.delivery)) {
    const delivered = question.value.delivery
    const status = yield* receipt(harness, delivered, context)
    if (status.entry !== undefined) {
      yield* finish(conversation, { holdId: given.holdId, delivery: delivered }, context)
      return { kind: 'answered', output: copyJson(delivered.output) }
    }
    if (status.status !== 'unanswered')
      return { kind: 'answered', output: copyJson(delivered.output) }
    withdrawn = Option.some(delivered.attempt)
  }
  const reserved = yield* reserve(conversation, { given, withdrawn }, context)
  if (Option.isNone(reserved)) return yield* deliver(harness, conversation, given, context)
  return yield* Delivery.match(reserved.value.delivery, {
    Open: () =>
      Effect.sync((): Settlement => {
        throw new Error('Answer reservation did not reserve output')
      }),
    Submitted: () => deliver(harness, conversation, given, context),
    Reserved: (delivery) =>
      deliverReserved(
        harness,
        conversation,
        { given, question: reserved.value, delivery },
        context,
      ),
  })
})

/** Admission can race an abort: an already-withdrawn receipt retries from the newly persisted attempt. */
const deliverReserved = Effect.fn('Durable.deliverReserved')(function* (
  harness: Harness,
  conversation: Conversation,
  input: {
    readonly given: Answer
    readonly question: Question
    readonly delivery: typeof Delivery.cases.Reserved.Type
  },
  context: Context,
): Effect.fn.Return<Settlement, import('./errors.ts').PiFailed | CallNotWaiting> {
  const submitted = yield* admit(conversation, input, context)
  const status = yield* receipt(harness, submitted, context)
  if (status.entry !== undefined)
    yield* finish(conversation, { holdId: input.given.holdId, delivery: submitted }, context)
  else if (status.status === 'unanswered')
    return yield* deliver(harness, conversation, input.given, context)
  return { kind: 'answered', output: copyJson(submitted.output) }
})
