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
  initialRunState,
  replay,
  replayAfter,
  runMessageId,
} from './chunks.ts'
import type { Reader } from './desk.ts'
import { RunMissing, type PiFailed } from './errors.ts'
import * as Pi from './pi.ts'

/** A resume names the assistant run as well as the tool parts that the client already holds. */
export type ResumeInput = { readonly messageId: string; readonly known: ReadonlySet<string> }
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
 * Each generation owns one turn, never the whole run (generation.js:516,535). An aborted run may
 * contain several such tasks and task-attributed steer entries. The next idle host input is a
 * non-task-attributed pi.user (submissions.js:165–173); abort withdraws all queued inputs rather than
 * handing them to another generation (inbox.js:85–93). A reset marker also ends this stored range.
 */
function closedEntries(entries: readonly EntryRecord[]) {
  const next = entries.findIndex(
    (entry, index) =>
      index > 0 &&
      ((entry.kind === 'pi.user' && entry.byTaskId === undefined) || entry.kind === 'pi.reset'),
  )
  return next === -1 ? entries : entries.slice(0, next)
}

/** Idempotent admission of a terminal input returns its stored run instead of awaiting an old run_start. */
export const inputReplay: (
  reader: Reader,
  receipt: Extract<SubmissionRecord, { type: 'input' }>,
  snapshot: SnapshotEvent,
) => Effect.Effect<Prefix, PiFailed> = Effect.fn('Durable.inputReplay')(function* (
  reader: Reader,
  receipt: Extract<SubmissionRecord, { type: 'input' }>,
  snapshot: SnapshotEvent,
) {
  const { run: _run, generation: _generation, ...base } = snapshot
  const placed =
    receipt.entry === undefined
      ? []
      : yield* entriesOf(reader, {
          first: receipt.entry,
          last: receipt.status === 'done' ? Option.some(receipt.answer) : Option.none(),
        })
  const entries = receipt.status === 'unanswered' ? closedEntries(placed) : placed
  const prefix = Option.getOrThrow(replay({ ...base, entries, run: { inputs: [receipt.id] } }))
  return { step: prefix, live: false, known: new Set<string>(), origins: prefix.origins }
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
    last: receipt.status === 'done' ? Option.some(receipt.answer) : Option.none(),
  })
  const entries = receipt.status === 'unanswered' ? closedEntries(placed) : placed
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
  const chunks: Chunk[] = [
    { type: 'start', messageId: input.messageId },
    { type: 'start-step' },
    { type: 'finish-step' },
    { type: 'start', messageId: input.messageId },
  ]
  return {
    step: { state: initialRunState, chunks },
    live: false,
    known: input.known,
    origins: new Map<Chunk, TaskId>(),
  }
}
