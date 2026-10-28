import * as NodeCrypto from 'node:crypto'
import * as NodeAssert from 'node:assert/strict'
import { Redacted, Schema } from 'effect'
import { ConnectionState, ConnectionStep, WatchState, RunOrigin } from '@vivid/contracts'
import { observe } from './observation.mjs'
import { decodeText } from './receipts.mjs'
import { rpc, chat, history, settled, json } from './wire.mjs'
import { command } from './process.mjs'
import { providerSnapshot } from './snapshot.mjs'
import { ExecutorApp, ExecutorTools, ExecutorResult, executorRequest } from './executor.mjs'
import { authSecret } from './settings.mjs'

const rowSchemas = {
  vivid_connections: Schema.Struct({ executor_app: Schema.NonEmptyString }),
  vivid_watches: Schema.Struct({
    id: Schema.String,
    state: Schema.String,
    callback_url: Schema.String,
  }),
  vivid_runs: Schema.Struct({
    id: Schema.String,
    thread_id: Schema.String,
    state: Schema.String,
    origin: Schema.Json,
  }),
}

/** Receiver.threadOf derives this stable background identity on main and PR 77. Compare it
 * with the public Feed and SQL, so the event receipt cannot be mistaken for another occurrence. */
const threadFor = (watchId, receipt) =>
  'watch-' +
  NodeCrypto.createHash('sha256')
    .update(watchId + '\n' + receipt)
    .digest('hex')
    .slice(0, 32)

/** SQL is observation only, against the run-owned disposable container. Identifiers are generated UUIDs. */
export async function watchRows(state, { table, field, id }, directory, name) {
  NodeAssert.ok(Object.hasOwn(rowSchemas, table))
  NodeAssert.ok(['id', 'watch_id', 'thread_id'].includes(field))
  NodeAssert.match(id, /^[a-zA-Z0-9_-]+$/)
  const rows = decodeText(
    Schema.Array(rowSchemas[table]),
    await command([
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
      `SELECT coalesce(json_agg(row_to_json(t)), '[]'::json) FROM (SELECT * FROM ${table} WHERE ${field}='${id}') t`,
    ]),
  )
  await json(directory + '/' + name + '.json', rows)
  return rows
}

/** The public live Feed carries the typed delivery receipt. A deadline can fail, never pass. */
async function posted(state, marker, directory) {
  const hasMarker = (candidate) => candidate.post && candidate.post.title.includes(marker)
  const feed = await observe(state, {
    tag: 'WatchFeed',
    payload: null,
    accept: (publication) => publication.items.some(hasMarker),
  })
  await json(directory + '/delivered-feed.json', feed)
  return feed.items.find(hasMarker)
}

/** Name lookup and Begin are the same public Connect path as Settings; no selection is seeded. */
export async function connectPulse(state, directory) {
  NodeAssert.equal(state.modelKind, 'real', 'Watch needs a real model')
  const services = await rpc(state, 'FindServices', { query: 'Verify Pulse' }, directory)
  NodeAssert.ok(services.services.some((service) => service.id === 'verify-pulse'))
  const begun = await rpc(
    state,
    'BeginConnection',
    { service: 'verify-pulse', from: 'Web', name: null, shared: false },
    directory,
  )
  NodeAssert.ok(ConnectionStep.guards.EnterKey(begun))
  const connected = await rpc(state, 'CompleteConnection', {
    id: begun.connection.id,
    fields: { code: Redacted.make('verify-pulse-local') },
  })
  NodeAssert.ok(ConnectionState.guards.Ready(connected.connection.state))
  return integrationOf(state, connected.connection, directory)
}

/** Observe the dedicated app Vivid claimed, after either HTTP or browser Connect. */
export async function integrationOf(state, connection, directory) {
  const rows = await watchRows(
    state,
    { table: 'vivid_connections', field: 'id', id: connection.id },
    directory,
    'connection',
  )
  const app = rows[0].executor_app
  NodeAssert.ok(app, 'Connect did not claim a dedicated app')
  const record = await executorRequest(state, '/apps/' + encodeURIComponent(app), {
    schema: ExecutorApp,
  })
  await json(directory + '/integration.json', { connection, app: record.id, slug: record.slug })
  return { connection, app: record.id }
}

