import * as NodeCrypto from 'node:crypto'
import * as NodeAssert from 'node:assert/strict'
import * as NodeFSP from 'node:fs/promises'
import { Redacted, Schema } from 'effect'
import {
  BackgroundWork,
  ConnectionState,
  ConnectionStep,
  NotificationOpens,
  FeedCause,
  FeedEvidence,
  FeedProvenance,
  WatchState,
  WatchCondition,
  RunOrigin,
} from '@vivid/contracts'
import { observe } from './observation.mjs'
import { decodeText } from './receipts.mjs'
import { rpc, chat, history, settled, json } from './wire.mjs'
import { command } from './process.mjs'
import { providerSnapshot } from './snapshot.mjs'
import { ExecutorApp, ExecutorTools, ExecutorResult, executorRequest } from './executor.mjs'
import { authSecret } from './settings.mjs'
import { memberKey } from './member.mjs'

const rowSchemas = {
  vivid_connections: Schema.Struct({ executor_app: Schema.NonEmptyString }),
  vivid_watches: Schema.Struct({
    id: Schema.String,
    state: Schema.String,
    callback_url: Schema.String,
    condition: Schema.optionalKey(WatchCondition),
    state_data: Schema.optionalKey(Schema.NullOr(WatchState)),
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
export const threadFor = (watchId, receipt) =>
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
export async function posted(state, thread, directory) {
  const hasMarker = (candidate) => candidate.post && candidate.thread === thread
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

/** World apps follow the same public Connect flow as Pulse, including the masked secrets step. */
export async function connectWorld(state, directory, names = ['Mail', 'Calendar']) {
  NodeAssert.equal(state.modelKind, 'real', 'World behaviour needs a real model')
  const integrations = {}
  for (const name of names) {
    const service = name.toLowerCase()
    const services = await rpc(state, 'FindServices', { query: name })
    NodeAssert.ok(
      services.services.some((candidate) => candidate.id === service),
      name + ' not offered',
    )
    const begun = await rpc(state, 'BeginConnection', {
      service,
      from: 'Web',
      name: null,
      shared: false,
    })
    NodeAssert.ok(ConnectionStep.guards.EnterKey(begun))
    const connected = await rpc(state, 'CompleteConnection', {
      id: begun.connection.id,
      fields: { code: Redacted.make('world-local') },
    })
    NodeAssert.ok(ConnectionState.guards.Ready(connected.connection.state))
    const target = directory + '/' + service
    await NodeFSP.mkdir(target, { recursive: true })
    integrations[name] = await integrationOf(state, connected.connection, target)
  }
  return integrations
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

/** Only the model makes the Watch. Its durable tool calls must include discovery and subscription.
 * The last word of a pulse's words is a code past its first 4,000 characters, so the card can only
 * show it when the whole event reached the model. */
export function watchWords(marker) {
  return `Watch pulse.received in my Verify Pulse Integration. First find its available events, then start one Watch named ${marker}. Every time it fires, post to my Feed with title ${marker}, the event's receipt and the last word of its words drawn in the card itself and no sentence beside them. Do not emit any event yourself. Confirm when the Watch is active.`
}

/** A pulse's words longer than the 4,000 characters a tool result keeps, ending with `end`. */
const longWords = (marker, end) => {
  const lines = Array.from(
    { length: 150 },
    (_, index) => `Line ${index + 1} of the ${marker} pulse.`,
  )
  const words = `${lines.join(' ')} ${end}`
  NodeAssert.ok(words.indexOf(end) > 4000, 'The end code must sit past 4,000 characters')
  return words
}

/** An external provider invokes Executor directly, outside every Vivid tool and approval adapter. */
export async function emit(state, { app, words, name }, directory) {
  const key = await memberKey(state, state.person)
  const tools = await executorRequest(state, '/apps/' + encodeURIComponent(app) + '/tools', {
    schema: ExecutorTools,
    memberKey: key,
  })
  const tool = tools.items.find((candidate) => candidate.name === 'emit')
  NodeAssert.ok(tool, 'Executor app has no emitting operation')
  const receipt = crypto.randomUUID()
  const result = await executorRequest(state, '/apps/' + encodeURIComponent(app) + '/tools/call', {
    schema: ExecutorResult,
    memberKey: key,
    body: {
      version: tools.version,
      kind: 'mutation',
      tool: tool.name,
      input: { receipt, words },
    },
  })
  await json(directory + '/' + name + '.json', { receipt, app, result })
  return receipt
}

/**
 * The Feed post tells the Person: one `posted` notice about the background Thread, titled as the
 * card and opening the Feed. The notice is committed after the card, so it is waited for on the
 * public live list rather than read once.
 */
async function postedNotice(state, item, directory) {
  const notice = await observe(state, {
    tag: 'WatchNotifications',
    payload: null,
    accept: (publication) =>
      publication.notifications.some(
        (candidate) => candidate.kind === 'posted' && candidate.threadId === item.thread,
      ),
  })
  await json(directory + '/posted-notifications.json', notice)
  const notices = notice.notifications.filter(
    (candidate) => candidate.kind === 'posted' && candidate.threadId === item.thread,
  )
  // A later post with other content is new news and a notice of its own; the same post sent
  // again is not (`apps/server/src/push/delivery.test.ts`). Each one says what its card says.
  const mine = notices.find((candidate) => candidate.title === item.post.title)
  NodeAssert.ok(mine, 'The notice is titled as the card')
  NodeAssert.equal(mine.body, '', 'A drawn card has no words to quote')
  for (const candidate of notices)
    NodeAssert.deepEqual(
      candidate.opens,
      NotificationOpens.cases.Feed.make({}),
      'A posted notice opens the Feed',
    )
  return mine
}

/**
 * One real occurrence must publish a completed background Run, a model-authored Feed item and
 * the notice it makes. `away` runs just before the provider emits, so a browser can step away
 * from the app and be told by push rather than by its open page.
 */
export async function occurrence(state, { id, integration, marker, away }, directory) {
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
  const end = 'END' + crypto.randomUUID().slice(0, 8).toUpperCase()
  await away()
  const receipt = await emit(
    state,
    { app: integration.app, words: longWords(marker, end), name: 'provider-receipt' },
    directory,
  )
  const item = await posted(state, threadFor(watching.id, receipt), directory)
  // The card is the drawing: a drawn post, whose display holds the receipt, with no words or bar.
  NodeAssert.equal(item.post._tag, 'Drawn', 'Feed card was said in words, not drawn')
  NodeAssert.ok(item.post.display.includes(receipt), 'Feed display did not draw the receipt')
  NodeAssert.ok(
    item.post.display.includes(end),
    'The end of the long event did not reach the model',
  )
  const detail = await settled(state, item.thread, 1, 'Completed', directory)
  const run = detail.runs[0]
  // The Run records which Watch and which event started it.
  NodeAssert.ok(RunOrigin.guards.Watch(run.origin))
  NodeAssert.equal(run.origin.watchId, watching.id)
  NodeAssert.equal(run.origin.eventId, receipt)
  NodeAssert.equal(item.thread, threadFor(watching.id, receipt))
  const runs = await watchRows(
    state,
    { table: 'vivid_runs', field: 'thread_id', id: item.thread },
    directory,
    'background-runs',
  )
  NodeAssert.equal(runs.length, 1)
  NodeAssert.equal(runs[0].id, run.id)
  // The card says what posted it and what caused it, from the record.
  NodeAssert.ok(FeedProvenance.guards.Recorded(item.post.provenance), 'Feed card has no provenance')
  const provenance = FeedProvenance.cases.Recorded.make({
    postedBy: run.id,
    cause: FeedCause.cases.Watch.make({
      run: run.id,
      watch: watching.id,
      watchName: marker,
      eventId: receipt,
    }),
    evidence: [
      FeedEvidence.cases.ThreadRun.make({ thread: item.thread, run: run.id }),
      ...item.post.provenance.evidence.slice(1),
    ],
  })
  NodeAssert.deepEqual(item.post.provenance, provenance, 'Feed card provenance was not recorded')
  // The Thread shows the event whole, as what Vivid saw.
  const background = await history(state, item.thread, directory, 'background-history')
  const saw = background.messages.find(
    (message) => message.signal !== undefined && message.signal.tagName === 'event',
  )
  NodeAssert.ok(saw, 'The background Thread has no event')
  NodeAssert.equal(saw.signal.attributes.event, 'pulse.received')
  NodeAssert.ok(
    saw.parts.some((part) => part.type === 'text' && part.text.includes(end)),
    'The Thread does not hold the whole event',
  )
  const notice = await postedNotice(state, item, directory)
  const evidence = {
    receipt,
    end,
    watch: watching.id,
    run: run.id,
    feed: item.card,
    item,
    background: item.thread,
    connection: integration.connection.id,
    app: integration.app,
    notice: notice.id,
  }
  await redelivered(state, evidence, directory)
  await json(directory + '/proof.json', evidence)
  return evidence
}

/** The callback a Watch's events are signed for, from its run-owned row. */
async function callbackOf(state, watch, directory, name) {
  const rows = await watchRows(
    state,
    { table: 'vivid_watches', field: 'id', id: watch },
    directory,
    name,
  )
  NodeAssert.equal(rows.length, 1)
  return rows[0].callback_url
}

/** Sign one delivery as Executor does for this Watch and post it to its callback. */
async function signedDelivery(proof, { callback, receipt, words }) {
  const signed = {
    id: crypto.randomUUID(),
    timestamp: String(Math.floor(Date.now() / 1000)),
    body: JSON.stringify({
      eventId: receipt,
      name: 'pulse.received',
      timestamp: new Date().toISOString(),
      data: { receipt, words },
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
  if (response.body !== null) await response.body.cancel()
  return response.status
}

/** Executor delivers at least once. The same event again joins the same Run, and the card keeps
 * the cause it recorded: no second Run, the same provenance. */
async function redelivered(state, proof, directory) {
  const callback = await callbackOf(state, proof.watch, directory, 'redelivery-watch')
  const status = await signedDelivery(proof, {
    callback,
    receipt: proof.receipt,
    words: 'Delivered again',
  })
  const runs = await watchRows(
    state,
    { table: 'vivid_runs', field: 'thread_id', id: proof.background },
    directory,
    'redelivery-runs',
  )
  const feed = await rpc(state, 'ListFeed', undefined, directory)
  const card = feed.items.find((candidate) => candidate.card === proof.feed)
  await json(directory + '/redelivery.json', { status, runs: runs.length, card })
  NodeAssert.equal(status, 200, 'A redelivered event was refused')
  NodeAssert.equal(runs.length, 1, 'A redelivered event started another Run')
  NodeAssert.deepEqual(
    card.post.provenance,
    proof.item.post.provenance,
    'Redelivery moved the cause',
  )
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
  const status = await signedDelivery(proof, { callback, receipt, words: 'After removal' })
  await json(directory + '/removed-delivery.json', {
    watch: proof.watch,
    receipt,
    callback,
    status,
  })
  return status
}

/** Keep every assertion on the baseline. The provider's exported committed state proves
 * no live subscription and no queued delivery, so absence of a Run needs no quiet-time sleep. */
export async function disconnected(state, proof, directory, remove) {
  const callback = await callbackOf(state, proof.watch, directory, 'active-watch')
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
    { app: proof.app, words: 'After removal', name: 'after-remove' },
    directory,
  )
  if (rows.some((row) => row.state === 'Active')) {
    const item = await posted(state, threadFor(proof.watch, receipt), directory)
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
  // The card's cause is copied into it, so it still says what started the work.
  const feed = await rpc(state, 'ListFeed', undefined, directory)
  const card = feed.items.find((candidate) => candidate.card === proof.feed)
  await json(directory + '/after-remove-card.json', card)
  NodeAssert.ok(card, 'The card left the Feed with its Watch')
  NodeAssert.deepEqual(
    card.post.provenance,
    proof.item.post.provenance,
    'Removal changed the cause',
  )
}

/** HTTP journey uses the real prompt and tools, then the same public Remove as the browser. */
export async function watch(state, id, directory) {
  const integration = await connectPulse(state, directory)
  const marker = 'Pulse ' + crypto.randomUUID().slice(0, 8)
  await chat(state, id, watchWords(marker), directory)
  const proof = await occurrence(
    state,
    { id, integration, marker, away: async () => undefined },
    directory,
  )
  await completion(state, { id, integration }, directory)
  await disconnected(state, proof, directory, () =>
    rpc(state, 'RemoveConnection', { id: integration.connection.id }, directory),
  )
}

/** An Until Watch ends only after a live provider read and its own admitted completion tool. */
async function completion(state, { id, integration }, directory) {
  const marker = 'Until ' + crypto.randomUUID().slice(0, 8)
  const path = directory + '/completion'
  await NodeFSP.mkdir(path, { recursive: true })
  await chat(
    state,
    id,
    `Start a Watch named ${marker} on Verify Pulse pulse.received. Its explicit end condition is that, after the next pulse, a fresh find_events read still lists pulse.received. When it fires, find_events must read Verify Pulse, then finish_watching with that evidence. Do not emit the pulse yourself.`,
    path,
  )
  await settled(state, id, 2, 'Completed', path)
  const { watches } = await rpc(state, 'ListWatches', undefined, path)
  const watching = watches.find((watch) => watch.name === marker)
  NodeAssert.ok(watching && WatchState.guards.Active(watching.state))
  const [row] = await watchRows(
    state,
    { table: 'vivid_watches', field: 'id', id: watching.id },
    path,
    'before',
  )
  const receipt = await emit(state, { app: integration.app, words: marker, name: 'pulse' }, path)
  await observe(state, {
    tag: 'WatchWork',
    payload: null,
    accept: (list) =>
      !list.work.some((work) => BackgroundWork.guards.Watch(work) && work.watch === watching.id),
  })
  const thread = threadFor(watching.id, receipt)
  const detail = await settled(state, thread, 1, 'Completed', path)
  const page = await history(state, thread, path)
  const calls = page.messages
    .flatMap((message) => message.parts)
    .filter((part) => part.type === 'dynamic-tool' && part.state === 'output-available')
  NodeAssert.ok(calls.findIndex((call) => call.toolName === 'find_events') >= 0)
  NodeAssert.ok(
    calls.findIndex((call) => call.toolName === 'finish_watching') >
      calls.findIndex((call) => call.toolName === 'find_events'),
  )
  const [completed] = await watchRows(
    state,
    { table: 'vivid_watches', field: 'id', id: watching.id },
    path,
    'after',
  )
  NodeAssert.equal(completed.state, 'Completed')
  NodeAssert.ok(WatchCondition.guards.Until(completed.condition))
  NodeAssert.ok(completed.state_data && WatchState.guards.Completed(completed.state_data))
  NodeAssert.equal(completed.state_data.runId, detail.runs[0].id)
  NodeAssert.ok(completed.state_data.evidence.length > 0)
  const status = await removedDelivery(
    { watch: watching.id },
    { callback: row.callback_url, receipt: crypto.randomUUID() },
    path,
  )
  NodeAssert.equal(status, 410)
  await json(path + '/proof.json', { watch: watching.id, run: detail.runs[0].id, receipt, status })
}
