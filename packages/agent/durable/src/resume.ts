import type { Cursor, EntryRecord, SnapshotEvent, SubmissionId } from '@earendil-works/pi-durable'
import { Effect, Option, Predicate, Schema } from 'effect'
import { replayAfter, runMessageId } from './chunks.ts'
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

/** Resolve the exact first input through Pi's public receipt before matching any known tool call. */
export const selectRun = Effect.fn('Durable.selectResumeRun')(function* (
  reader: Reader,
  input: ResumeInput,
  snapshot: SnapshotEvent,
) {
  const id = inputOf(input.messageId)
  if (Option.isNone(id)) return yield* new RunMissing({ conversationId: reader.conversation.id })
  const handle = yield* Pi.submission(reader.harness, id.value, reader.context)
  if (Option.isNone(handle))
    return yield* new RunMissing({ conversationId: reader.conversation.id })
  const receipt = yield* Pi.status(handle.value, reader.context)
  const active = snapshot.run !== undefined && input.messageId === runMessageId(snapshot.run.inputs)
  if (
    receipt.conversationId !== reader.conversation.id ||
    receipt.type !== 'input' ||
    receipt.entry === undefined ||
    (!active && receipt.status !== 'done')
  )
    return yield* new RunMissing({ conversationId: reader.conversation.id })
  const entries = yield* entriesOf(reader, {
    first: receipt.entry,
    last: receipt.status === 'done' ? Option.some(receipt.answer) : Option.none(),
  })
  // A completed run must not borrow the newer run's generation or live continuation.
  const { run: _run, generation: _generation, ...stored } = snapshot
  const captured = active ? { ...snapshot, entries } : { ...stored, entries }
  const prefix = replayAfter(captured, input.known)
  if (Option.isNone(prefix))
    return yield* new RunMissing({ conversationId: reader.conversation.id })
  return Option.some({ ...prefix.value, known: input.known })
})
