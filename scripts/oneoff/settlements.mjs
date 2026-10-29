import assert from 'node:assert/strict'
import { Effect, Schema } from 'effect'
import { RuntimeSettlement } from '../../packages/contracts/src/index.ts'

const decode = Schema.decodeUnknownEffect(RuntimeSettlement)

/** The copied product failure category must agree with the imported cell's terminal receipt. */
export async function proveSettlements(state, database, loaded, bearer, json) {
  const rows = (
    await database.query(
      "SELECT id, thread_id, failure_reason, receipt FROM vivid_runs WHERE state='failed' ORDER BY id",
    )
  ).rows
  const receipts = []
  for (const row of rows) {
    if (row.receipt === null) continue
    const thread = loaded.find((thread) => thread.threadId === row.thread_id)
    assert.ok(thread)
    const response = await fetch(
      `http://127.0.0.1:${state.ports.runtime}/persons/${thread.personId}/threads/${thread.threadId}/submissions/${row.receipt.submissionId}`,
      { headers: { authorization: `Bearer ${bearer}` } },
    )
    assert.equal(response.status, 200)
    const settlement = await Effect.runPromise(decode(await response.json()))
    receipts.push({ runId: row.id, storedFailure: row.failure_reason, settlement })
    await json('failed-settlements', receipts)
    assert.ok(RuntimeSettlement.guards.Failed(settlement))
    if (row.failure_reason !== null) assert.equal(settlement.failure, row.failure_reason)
  }
  return { checked: receipts.length, receiptless: rows.length - receipts.length }
}
