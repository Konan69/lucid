import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import {
  defineDocFamily,
  InboxDoc,
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

/**
 * What is kept beside one admitted delivery while it can still be answered: how it is addressed
 * (to find whom a tool acts for), whether anybody was behind it, and the context read for it.
 *
 * The context is the frozen one. On Flue it lived in process memory between `useResponseStart`
 * and `useResponseFinish`, so a restart in the middle of a reply lost it and the reply went on
 * with an empty context and a changed instruction. Here it is committed before the delivery is
 * submitted and read back at every request of the response, so the instruction stays the same
 * text across the requests of one response and across a restart.
 */
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

/** The transcript kind of the entry that places waiting deliveries; it carries nothing else. */
export const PLACED_ENTRY = 'vivid.placed'

/**
 * Give the deliveries waiting in an idle conversation a response of their own.
 *
 * A delivery that arrives during a response waits in Pi's inbox for that run's next boundary.
 * A run that fails ends without one, and Pi then leaves them "until the next input or queued
 * write places them" (Pi README, Busy Conversations; `endRun` in `generation.ts` applies no
 * boundary on a model error). Nothing else is ever sent to the Thread on their behalf, so the
 * runtime sends that write itself. A write that changes what the model sees, which `edits` makes
 * it even when empty (`isDisplayOnly`, `inbox.ts`), runs the final boundary in its own commit
 * (`admitSubmission`): the waiting deliveries are placed and a run starts for them, atomically.
 *
 * It writes nothing when a run is going (its boundaries place them) or nothing is waiting.
 */
export const placeWaiting: (
  harness: Harness,
  conversationId: ConversationId,
) => Effect.Effect<void, PiRejected> = Effect.fn('Deliveries.placeWaiting')(function* (
  harness: Harness,
  conversationId: ConversationId,
) {
  const live = yield* pi(() => harness.snapshot(LiveDoc, conversationId, BACKGROUND_CONTEXT))
  if (live !== undefined && live.run !== undefined) return
  const inbox = yield* pi(() => harness.snapshot(InboxDoc, conversationId, BACKGROUND_CONTEXT))
  if (inbox === undefined || !inbox.items.some((item) => item.mode !== 'write')) return
  const conversation = yield* pi(() => harness.conversation(conversationId, BACKGROUND_CONTEXT))
  if (conversation === undefined) return
  yield* pi(() =>
    conversation.submit(
      { type: 'write', entry: { kind: PLACED_ENTRY, edits: [] } },
      BACKGROUND_CONTEXT,
    ),
  )
})

/**
 * The same for every conversation of a store, for a process that starts: one that died between
 * a failed run and the write above left its waiting deliveries with nothing to place them.
 */
export const placeAllWaiting: (harness: Harness) => Effect.Effect<void, PiRejected> = Effect.fn(
  'Deliveries.placeAllWaiting',
)(function* (harness: Harness) {
  const work = yield* pi(() => harness.inspect(BACKGROUND_CONTEXT))
  const waiting = new Set(
    work.submissions
      .filter((record) => record.type === 'input' && record.status === 'queued')
      .map((record) => record.conversationId),
  )
  for (const conversationId of waiting) yield* placeWaiting(harness, conversationId)
})

/**
 * Withdraw the runtime's own writes that are still waiting in a store nothing runs in.
 *
 * `placeWaiting` looks, then writes, in two steps. A delivery admitted between them starts the
 * run itself, and the write then waits in the inbox as any model-affecting write does; if that
 * run fails too, the write is left waiting alone. It is not work: no delivery depends on it and
 * no run will come for it. So an idle check does not count a queued write (`persons.ts`), and
 * this takes it out before the store closes (`abortSubmission`, which withdraws a queued
 * submission and removes its inbox item).
 */
export const withdrawWaitingWrites: (harness: Harness) => Effect.Effect<void, PiRejected> =
  Effect.fn('Deliveries.withdrawWaitingWrites')(function* (harness: Harness) {
    const work = yield* pi(() => harness.inspect(BACKGROUND_CONTEXT))
    for (const record of work.submissions) {
      if (record.type === 'write' && record.status === 'queued')
        yield* pi(() => harness.abortSubmission(record.id, BACKGROUND_CONTEXT))
    }
  })
