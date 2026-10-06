import type { Cursor, EntryRecord, SnapshotEvent, SubmissionId } from '@earendil-works/pi-durable'
import { Effect, Option, Predicate, Schema } from 'effect'
import { initialRunState, replayAfter, runMessageId } from './chunks.ts'
import type { Reader } from './desk.ts'
import { RunMissing } from './errors.ts'
import * as Pi from './pi.ts'

/** A resume names the assistant run as well as the tool parts that the client already holds. */
export type ResumeInput = { readonly messageId: string; readonly known: ReadonlySet<string> }
const SubmissionIdentity = Schema.declare<SubmissionId>(
  (value): value is SubmissionId =>
    Predicate.isNumber(value) && Number.isSafeInteger(value) && value > 0,
)
const decodeSubmission = Schema.decodeUnknownOption(SubmissionIdentity)

/** Run ids encode the first input, never a provider call id or a later steer. */
function inputOf(messageId: string) {
  const found = /^run:([1-9][0-9]*)$/u.exec(messageId)
  return found === null ? Option.none<SubmissionId>() : decodeSubmission(Number(found[1]))
}

/** Raw entries preserve the requested run even when model context was compacted or a newer run exists. */
const entriesOf = Effect.fn('Durable.resumeEntries')(function* (
  reader: Reader,
  bounds: {
    readonly first: import('@earendil-works/pi-durable').EntryId
    readonly last: Option.Option<import('@earendil-works/pi-durable').EntryId>
  },
) {
  let cursor = Option.none<Cursor>()
  const entries: EntryRecord[] = []
  const query = Option.match(bounds.last, {
    onNone: () => ({ minEntryId: bounds.first }),
    onSome: (last) => ({ minEntryId: bounds.first, maxEntryId: last }),
  })
  for (;;) {
    const page = yield* Pi.entries(
      reader.conversation,
      { query, limit: 100, cursor },
      reader.context,
    )
    entries.push(...page.items)
    cursor = Option.fromNullishOr(page.next)
    if (Option.isNone(cursor)) return entries.toReversed()
  }
})

/** Bound whole-run attachment to its first placed input, never the newest steer or an older run. */
export const captureRun = Effect.fn('Durable.captureRun')(function* (
  reader: Reader,
  snapshot: SnapshotEvent,
) {
  if (snapshot.run === undefined) return snapshot
  const first = Option.getOrThrow(Option.fromNullishOr(snapshot.run.inputs[0]))
  const handle = yield* Pi.submission(reader.harness, first, reader.context)
  if (Option.isNone(handle))
    return yield* new RunMissing({ conversationId: reader.conversation.id })
  const receipt = yield* Pi.status(handle.value, reader.context)
  if (!placedFor(receipt, reader.conversation.id))
    return yield* new RunMissing({ conversationId: reader.conversation.id })
  // Usually the atomic model view contains the whole run. Compaction can remove its first input;
  // recover raw entries only then, bounded by the snapshot's tail so the prefix cannot outrun events.
  if (snapshot.entries.some((entry) => entry.id === receipt.entry))
    return { ...snapshot, entries: snapshot.entries.filter((entry) => entry.id >= receipt.entry) }
  const tail = Option.fromNullishOr(snapshot.entries.at(-1))
  if (Option.isNone(tail)) return yield* new RunMissing({ conversationId: reader.conversation.id })
  const entries = yield* entriesOf(reader, {
    first: receipt.entry,
    last: Option.some(tail.value.id),
  })
  return { ...snapshot, entries }
})

/** Unanswered runs have no answer bound. transaction.js stamps assistant entries with the generation
 * task id; all responses of that run share it, including recovered attempts and steer extensions.
 * Stop before another generation's assistant rather than borrowing its reused call ids. A parked
 * abort need not append an aborted partial, so stopReason alone cannot locate this run. */
