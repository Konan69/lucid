import * as NodeAssert from 'node:assert/strict'
import * as NodeFSP from 'node:fs/promises'
import { command } from './process.mjs'
import { WatchState } from '@vivid/contracts'
import { observe } from './observation.mjs'
import { connectPulse, emit, posted, threadFor, watchWords } from './watch.mjs'
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
 * Background work reaches the Person on the Feed, not in a Thread they open. The real model makes
 * a Watch that posts each pulse to the Feed; the provider emits one directly; the background Run
 * posts its card and completes. Nothing has drawn the card yet (HTTP draws nothing; the browser
 * stays on a Thread screen), so the Run must be Completed, not Delivered. Then the Person's Feed
 * draws it: over HTTP the `MarkFeedCard` seen report both clients send once the whole card is in
 * view, in the browser the Feed screen itself. The Run becomes Delivered with a `Feed` receipt
 * naming the signed-in Person and the card, and a repeated report changes nothing.
 */
async function feedDelivery(state, { integration, me }, directory, browser) {
  const path = directory + '/feed'
  await NodeFSP.mkdir(path, { recursive: true })
  const thread = crypto.randomUUID()
  await rpc(
    state,
    'CreateThread',
    { id: thread, title: 'Verify Feed delivery', projectId: null },
    path,
  )
  const marker = 'Outcome ' + crypto.randomUUID().slice(0, 8)
  if (browser) {
    await browser.run(['open', state.web + '/t/' + thread])
    await browser.run(['wait', '[aria-label="Message Vivid"]'])
    await browser.run(['find', 'label', 'Message Vivid', 'fill', watchWords(marker)])
    await browser.run(['find', 'role', 'button', 'click', '--name', 'Send', '--exact'])
  } else await chat(state, thread, watchWords(marker), path)
  await settled(state, thread, 1, 'Completed', path)
  const { watches } = await rpc(state, 'ListWatches', undefined, path)
  const watching = watches.find((candidate) => candidate.name === marker)
  NodeAssert.ok(watching && WatchState.guards.Active(watching.state), 'Model made no active Watch')
  const receipt = await emit(
    state,
    { app: integration.app, words: 'outcome feed delivery', name: 'provider-receipt' },
    path,
  )
  const published = await posted(state, threadFor(watching.id, receipt), path)
  const away = await settled(state, published.thread, 1, 'Completed', path)
  // Posting can publish a Working card before the Run commits its completed outcome.
  const feed = await rpc(state, 'ListFeed', undefined, path)
  const item = feed.items.find((candidate) => candidate.card === published.card)
  NodeAssert.ok(item, 'The posted card remains on the Feed after settlement')
  NodeAssert.equal(item._tag, 'Waiting', 'The posted card waits on the Person')
  NodeAssert.equal(item.seen, false)
  const [run] = away.runs
  NodeAssert.equal(item.post.provenance.postedBy, run.id, 'The background Run posted the card')
  NodeAssert.equal(run.outcome._tag, 'Completed', 'Undrawn, the result is only Completed')
  await json(path + '/away.json', away)
  const report = { card: item.card, state: 'seen' }
  let delivered
  if (browser) {
    // The Feed screen reports the card once all of it is in view; nothing is pressed.
    await browser.run(['open', state.web + '/feed'])
    const card = `document.querySelector('article[aria-label=${JSON.stringify(JSON.stringify(marker)).slice(1, -1)}]')`
    await browser.run(['wait', '--fn', `${card} !== null`])
    delivered = await delivery(state, item.thread)
    await browser.capture('feed-delivered')
    await browser.run(['reload'])
    await browser.run(['wait', '--fn', `${card} !== null`])
    await browser.capture('feed-reloaded')
  } else {
    await rpc(state, 'MarkFeedCard', report, path, 'mark-seen')
    delivered = await delivery(state, item.thread)
    await rpc(state, 'MarkFeedCard', report, path, 'mark-seen-again')
  }
  const final = await rpc(state, 'GetThread', { id: item.thread }, path)
  const ended = final.runs[0].outcome
  NodeAssert.equal(ended._tag, 'Delivered')
  NodeAssert.deepEqual(ended, delivered.runs[0].outcome, 'A repeated report changes nothing')
  NodeAssert.equal(ended.responseId, run.outcome.responseId)
  NodeAssert.equal(ended.receipt._tag, 'Feed')
  NodeAssert.equal(ended.receipt.person.id, me.person.id)
  NodeAssert.equal(ended.receipt.card, item.card)
  await json(path + '/proof.json', {
    receipt,
    watch: watching.id,
    item,
    away: run,
    run: final.runs[0],
  })
}

/**
 * One outward write by the real model through the disposable Verify Pulse Integration, allowed by
 * the Person's own rule so it runs without a decision. Proves the write is journaled under the
 * runtime's call identity with a Completed receipt, that the provider saw it exactly once, that a
 * read-only reconciliation reports it Applied without sending again, and that the Run's outcome
 * moves from Completed to Delivered only on the acting Person's own acknowledgement: over HTTP by
 * AcknowledgeRunDelivery, in the browser by the Thread screen drawing the reply. Then the same for
 * a background result on the Feed (`feedDelivery`).
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
    await feedDelivery(state, { integration, me }, directory, browser)
  } finally {
    if (rule) await rpc(state, 'DeleteRule', { id: rule.id }, directory)
    await rpc(state, 'RemoveConnection', { id: integration.connection.id }, directory)
  }
}
