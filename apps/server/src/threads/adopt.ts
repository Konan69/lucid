import { RuntimeHistoryMap, ThreadId, RunId, PersonId } from '@vivid/contracts'
import { and, eq } from 'drizzle-orm'
import { Effect, Option, Schema } from 'effect'
import { Database, decodeStored, encodeStored } from '../database/client.ts'
import { Admitted } from './conversation.ts'
import { runs, threads } from './tables.ts'

/** Refusals name the invalid relation without printing any stored receipt payload. */
export class HistoryThreadMissing extends Schema.TaggedError<HistoryThreadMissing>()(
  'HistoryThreadMissing',
  { threadId: ThreadId },
  { title: 'History map names an unknown Thread' },
) {}
export class HistoryCreatorMismatch extends Schema.TaggedError<HistoryCreatorMismatch>()(
  'HistoryCreatorMismatch',
  { threadId: ThreadId, personId: PersonId },
  { title: 'History map names the wrong creator' },
) {}
export class HistoryMapDuplicate extends Schema.TaggedError<HistoryMapDuplicate>()(
  'HistoryMapDuplicate',
  { threadId: ThreadId },
  { title: 'History map repeats a Thread or delivery' },
) {}
export class HistoryReceiptMismatch extends Schema.TaggedError<HistoryReceiptMismatch>()(
  'HistoryReceiptMismatch',
  { threadId: ThreadId, runId: RunId },
  { title: 'Receipt names another Run' },
) {}

/** Earlier admission receipts are understood only at this one-time boundary. */
const EarlierReceipt = Schema.Struct({
  runId: RunId,
  offset: Schema.String,
  incarnation: Schema.String,
})
const decodeEarlier = decodeStored(EarlierReceipt, 'earlier admission receipt')
const currentReceipt = Schema.decodeUnknownOption(Admitted)
const encodeReceipt = encodeStored(Admitted, 'admission receipt')

/** One Thread is adopted atomically, including clearing earlier receipts absent from the map. */
const adoptThread = Effect.fn('Runs.adoptThread')(function* (
  personId: PersonId,
  threadId: ThreadId,
  deliveries: RuntimeHistoryMap[number]['deliveries'],
) {
  const database = yield* Database
  const mapped = new Map(deliveries.map((delivery) => [delivery.requestId, delivery.submissionId]))
  if (mapped.size !== deliveries.length) return yield* new HistoryMapDuplicate({ threadId })
  return yield* database.transaction((tx) =>
    Effect.gen(function* () {
      const owner = yield* tx
        .select({ personId: threads.personId })
        .from(threads)
        .where(eq(threads.id, threadId))
        .for('update')
      const first = owner[0]
      if (first === undefined) return yield* new HistoryThreadMissing({ threadId })
      if (first.personId !== personId)
        return yield* new HistoryCreatorMismatch({ threadId, personId })
      const rows = yield* tx.select().from(runs).where(eq(runs.threadId, threadId)).for('update')
      let changed = 0
      for (const run of rows) {
        if (run.receipt === null) continue
        const current = currentReceipt(run.receipt)
        if (Option.isSome(current)) {
          const receipt = current.value
          if (receipt.runId !== run.id)
            return yield* new HistoryReceiptMismatch({ threadId, runId: run.id })
          continue
        }
        const earlier = yield* decodeEarlier(run.receipt)
        const submissionId = mapped.get(earlier.runId)
        const receipt =
          submissionId === undefined
            ? null
            : yield* encodeReceipt(Admitted.make({ runId: run.id, submissionId }))
        yield* tx
          .update(runs)
          .set({ receipt })
          .where(and(eq(runs.threadId, threadId), eq(runs.id, run.id)))
        changed += 1
      }
      return changed
    }),
  )
})

/** Unmapped Threads still lose obsolete receipts. Current receipts survive a repeated adoption. */
export const adoptRuns = Effect.fn('Runs.adopt')(function* (map: RuntimeHistoryMap) {
  const database = yield* Database
  const all = yield* database.run(
    database.select({ threadId: threads.id, personId: threads.personId }).from(threads),
  )
  const mapped = new Map(map.map((thread) => [thread.threadId, thread]))
  const seen = new Set<ThreadId>()
  for (const thread of map) {
    const { threadId, personId } = thread
    if (seen.has(threadId)) return yield* new HistoryMapDuplicate({ threadId })
    seen.add(threadId)
    const stored = all.find((row) => row.threadId === threadId)
    if (stored === undefined) return yield* new HistoryThreadMissing({ threadId })
    if (stored.personId !== personId)
      return yield* new HistoryCreatorMismatch({ threadId, personId })
  }
  let changed = 0
  for (const thread of all) {
    const imported = mapped.get(thread.threadId)
    changed += yield* adoptThread(
      thread.personId,
      thread.threadId,
      imported === undefined ? [] : imported.deliveries,
    )
  }
  return changed
})