function abortedEntries(entries: readonly EntryRecord[]) {
  const first = entries.find((entry) => entry.kind === 'pi.assistant')
  if (first === undefined || first.byTaskId === undefined) return []
  const next = entries.findIndex(
    (entry) => entry.kind === 'pi.assistant' && entry.byTaskId !== first.byTaskId,
  )
  return next === -1 ? entries : entries.slice(0, next)
}

/** A placed input belongs to this conversation and retains its authoritative entry through settlement. */
function placedFor(
  receipt: import('@earendil-works/pi-durable').SubmissionRecord,
  conversationId: import('@earendil-works/pi-durable').ConversationId,
): receipt is Extract<import('@earendil-works/pi-durable').SubmissionRecord, { type: 'input' }> & {
  readonly entry: import('@earendil-works/pi-durable').EntryId
} {
  return (
    receipt.conversationId === conversationId &&
    receipt.type === 'input' &&
    receipt.entry !== undefined
  )
}

/** A stored run may be acknowledged after successful completion or explicit abort. */
function resumable(
  receipt: import('@earendil-works/pi-durable').SubmissionRecord,
  active: boolean,
) {
  return active || receipt.status === 'done' || receipt.status === 'unanswered'
}

/** A steer does not change the run's identity; only its first input identifies active ownership. */
function ownsActiveRun(snapshot: SnapshotEvent, messageId: string) {
  return snapshot.run !== undefined && messageId === runMessageId(snapshot.run.inputs)
}

/** Closed aborts retain the client's error part and emit an empty terminal step: SDK start/finish
 * alone preserve that completed tool step and its stock predicate would POST again indefinitely.
 * Resolve the exact first input through Pi's public receipt before matching any known tool call. */
export const selectRun = Effect.fn('Durable.selectResumeRun')(function* (
  reader: Reader,
  input: ResumeInput,
  snapshot: SnapshotEvent,
  intent: 'Replay' | 'Complete',
) {
  const id = inputOf(input.messageId)
  if (Option.isNone(id)) return yield* new RunMissing({ conversationId: reader.conversation.id })
  const handle = yield* Pi.submission(reader.harness, id.value, reader.context)
  if (Option.isNone(handle))
    return yield* new RunMissing({ conversationId: reader.conversation.id })
  const receipt = yield* Pi.status(handle.value, reader.context)
  const active = ownsActiveRun(snapshot, input.messageId)
  if (!placedFor(receipt, reader.conversation.id) || !resumable(receipt, active))
    return yield* new RunMissing({ conversationId: reader.conversation.id })
  const placed = yield* entriesOf(reader, {
    first: receipt.entry,
    last: receipt.status === 'done' ? Option.some(receipt.answer) : Option.none(),
  })
  const entries = receipt.status === 'unanswered' ? abortedEntries(placed) : placed
  // A completed run must not borrow the newer run's generation or live continuation.
  const { run: _run, generation: _generation, ...stored } = snapshot
  const captured = active ? { ...snapshot, entries } : { ...stored, entries }
  const prefix = replayAfter(captured, input.known)
  if (Option.isNone(prefix))
    return yield* new RunMissing({ conversationId: reader.conversation.id })
  if (receipt.status === 'unanswered' || (!active && intent === 'Complete'))
    return Option.some(completed(input))
  return Option.some({ ...prefix.value, known: input.known })
})

/** An empty terminal step stops stock automatic predicates while preserving the finished parts.
 * SDK start-step/finish-step do not write Chat state; the second identity-only start publishes it. */
function completed(input: ResumeInput) {
  const chunks: import('./chunks.ts').Chunk[] = [
    { type: 'start', messageId: input.messageId },
    { type: 'start-step' },
    { type: 'finish-step' },
    { type: 'start', messageId: input.messageId },
  ]
  return {
    step: { state: initialRunState, chunks },
    live: false,
    known: input.known,
    origins: new Map<import('./chunks.ts').Chunk, import('@earendil-works/pi-durable').TaskId>(),
  }
}
