import type {
  ConversationId,
  Cursor,
  EntryId,
  EntryRecord,
  SnapshotEvent,
  SubmissionId,
  SubmissionRecord,
  TaskId,
  LiveState,
} from '@earendil-works/pi-durable'
import { LiveDoc } from '@earendil-works/pi-durable'
import { Effect, Option, Predicate, Schema } from 'effect'
import {
  type Chunk,
  type Step,
  type Rebuilt,
  closeRun,
  rebuild,
  replay,
  replayAfter,
  assistantMessageId,
  AssistantIdentity,
  entryIdentity,
  type RunSnapshot,
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

/** The placed receipt and raw entries are carried with the identity, avoiding a second read
 * when observation also needs the prefix that proved it. */
type ResolvedRun = {
  readonly messageId: string
  readonly receipt: Extract<SubmissionRecord, { type: 'input' }> & { readonly entry: EntryId }
  readonly entries: readonly EntryRecord[]
}

/** An appended assistant wins over a later live handover; only an empty transcript needs live. */
function identityFor(
  live: Option.Option<Readonly<LiveState>>,
  receipt: ResolvedRun['receipt'],
  entries: readonly EntryRecord[],
): AssistantIdentity {
  const assistant = entries.find((entry) => entry.kind === 'pi.assistant')
  if (assistant !== undefined) return entryIdentity(assistant)
  if (
    Option.isSome(live) &&
    live.value.run !== undefined &&
    live.value.run.inputs[0] === receipt.id
  )
    return AssistantIdentity.Generated({ taskId: live.value.run.taskId })
  return AssistantIdentity.Empty({ entryId: receipt.entry })
}

/** Closed lookup has exactly one candidate: the idle-admitted receipt immediately before T.
 * SQLite/PostgreSQL concurrency proofs cover Session's serialized admission commit. Verification
 * below checks conversation, placement and assistant attribution; arithmetic alone proves nothing. */
function candidateOf(messageId: string) {
  const found = /^gen:([1-9][0-9]*)$/u.exec(messageId)
  return found === null ? Option.none<SubmissionId>() : decodeSubmission(Number(found[1]) - 1)
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

/** Read live BEFORE entries: handover cannot precede the first appended assistant. Once that
 * entry exists its task wins, even when the live read saw a successor or no active run. Empty
 * settled runs have no durable generation attribution and are explicitly input:<entry>, never
 * a guessed task. This resolver serves event ingress, snapshots, stored replay and settlements. */
export const resolveRunIdentity: (
  reader: Reader,
  inputs: readonly SubmissionId[],
) => Effect.Effect<ResolvedRun, RunMissing | PiFailed> = Effect.fn('Durable.resolveRunIdentity')(
  function* (reader: Reader, inputs: readonly SubmissionId[]) {
    const live = yield* Pi.snapshot(reader.harness, LiveDoc, reader.conversation.id, reader.context)
    const first = inputs[0]
    if (first === undefined)
      return yield* new RunMissing({ conversationId: reader.conversation.id })
    const handle = yield* Pi.submission(reader.harness, first, reader.context)
    if (Option.isNone(handle))
      return yield* new RunMissing({ conversationId: reader.conversation.id })
    const receipt = yield* Pi.status(handle.value, reader.context)
    if (!placedFor(receipt, reader.conversation.id))
      return yield* new RunMissing({ conversationId: reader.conversation.id })
    const entries = closedEntries(
      yield* entriesOf(reader, { first: receipt.entry, last: Option.none() }),
      receipt,
    )
    return { messageId: assistantMessageId(identityFor(live, receipt, entries)), receipt, entries }
  },
)

/** Bound whole-run attachment to its first placed input, never the newest steer or an older run. */
export const captureRun: (
  reader: Reader,
  snapshot: SnapshotEvent,
) => Effect.Effect<RunSnapshot, RunMissing | PiFailed> = Effect.fn('Durable.captureRun')(function* (
  reader: Reader,
  snapshot: SnapshotEvent,
) {
  if (snapshot.run === undefined) return { ...snapshot, messageId: Option.none() }
  const resolved = yield* resolveRunIdentity(reader, snapshot.run.inputs)
  const { receipt } = resolved
  const messageId = Option.some(resolved.messageId)
  // Usually the atomic model view contains the whole run. Compaction can remove its first input;
  // recover raw entries only then, bounded by the snapshot's tail so the prefix cannot outrun events.
  if (snapshot.entries.some((entry) => entry.id === receipt.entry))
    return {
      ...snapshot,
      messageId,
      entries: snapshot.entries.filter((entry) => entry.id >= receipt.entry),
    }
  const tail = Option.fromNullishOr(snapshot.entries.at(-1))
  if (Option.isNone(tail)) return yield* new RunMissing({ conversationId: reader.conversation.id })
  const entries = resolved.entries.filter((entry) => entry.id <= tail.value.id)
  return { ...snapshot, messageId, entries }
})

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
  const resolved = yield* resolveRunIdentity(reader, [receipt.id])
  const { entries, messageId: identity } = resolved
  const found = replay({
    ...base,
    entries,
    messageId: Option.some(identity),
    run: { inputs: [receipt.id] },
  })
  if (Option.isNone(found)) return yield* new RunMissing({ conversationId: reader.conversation.id })
  const prefix = found.value
  const closed = closeRun(prefix.state, identity)
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
function ownsActiveRun(snapshot: RunSnapshot, messageId: string) {
  return snapshot.run !== undefined && Option.contains(snapshot.messageId, messageId)
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
  const activeSnapshot = yield* captureRun(reader, snapshot)
  const active = ownsActiveRun(activeSnapshot, input.messageId)
  if (active) {
    const prefix = replayAfter(activeSnapshot, input.known)
    if (Option.isNone(prefix))
      return yield* new RunMissing({ conversationId: reader.conversation.id })
    return Option.some({ ...prefix.value, known: input.known })
  }
  const id = candidateOf(input.messageId)
  if (Option.isNone(id)) return yield* new RunMissing({ conversationId: reader.conversation.id })
  const handle = yield* Pi.submission(reader.harness, id.value, reader.context)
  if (Option.isNone(handle))
    return yield* new RunMissing({ conversationId: reader.conversation.id })
  const receipt = yield* Pi.status(handle.value, reader.context)
  if (!placedFor(receipt, reader.conversation.id) || !resumable(receipt, false))
    return yield* new RunMissing({ conversationId: reader.conversation.id })
  const placed = yield* entriesOf(reader, {
    first: receipt.entry,
    last: Option.none(),
  })
  const entries = closedEntries(placed, receipt)
  const assistant = entries.find((entry) => entry.kind === 'pi.assistant')
  if (
    assistant === undefined ||
    assistant.byTaskId === undefined ||
    assistantMessageId(AssistantIdentity.Generated({ taskId: assistant.byTaskId })) !==
      input.messageId
  )
    return yield* new RunMissing({ conversationId: reader.conversation.id })
  // A completed run must not borrow the newer run's generation or live continuation.
  const { run: _run, generation: _generation, ...stored } = snapshot
  const captured: RunSnapshot = { ...stored, entries, messageId: Option.some(input.messageId) }
  const prefix = replayAfter(captured, input.known)
  if (Option.isNone(prefix))
    return yield* new RunMissing({ conversationId: reader.conversation.id })
  return Option.some(completed(input, prefix.value, rebuild(entries), intent))
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
            messageMetadata: messageMetadata(stored.state.metadata, stored.state.failure),
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
          messageMetadata: messageMetadata(stored.state.metadata, stored.state.failure),
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
