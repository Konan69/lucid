import {
  DatabaseFailure,
  RuntimeHistoryMap,
  ThreadId,
  RunId,
  type PersonId,
} from '@vivid/contracts'
import { and, eq } from 'drizzle-orm'
import { Effect, Option, Schema } from 'effect'
import { Database, decodeStored, encodeStored } from '../database/client.ts'
import { Admitted } from './conversation.ts'
import { runs, threads } from './tables.ts'

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
  if (mapped.size !== deliveries.length)
    return yield* new DatabaseFailure({ message: 'Duplicate history delivery in map' })
  return yield* database.transaction((tx) =>
    Effect.gen(function* () {
      const owner = yield* tx
        .select({ personId: threads.personId })
        .from(threads)
        .where(eq(threads.id, threadId))
        .for('update')
      const first = owner[0]
      if (first === undefined || first.personId !== personId)
        return yield* new DatabaseFailure({
          message: 'History map does not match the Thread creator',
        })
      const rows = yield* tx.select().from(runs).where(eq(runs.threadId, threadId)).for('update')
      let changed = 0
      for (const run of rows) {
        if (run.receipt === null) continue
        const current = currentReceipt(run.receipt)
        if (Option.isSome(current)) {
          const receipt = current.value
          if (receipt.runId !== run.id)
            return yield* new DatabaseFailure({ message: 'Run receipt names another Run' })
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
  if (mapped.size !== map.length)
    return yield* new DatabaseFailure({ message: 'Duplicate Thread in history map' })
  for (const thread of map) {
    if (!all.some((row) => row.threadId === thread.threadId && row.personId === thread.personId))
      return yield* new DatabaseFailure({
        message: 'History map names an unknown Thread or creator',
      })
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