/** Only the model makes the Watch. Its durable tool calls must include discovery and subscription. */
export function watchWords(marker) {
  return `Watch pulse.received in my Verify Pulse Integration. First find its available events, then start one Watch named ${marker}. Every time it fires, post to my Feed with title ${marker}, the event's receipt and words drawn in the card itself and no sentence beside them. Do not emit any event yourself. Confirm when the Watch is active.`
}

/** An external provider invokes Executor directly, outside every Vivid tool and approval adapter. */
async function emit(state, { app, marker, name }, directory) {
  const tools = await executorRequest(state, '/apps/' + encodeURIComponent(app) + '/tools', {
    schema: ExecutorTools,
  })
  const tool = tools.items.find((candidate) => candidate.name === 'emit')
  NodeAssert.ok(tool, 'Executor app has no emitting operation')
  const receipt = crypto.randomUUID()
  const result = await executorRequest(state, '/apps/' + encodeURIComponent(app) + '/tools/call', {
    schema: ExecutorResult,
    body: {
      version: tools.version,
      kind: 'mutation',
      tool: tool.name,
      input: { receipt, words: marker },
    },
  })
  await json(directory + '/' + name + '.json', { receipt, app, result })
  return receipt
}

/** One real occurrence must publish a completed background Run and a model-authored Feed item. */
export async function occurrence(state, { id, integration, marker }, directory) {
  await settled(state, id, 1, 'Completed', directory)
  const page = await history(state, id, directory)
  const tools = page.messages
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => message.parts)
    .filter((part) => part.type === 'dynamic-tool' && part.state === 'output-available')
  for (const name of ['find_events', 'watch'])
    NodeAssert.ok(
      tools.some((tool) => tool.toolName === name),
      'Model did not call ' + name,
    )
  const watches = await rpc(state, 'ListWatches', undefined, directory)
  const watching = watches.watches.find((candidate) => candidate.name === marker)
  NodeAssert.ok(watching, 'Model did not create the named Watch')
  NodeAssert.ok(WatchState.guards.Active(watching.state))
  const receipt = await emit(
    state,
    { app: integration.app, marker, name: 'provider-receipt' },
    directory,
  )
  const item = await posted(state, marker, directory)
  // The card is the drawing: the receipt is in its display and it carries no words beside it.
  NodeAssert.equal(item.post.words, null, 'Feed card repeated its drawing in words')
  NodeAssert.ok(
    item.post.display !== null && item.post.display.includes(receipt),
    'Feed display did not draw the receipt',
  )
  const detail = await settled(state, item.thread, 1, 'Completed', directory)
  NodeAssert.ok(RunOrigin.guards.Watch(detail.runs[0].origin))
  NodeAssert.equal(item.thread, threadFor(watching.id, receipt))
  const runs = await watchRows(
    state,
    { table: 'vivid_runs', field: 'thread_id', id: item.thread },
    directory,
    'background-runs',
  )
  NodeAssert.equal(runs.length, 1)
  NodeAssert.equal(runs[0].id, detail.runs[0].id)
  await history(state, item.thread, directory, 'background-history')
  const evidence = {
    receipt,
    watch: watching.id,
    run: detail.runs[0].id,
    feed: item.card,
    item,
    background: item.thread,
    connection: integration.connection.id,
    app: integration.app,
  }
  await json(directory + '/proof.json', evidence)
  return evidence
}

/** An unrelated provider-side account preserves the app under Vivid's actual reclamation policy.
 * The Watch still belongs to the removed Connection, so a later real event must not wake it.
 * Without this account ordinary Remove deletes the app and makes a second emit impossible. */
async function retainEmitter(state, proof, directory) {
  const Resource = Schema.Struct({ id: Schema.String })
  const started = await executorRequest(
    state,
    `/apps/${encodeURIComponent(proof.app)}/accounts/user/pulse/connections`,
    { schema: Resource, body: {} },
  )
  const saved = await executorRequest(
    state,
    `/connections/${encodeURIComponent(started.id)}/submit`,
    {
      schema: Resource,
      body: {
        method: 'key',
        label: 'Independent provider account',
        fields: { code: 'verify-pulse-independent' },
      },
    },
  )
  await json(directory + '/retained-emitter.json', {
    app: proof.app,
    independentAccount: saved.id,
    reason: 'An unrelated account link prevents Vivid from deleting provider-owned resources.',
  })
}

