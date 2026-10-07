import type {
  ConversationId,
  Cursor,
  EntryId,
  EntryRecord,
  SnapshotEvent,
  SubmissionId,
  SubmissionRecord,
  TaskId,
} from '@earendil-works/pi-durable'
import { Effect, Option, Predicate, Schema } from 'effect'
import {
  type Chunk,
  type Step,
  type Rebuilt,
  closeRun,
  rebuild,
  replay,
  replayAfter,
  runMessageId,
} from './chunks.ts'
import type { Reader } from './desk.ts'
import { RunMissing, TurnWithdrawn, type PiFailed } from './errors.ts'
import * as Pi from './pi.ts'
import { messageMetadata } from './metadata.ts'

/** A resume names the assistant run as well as the tool parts that the client already holds. */
export type ResumeInput = {
  readonly messageId: string
  readonly known: ReadonlySet<string>
  readonly steps?: number
}
/** A replay prefix owns its complete translator state and per-chunk task provenance. */
export type Prefix = {
  readonly step: Step
  readonly live: boolean
  readonly known: ReadonlySet<string>
  readonly origins: ReadonlyMap<Chunk, TaskId>
}

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
    readonly first: EntryId
    readonly last: Option.Option<EntryId>
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
export const captureRun: (
  reader: Reader,
  snapshot: SnapshotEvent,
) => Effect.Effect<SnapshotEvent, RunMissing | PiFailed> = Effect.fn('Durable.captureRun')(
  function* (reader: Reader, snapshot: SnapshotEvent) {
    if (snapshot.run === undefined) return snapshot
    const first = snapshot.run.inputs[0]
    if (first === undefined)
      return yield* new RunMissing({ conversationId: reader.conversation.id })
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
    if (Option.isNone(tail))
      return yield* new RunMissing({ conversationId: reader.conversation.id })
    const entries = yield* entriesOf(reader, {
      first: receipt.entry,
      last: Option.some(tail.value.id),
    })
    return { ...snapshot, entries }
  },
)

/**
 * The done receipt's answer is the final boundary of its run. Pi generation.js:408–421 places
 * queued users in that same commit under the predecessor task, so byTaskId cannot distinguish
 * those successor inputs from earlier steers. Steers precede this answer; the first pi.user after
 * it begins the next run. Keep intervening tool results (terminateRun settles against the earlier
 * calling assistant), and keep task-attributed steers inside an unanswered/active run as before.
 */
function closedEntries(
  entries: readonly EntryRecord[],
  receipt: Extract<SubmissionRecord, { type: 'input' }>,
) {
  const next = entries.findIndex(
    (entry, index) =>
      index > 0 &&
      (entry.kind === 'pi.reset' ||
        (entry.kind === 'pi.user' &&
          (receipt.status === 'done' ? entry.id > receipt.answer : entry.byTaskId === undefined))),
  )
  return next === -1 ? entries : entries.slice(0, next)
}

/** Idempotent admission of a terminal input returns its stored run instead of awaiting an old run_start. */
export const inputReplay: (
  reader: Reader,
  receipt: Extract<SubmissionRecord, { type: 'input' }>,
  snapshot: SnapshotEvent,
  messageId: string,
) => Effect.Effect<Prefix, PiFailed | TurnWithdrawn | RunMissing> = Effect.fn(
  'Durable.inputReplay',
)(function* (
  reader: Reader,
  receipt: Extract<SubmissionRecord, { type: 'input' }>,
  snapshot: SnapshotEvent,
  messageId: string,
) {
  const { run: _run, generation: _generation, ...base } = snapshot
  if (receipt.entry === undefined) return yield* new TurnWithdrawn({ messageId })
  const placed = yield* entriesOf(reader, { first: receipt.entry, last: Option.none() })
  const entries = closedEntries(placed, receipt)
  const found = replay({ ...base, entries, run: { inputs: [receipt.id] } })
  if (Option.isNone(found)) return yield* new RunMissing({ conversationId: reader.conversation.id })
  const prefix = found.value
  const closed = closeRun(prefix.state, runMessageId([receipt.id]))
  return {
    step: { state: closed.state, chunks: [...prefix.chunks, ...closed.chunks] },
    live: false,
    known: new Set<string>(),
    origins: prefix.origins,
  }
})

