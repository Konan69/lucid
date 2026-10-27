import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import {
  configure,
  type AgentChange,
  type ConversationId,
  type Tx,
} from '@earendil-works/pi-durable'
import {
  RuntimeAdmissionReceipt,
  RuntimeSubmissionId,
  type RuntimeAdmissionBody,
} from '@vivid/contracts'
import { Effect, Option, Schema } from 'effect'
import { loadContext } from './context.ts'
import { encodeKept, keep, keptUnder, requestOf } from './deliveries.ts'
import { addressed, cachedAuthority, modelDelivery, placement, recordScope } from './delivery.ts'
import type { PersonConversations } from './person.ts'
import { ensureConversation, PiRejected, pi } from './threads.ts'

const receiptId = Schema.decodeUnknownEffect(RuntimeSubmissionId)

/**
 * Step 5 below, as one Pi commit. A concurrent request with the same key may have been admitted
 * since this one looked: then nothing is written.
 */
const reserve = (
  tx: Tx,
  reservation: {
    readonly conversationId: ConversationId
    readonly key: string
    readonly kept: string
  },
  agent: AgentChange,
) =>
  tx
    .submissionByRequest(reservation.conversationId, reservation.key)
    .then((admitted) =>
      admitted === undefined
        ? keep(tx, reservation.conversationId, reservation.key, reservation.kept).then(() =>
            configure(tx, reservation.conversationId, agent),
          )
        : undefined,
    )

/**
 * Admit one delivery into its Thread's conversation, exactly once.
 *
 * 1. The Thread's conversation is found or created.
 * 2. A key Pi already holds is answered with its submission and nothing else happens: the same
 *    idempotency key finds the same submission after a retry or a restart (Pi `admitSubmission`
 *    looks the request id up before it writes). The request id is the key under a prefix of its
 *    own (`requestOf`), so it can only ever name a delivery.
 * 3. The delivery's scope is recorded for its turn, outside anything the model reads.
 * 4. The acting Person's context is read, once, before Pi can start answering.
 * 5. One commit keeps that context with the delivery and states the conversation's model and
 *    tools. It comes before the submission because the run may render its instruction the moment
 *    the submission commits. The first context kept under a key stays: a second attempt, sent at
 *    the same moment or after a crash between this step and the next, answers with the first's.
 * 6. Pi admits the input under the key. The client's own key, when the delivery has one, is
 *    placed in the entry's data for the state to give back; a repeated key is answered at step 2,
 *    so the first attempt's client key is the one kept. `whenBusy: 'steer'` is main's behaviour: a delivery that
 *    arrives during a response joins it after the current round of tools.
 */
export const admit = Effect.fn('Admission.admit')(function* (
  person: PersonConversations,
  body: RuntimeAdmissionBody,
) {
  const { harness } = person
  const conversation = yield* ensureConversation(harness, body.threadId, body.initialData)
  const receipt = (id: number, repeated: boolean) =>
    receiptId(id).pipe(
      Effect.mapError((cause) => new PiRejected({ cause })),
      Effect.map((submissionId) => RuntimeAdmissionReceipt.make({ submissionId, repeated })),
    )
  const request = requestOf(body.idempotencyKey)
  const held = yield* pi(() =>
    harness.commit((tx) => tx.submissionByRequest(conversation.id, request), BACKGROUND_CONTEXT),
  )
  if (held !== undefined) return yield* receipt(held.id, true)

  recordScope(body.threadId, body.turn, body.scope)
  const delivery = modelDelivery(body)
  const acting = Option.map(
    cachedAuthority(body.threadId, delivery, Option.some(body.initialData)),
    (authority) => authority.acting,
  )
  // An earlier attempt with this key may have kept its context and gone no further. That
  // context is the delivery's; it is not read a second time.
  const before = yield* keptUnder(harness, conversation.id, request)
  const kept = Option.isSome(before)
    ? before.value
    : yield* encodeKept({
        addressed: addressed(delivery),
        acting: Option.isSome(acting),
        context: yield* loadContext(person.sources, acting),
      }).pipe(Effect.mapError((cause) => new PiRejected({ cause })))
  const reservation = { conversationId: conversation.id, key: request, kept }
  yield* pi(() =>
    harness.commit((tx) => reserve(tx, reservation, person.agent), BACKGROUND_CONTEXT),
  )
  const placed = placement(delivery, Option.fromUndefinedOr(body.clientKey))
  const input = {
    type: 'input' as const,
    content: placed.content,
    requestId: request,
    whenBusy: 'steer' as const,
  }
  const draft = Option.match(placed.entry, {
    onNone: () => input,
    onSome: (entry) => ({ ...input, entry }),
  })
  const submission = yield* pi(() => conversation.submit(draft, BACKGROUND_CONTEXT))
  return yield* receipt(submission.id, false)
})
