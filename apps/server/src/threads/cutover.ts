import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { Effect } from 'effect'
import { Database, decodeStored, encodeStored } from '../database/client.ts'
import { Admitted, StoredReceipt } from './conversation.ts'
import { runs, threads } from './tables.ts'

const decodeReceipt = decodeStored(StoredReceipt, 'Run cutover receipt')
const decodeAdmission = decodeStored(Admitted, 'imported Run admission')
const encodeAdmission = encodeStored(Admitted, 'Run admission receipt')

/**
 * The cutover's sole cross-owner read is runtime.imported_submissions, written by the Flue
 * importer. Scope mappings to the Thread creator who owns its runtime history, not the Run's
 * acting Person. Keep product ids and every referencing row intact. Lock each Thread and commit
 * all its receipt changes together; reruns skip Pi receipts and recover after any prior Thread.
 * Run while serving is stopped, after import and before starting Pi and the server.
 */
export const cutoverReceipts = Effect.fn('Threads.cutoverReceipts')(function* () {
  const database = yield* Database
  const owners = yield* database.run(database.select({ id: threads.id }).from(threads))
  const totals = { threads: 0, mapped: 0, unmapped: 0 }
  for (const owner of owners) {
    const counts = yield* database.transaction((tx) =>
      Effect.gen(function* () {
        const [thread] = yield* tx
          .select({ personId: threads.personId })
          .from(threads)
          .where(eq(threads.id, owner.id))
          .for('update')
        if (thread === undefined) return { mapped: 0, unmapped: 0 }
        const rows = yield* tx
          .select({ id: runs.id, receipt: runs.receipt })
          .from(runs)
          .where(and(eq(runs.threadId, owner.id), isNotNull(runs.receipt)))
        const counts = { mapped: 0, unmapped: 0 }
        for (const row of rows) {
          const receipt = yield* decodeReceipt(row.receipt)
          if (StoredReceipt.guards.Pi(receipt)) continue
          const [mapping] = yield* tx
            .select({ submissionId: sql<string>`submission_id` })
            .from(sql`runtime.imported_submissions`)
            .where(sql`person_id = ${thread.personId} and flue_submission_id = ${receipt.runId}`)
          if (mapping === undefined) {
            counts.unmapped++
            continue
          }
          const admitted = yield* decodeAdmission({ runId: receipt.runId, ...mapping })
          yield* tx
            .update(runs)
            .set({ receipt: yield* encodeAdmission(admitted) })
            .where(eq(runs.id, row.id))
          counts.mapped++
        }
        return counts
      }),
    )
    totals.threads++
    totals.mapped += counts.mapped
    totals.unmapped += counts.unmapped
  }
  yield* Effect.logInfo('Run receipt cutover complete', totals)
  return totals
})