/** A placed input belongs to this conversation and retains its authoritative entry through settlement. */
function placedFor(
  receipt: SubmissionRecord,
  conversationId: ConversationId,
): receipt is Extract<SubmissionRecord, { type: 'input' }> & {
  readonly entry: EntryId
} {
  return (
    receipt.conversationId === conversationId &&
    receipt.type === 'input' &&
    receipt.entry !== undefined
  )
}

/** A stored run may be acknowledged after successful completion or explicit abort. */
function resumable(receipt: SubmissionRecord, active: boolean) {
  return active || receipt.status === 'done' || receipt.status === 'unanswered'
}

/** A steer does not change the run's identity; only its first input identifies active ownership. */
function ownsActiveRun(snapshot: SnapshotEvent, messageId: string) {
  return snapshot.run !== undefined && messageId === runMessageId(snapshot.run.inputs)
}

/** Resolve the exact first input and its stored run before matching calls. Closed runs cannot
 * borrow a successor generation's parts; the terminal acknowledgement owns the closed response. */
export const selectRun: (
  reader: Reader,
  input: ResumeInput,
  snapshot: SnapshotEvent,
  intent: 'Replay' | 'Complete',
) => Effect.Effect<Option.Option<Prefix>, RunMissing | PiFailed> = Effect.fn(
  'Durable.selectResumeRun',
)(function* (
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
    last: Option.none(),
  })
  const entries = closedEntries(placed, receipt)
  // A completed run must not borrow the newer run's generation or live continuation.
  const { run: _run, generation: _generation, ...stored } = snapshot
  const captured = active ? { ...snapshot, entries } : { ...stored, entries }
  const prefix = replayAfter(captured, input.known)
  if (Option.isNone(prefix))
    return yield* new RunMissing({ conversationId: reader.conversation.id })
  if (!active) return Option.some(completed(input, prefix.value, rebuild(entries), intent))
  return Option.some({ ...prefix.value, known: input.known })
})

/** Durable step count distinguishes a retained closing boundary from a client that lost it.
 * A settlement-bearing closed resume restores terminal parts before closing; a content-free
 * acknowledgement appends nothing when the client's copy already has the durable boundary. */
function completed(
  input: ResumeInput,
  prefix: Omit<Prefix, 'known'>,
  stored: Rebuilt,
  intent: 'Replay' | 'Complete',
): Prefix {
  const closed = closeRun(stored.state, input.messageId)
  const expected = closed.state.turn
  const correction = intent === 'Replay' ? terminalCorrection(input, prefix, stored) : []
  const closing = input.steps === expected ? [] : closed.chunks
  const ending: readonly Chunk[] =
    closing.length === 0 && correction.length > 0
      ? [
          {
            type: 'start',
            messageId: input.messageId,
            messageMetadata: messageMetadata(stored.state.metadata),
          },
        ]
      : closing
  return {
    step: {
      state: closed.state,
      chunks: [
        {
          type: 'start',
          messageId: input.messageId,
          messageMetadata: messageMetadata(stored.state.metadata),
        },
        ...correction,
        ...ending,
      ],
    },
    live: false,
    known: input.known,
    origins: stored.origins,
  }
}

/** Rebuilding the retained current step also removes the client's unsatisfied approval payload.
 * The SDK's output-error update preserves approval fields; reset-step is its honest removal API.
 * Earlier steps remain untouched, and a closed copy with its boundary needs no replayed parts. */
function terminalCorrection(
  input: ResumeInput,
  prefix: Omit<Prefix, 'known'>,
  stored: Rebuilt,
): readonly Chunk[] {
  if (input.steps === undefined || input.steps === 0)
    return prefix.step.chunks.filter((chunk) => chunk.type !== 'start')
  if (input.steps > stored.state.turn) return []
  let step = 0
  const from = stored.chunks.findIndex(
    (chunk) => chunk.type === 'start-step' && ++step === input.steps,
  )
  return from === -1 ? [] : [{ type: 'reset-step' }, ...stored.chunks.slice(from + 1)]
}
