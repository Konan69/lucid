import * as NodeAssert from 'node:assert/strict'
import * as NodeFSP from 'node:fs/promises'
import { command } from './process.mjs'
import { observe } from './observation.mjs'
import { connectPulse } from './watch.mjs'
import { providerSnapshot } from './snapshot.mjs'
import { chat, history, json, rpc, settled } from './wire.mjs'

/** The journal's rows for one Thread, read-only from the disposable database. */
async function journal(state, thread, directory) {
  NodeAssert.match(thread, /^[0-9a-f-]{36}$/)
  const output = await command([
    'docker',
    'exec',
    state.container,
    'psql',
    '-U',
    'verify',
    '-d',
    'verify',
    '-At',
    '-c',
    `SELECT coalesce(json_agg(row_to_json(t)), '[]'::json) FROM (SELECT * FROM vivid_actions WHERE thread_id='${thread}') t;`,
  ])
  const rows = JSON.parse(output)
  await json(directory + '/vivid_actions.json', rows)
  return rows
}

/** Whether the Thread's one Run now carries the acting Person's delivery receipt. */
const isDelivered = (detail) =>
  detail.runs.length === 1 &&
  detail.runs[0].outcome !== null &&
  detail.runs[0].outcome._tag === 'Delivered'

/** The Thread as the server publishes it, at its first publication with the receipt. */
const delivery = (state, thread) =>
  observe(state, { tag: 'WatchThread', payload: { id: thread }, accept: isDelivered })

/**
 * One outward write by the real model through the disposable Verify Pulse Integration, allowed by
 * the Person's own rule so it runs without a decision. Proves the write is journaled under the
 * runtime's call identity with a Completed receipt, that the provider saw it exactly once, that a
 * read-only reconciliation reports it Applied without sending again, and that the Run's outcome
 * moves from Completed to Delivered only on the acting Person's own acknowledgement: over HTTP by
 * AcknowledgeRunDelivery, in the browser by the Thread screen drawing the reply.
 */
export async function outcome(state, id, directory, browser) {
  NodeAssert.equal(state.modelKind, 'real')
  const integration = await connectPulse(state, directory)
  let rule
  try {
    rule = (
      await rpc(
        state,
        'CreateRule',
        {
          action: 'Produce a verification pulse with Verify Pulse',
          decision: 'Allow',
          scope: { _tag: 'Personal' },
        },
        directory,
      )
    ).rule
    const receipt = crypto.randomUUID()
    const prompt = `Using my Verify Pulse Integration, produce one pulse with receipt ${receipt} and words outcome-verification. Discover its emit operation with find_tools, then call it directly with use_tool, once. Do not use run_code or create a Watch. Then tell me in one sentence what the result shows.`
    if (browser) {
      await browser.run(['find', 'label', 'Message Vivid', 'fill', prompt])
      await browser.run(['find', 'role', 'button', 'click', '--name', 'Send', '--exact'])
    } else await chat(state, id, prompt, directory)
    const done = await settled(state, id, 1, 'Completed', directory)
    NodeAssert.equal(done.approvals.length, 0, 'The Allow rule must let the write run unasked')
    const [run] = done.runs
    const external = await providerSnapshot(
      state,
      { callback: state.web + '/unused-outcome-callback', receipt },
      directory,
    )
    NodeAssert.equal(external.events.length, 1, 'The provider must see exactly one pulse')
    const rows = await journal(state, id, directory)
    NodeAssert.equal(rows.length, 1, 'Exactly one outward operation is journaled')
    const [row] = rows
    NodeAssert.ok(row.id.startsWith(`call-${id}-`), 'The operation is named by the runtime call')
    NodeAssert.equal(row.run_id, run.id)
    NodeAssert.equal(row.approval_id, null)
    NodeAssert.equal(row.receipt._tag, 'Completed')
    NodeAssert.equal(row.receipt.operationId, row.id)
    const reconciled = await rpc(state, 'ReconcileAction', { operationId: row.id }, directory)
    NodeAssert.equal(reconciled.reconciliation._tag, 'Applied')
    NodeAssert.equal(reconciled.reconciliation.receipt.operationId, row.id)
    NodeAssert.equal(reconciled.action.phase._tag, 'Settled')
    const me = await rpc(state, 'Me', undefined, directory)
    let delivered
    if (browser) {
      // The open Thread screen acknowledges the reply it drew; nothing is pressed.
      delivered = await delivery(state, id)
      await browser.capture('delivered')
      await browser.run(['reload'])
      await browser.run(['wait', '[aria-label="Message Vivid"]'])
      await browser.capture('reloaded')
    } else {
      NodeAssert.equal(run.outcome._tag, 'Completed', 'Before acknowledgement the Run is Completed')
      const acknowledgement = { runId: run.id, responseId: run.outcome.responseId }
      await rpc(state, 'AcknowledgeRunDelivery', acknowledgement, directory, 'acknowledge')
      delivered = await delivery(state, id)
      await rpc(state, 'AcknowledgeRunDelivery', acknowledgement, directory, 'acknowledge-again')
    }
    const final = await rpc(state, 'GetThread', { id }, directory)
    const ended = final.runs[0].outcome
    NodeAssert.equal(ended._tag, 'Delivered')
    NodeAssert.deepEqual(
      ended,
      delivered.runs[0].outcome,
      'A repeat acknowledgement changes nothing',
    )
    NodeAssert.equal(ended.receipt._tag, 'Thread')
    NodeAssert.equal(ended.receipt.person.id, me.person.id)
    NodeAssert.equal(ended.receipt.responseId, ended.responseId)
    await NodeFSP.mkdir(directory + '/after', { recursive: true })
    const after = await providerSnapshot(
      state,
      { callback: state.web + '/unused-outcome-callback', receipt },
      directory + '/after',
    )
    NodeAssert.equal(after.events.length, 1, 'Reconciling and acknowledging send nothing')
    await history(state, id, directory)
    await json(directory + '/proof.json', { run: final.runs[0], operation: reconciled, external })
  } finally {
    if (rule) await rpc(state, 'DeleteRule', { id: rule.id }, directory)
    await rpc(state, 'RemoveConnection', { id: integration.connection.id }, directory)
  }
}
