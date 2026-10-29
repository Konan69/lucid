import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import {
  defineDocFamily,
  LiveDoc,
  type ConversationId,
  type Harness,
  type SubmissionId,
  type Tx,
} from '@earendil-works/pi-durable'
import { Effect, Option, Schema } from 'effect'
import { Addressed } from './delivery.ts'
import { pi, type PiRejected } from './threads.ts'
import { VividContext } from './tools/snapshots.ts'

/** Keep a delivery's address, authority and frozen context until it settles. Commit context
 * before admission and read it for every model request so instructions survive a restart. */
export const Kept = Schema.Struct({
  addressed: Addressed,
  acting: Schema.Boolean,
  context: VividContext,
})
export interface Kept extends Schema.Schema.Type<typeof Kept> {}

const codec = Schema.fromJsonString(Schema.toCodecJson(Kept))
export const encodeKept = Schema.encodeEffect(codec)
const decodeKept = Schema.decodeUnknownOption(codec)

/**
 * One member per delivery, keyed by its Pi request id (`requestOf` its idempotency key): the submission record names the key, and the key names this. It is stored as the JSON text
 * the schema encodes, and decoded where it is read. Only the current value matters, and a fork is
 * not a delivery.
 */
export const DeliveryRecord = defineDocFamily<{ kept: string }, string>({
  kind: 'vivid.delivery',
  version: 1,
  scope: 'conversation',
  family: true,
  checkpointWhen: () => false,
  history: 'latest',
  fork: 'initial',
  initial: (kept) => ({ kept }),
})

/**
 * The Pi request id of a delivery, which is also its record's key. The prefix keeps a delivery's
 * key, which is any text the server chooses, apart from the request ids the runtime gives its own
 * writes (`vivid.response:<n>`): two names that cannot be equal cannot be mistaken for each other.
 */
export const requestOf = (idempotencyKey: string) => `delivery:${idempotencyKey}`

/**
 * The server's idempotency key of the delivery being answered: the newest input the run placed,
 * read back from its request id. It names the server's Run of that delivery, and comes from the
 * conversation's committed inputs, never from anything the model said (`children.ts`).
 */
export const answeringKey: (
  harness: Harness,
  conversationId: ConversationId,
) => Effect.Effect<Option.Option<string>, PiRejected> = Effect.fn('Deliveries.answeringKey')(
  function* (harness: Harness, conversationId: ConversationId) {
    const inputs = yield* runInputs(harness, conversationId)
    const newest = inputs.at(-1)
    if (newest === undefined) return Option.none()
    const submission = yield* pi(() => harness.submission(newest, BACKGROUND_CONTEXT))
    if (submission === undefined) return Option.none()
    const { requestId } = yield* pi(() => submission.status(BACKGROUND_CONTEXT))
    const prefix = requestOf('')
    if (requestId === undefined || !requestId.startsWith(prefix)) return Option.none()
    return Option.some(requestId.slice(prefix.length))
  },
)

/**
 * Keep a delivery's record in the caller's commit. The first record kept under a key is the
 * delivery's: `tx.doc` on a family returns the member that is already there and uses the seed
 * only to create one, so a second attempt with the same key (sent at the same moment, or after a
 * crash before the first was submitted) leaves the first attempt's context in place.
 */
export const keep = (tx: Tx, conversationId: ConversationId, request: string, kept: string) =>
  tx.doc(DeliveryRecord, conversationId, request, kept).then(() => {})

/** The record already kept under a request id, as stored. */
export const keptUnder = (harness: Harness, conversationId: ConversationId, request: string) =>
  pi(() => harness.snapshot(DeliveryRecord, conversationId, request, BACKGROUND_CONTEXT)).pipe(
    Effect.map((record) => Option.map(Option.fromUndefinedOr(record), ({ kept }) => kept)),
  )

/** The run that is answering now holds its inputs in `pi.live.run` (Pi `src/harness/live.ts`). */
export const runInputs: (
  harness: Harness,
  conversationId: ConversationId,
) => Effect.Effect<SubmissionId[], PiRejected> = Effect.fn('Deliveries.runInputs')(function* (
  harness: Harness,
  conversationId: ConversationId,
) {
  const live = yield* pi(() => harness.snapshot(LiveDoc, conversationId, BACKGROUND_CONTEXT))
  if (live === undefined || live.run === undefined) return []
  return Array.from(live.run.inputs)
})

/** The kept record of one of the run's inputs, found through its submission's request id. */
const keptOf = Effect.fn('Deliveries.keptOf')(function* (
  harness: Harness,
  conversationId: ConversationId,
  input: Option.Option<SubmissionId>,
) {
  if (Option.isNone(input)) return Option.none<Kept>()
  const submission = yield* pi(() => harness.submission(input.value, BACKGROUND_CONTEXT))
  if (submission === undefined) return Option.none<Kept>()
  const { requestId } = yield* pi(() => submission.status(BACKGROUND_CONTEXT))
  if (requestId === undefined) return Option.none<Kept>()
  const record = yield* pi(() =>
    harness.snapshot(DeliveryRecord, conversationId, requestId, BACKGROUND_CONTEXT),
  )
  return record === undefined ? Option.none<Kept>() : decodeKept(record.kept)
})

/**
 * The delivery whose context the whole response reads: the run's first input. A delivery that
 * joins later has a record of its own, read for whom to act for and never for context, which is
 * what keeps the instruction identical from the first request of a response to its last.
 */
export const opening: (
  harness: Harness,
  conversationId: ConversationId,
) => Effect.Effect<Option.Option<Kept>, PiRejected> = Effect.fn('Deliveries.opening')(function* (
  harness: Harness,
  conversationId: ConversationId,
) {
  const inputs = yield* runInputs(harness, conversationId)
  return yield* keptOf(harness, conversationId, Option.fromUndefinedOr(inputs[0]))
})

/** The delivery being answered: the newest input the run has placed. Tools act for its Person. */
export const answering: (
  harness: Harness,
  conversationId: ConversationId,
) => Effect.Effect<Option.Option<Kept>, PiRejected> = Effect.fn('Deliveries.answering')(function* (
  harness: Harness,
  conversationId: ConversationId,
) {
  const inputs = yield* runInputs(harness, conversationId)
  return yield* keptOf(harness, conversationId, Option.fromUndefinedOr(inputs.at(-1)))
})

/**
 * Release a settled delivery's record. Called once for every submission that settles, however
 * its run ended (`settled.ts`), so nothing a response froze outlives the response.
 */
export const release = (harness: Harness, conversationId: ConversationId, key: string) =>
  pi(() =>
    harness.commit((tx) => tx.retireDoc(DeliveryRecord, conversationId, key), BACKGROUND_CONTEXT),
  )