/** A fresh signed delivery must receive Executor's terminal status even after the cascade
 * deletes the Watch. Repeat the second event id so the baseline observes one unwanted Run. */
async function removedDelivery(proof, { callback, receipt }, directory) {
  const signed = {
    id: crypto.randomUUID(),
    timestamp: String(Math.floor(Date.now() / 1000)),
    body: JSON.stringify({
      eventId: receipt,
      name: 'pulse.received',
      timestamp: new Date().toISOString(),
      data: { receipt, words: 'After removal' },
    }),
  }
  const secret = NodeCrypto.createHmac('sha256', authSecret)
    .update('vivid/watch/' + proof.watch)
    .digest()
  const signature = NodeCrypto.createHmac('sha256', secret)
    .update(`${signed.id}.${signed.timestamp}.${signed.body}`)
    .digest('base64')
  const response = await fetch(callback, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'webhook-id': signed.id,
      'webhook-timestamp': signed.timestamp,
      'webhook-signature': 'v1,' + signature,
    },
    body: signed.body,
    signal: AbortSignal.timeout(30_000),
  })
  await json(directory + '/removed-delivery.json', {
    watch: proof.watch,
    receipt,
    callback,
    status: response.status,
  })
  if (response.body !== null) await response.body.cancel()
  return response.status
}

/** Keep every assertion on the baseline. The provider's exported committed state proves
 * no live subscription and no queued delivery, so absence of a Run needs no quiet-time sleep. */
export async function disconnected(state, proof, directory, remove) {
  const active = await watchRows(
    state,
    { table: 'vivid_watches', field: 'id', id: proof.watch },
    directory,
    'active-watch',
  )
  NodeAssert.equal(active.length, 1)
  const callback = active[0].callback_url
  await retainEmitter(state, proof, directory)
  await remove()
  const rows = await watchRows(
    state,
    { table: 'vivid_watches', field: 'id', id: proof.watch },
    directory,
    'removed-watch',
  )
  const receipt = await emit(
    state,
    { app: proof.app, marker: 'After removal', name: 'after-remove' },
    directory,
  )
  if (rows.some((row) => row.state === 'Active')) {
    const item = await posted(state, receipt, directory)
    await settled(state, item.thread, 1, 'Completed', directory)
  }
  const status = await removedDelivery(proof, { callback, receipt }, directory)
  const provider = await providerSnapshot(state, { callback, receipt }, directory)
  const runs = await watchRows(
    state,
    { table: 'vivid_runs', field: 'thread_id', id: threadFor(proof.watch, receipt) },
    directory,
    'after-remove-runs',
  )
  const assertions = {
    watchRemoved: rows.length === 0,
    signedDeliveryGone: status === 410,
    noLiveSubscription: provider.subscriptions.every((row) => row.status !== 'active'),
    furtherReceipt: receipt,
    providerEventStored: provider.events.length === 1,
    noQueuedDelivery: provider.deliveries.length === 0,
    noNewRun: runs.length === 0,
  }
  await json(directory + '/post-removal.json', assertions)
  NodeAssert.equal(assertions.watchRemoved, true, 'Removing the Integration left its Watch Active')
  NodeAssert.equal(assertions.signedDeliveryGone, true, 'Signed delivery must answer 410')
  NodeAssert.equal(assertions.noLiveSubscription, true, 'Executor retained a live subscription')
  NodeAssert.equal(
    assertions.providerEventStored,
    true,
    'Provider did not persist the second event',
  )
  NodeAssert.equal(
    assertions.noQueuedDelivery,
    true,
    'Provider queued the event for the removed Watch',
  )
  NodeAssert.equal(assertions.noNewRun, true, 'Removal admitted another background Run')
}

/** HTTP journey uses the real prompt and tools, then the same public Remove as the browser. */
export async function watch(state, id, directory) {
  const integration = await connectPulse(state, directory)
  const marker = 'Pulse ' + crypto.randomUUID().slice(0, 8)
  await chat(state, id, watchWords(marker), directory)
  const proof = await occurrence(state, { id, integration, marker }, directory)
  await disconnected(state, proof, directory, () =>
    rpc(state, 'RemoveConnection', { id: integration.connection.id }, directory),
  )
}
