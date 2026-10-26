import * as NodeFSP from 'node:fs/promises'
import * as NodeAssert from 'node:assert/strict'
import { FeedItem, FeedResponse, RunState } from '@vivid/contracts'
import { Result, Schema } from 'effect'
import { RpcSerialization } from 'effect/rpc'
import { admit, chat, history, json, rpc, settled } from './wire.mjs'
import { askQuestion, enrol } from './devices.mjs'

const Account = Schema.Struct({ cookie: Schema.String })
const Request = Schema.TaggedStruct('Request', {
  id: Schema.String,
  tag: Schema.String,
  payload: Schema.Null,
  headers: Schema.Array(Schema.Array(Schema.String)),
})
const Packet = Schema.TaggedUnion({
  Chunk: { values: Schema.Array(RpcSerialization.ndjson.codecFor(FeedResponse)) },
  Exit: {},
  Pong: {},
})
const decodePacket = Schema.decodeUnknownResult(Schema.fromJsonString(Packet))
const decodeAccount = Schema.decodeUnknownResult(Schema.fromJsonString(Account))

/** Framing and wire decoding belong to the public HTTP adapter, before the stage assertions. */
async function* feedValues(response) {
  let buffer = ''
  for await (const bytes of response.body) {
    buffer += Buffer.from(bytes).toString('utf8')
    let newline
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      yield* Packet.match(Result.getOrThrow(decodePacket(line)), {
        Chunk: ({ values }) => values,
        Exit: () => {
          throw new Error('WatchFeed ended before its change receipt')
        },
        Pong: () => [],
      })
    }
  }
}

/** Subscribe before the mutation so a matching initial snapshot cannot pass as a change receipt.
 * The public WatchFeed stream and its production codec are the only stage observation seam. */
export async function feedChange(state, directory, { name, accepts, change }) {
  const account = Result.getOrThrow(
    decodeAccount(await NodeFSP.readFile(state.scratch + '/account.json', 'utf8')),
  )
  const abort = new AbortController()
  const observed = []
  try {
    const response = await fetch(state.web + '/api/rpc', {
      method: 'POST',
      headers: { cookie: account.cookie, origin: state.web, 'content-type': 'application/ndjson' },
      body:
        JSON.stringify(Request.make({ id: '1', tag: 'WatchFeed', payload: null, headers: [] })) +
        '\n',
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(90_000)]),
    })
    NodeAssert.equal(response.status, 200)
    for await (const value of feedValues(response)) {
      observed.push(value)
      if (observed.length === 1) {
        NodeAssert.equal(accepts(value), false, 'Target stage was already present before mutation')
        await change()
      } else if (accepts(value)) {
        await json(directory + '/' + name + '.json', { observed, receivedAfterMutation: true })
        return value
      }
    }
    throw new Error('WatchFeed closed before ' + name)
  } finally {
    abort.abort()
    await json(directory + '/' + name + '-stream.json', {
      closed: true,
      snapshots: observed.length,
    })
  }
}

/** Record a real ordinary conversation, then require its handled entry through public APIs. */
export async function conversation(state, id, directory) {
  await chat(state, id, 'Just say the two words amber orchid, nothing else.', directory)
  await settled(state, id, 1, 'Completed', directory)
  const page = await history(state, id, directory)
  NodeAssert.ok(
    page.messages.some(
      (m) => m.role === 'assistant' && m.parts.some((p) => p.type === 'text' && p.text.trim()),
    ),
  )
  const list = await rpc(state, 'ListFeed', undefined, directory, 'handled-list')
  const item = list.items.find((entry) => entry.thread === id)
  NodeAssert.ok(item)
  NodeAssert.equal(item._tag, 'Settled')
  NodeAssert.equal(item.post, null)
  return item
}

/** Ordinary Threads exercise Feed delivery without a Watch or synthetic database row.
 * Desktop Stop uses its public installation/Run report. It must win while the real Run is active. */
export async function feed(state, id, directory) {
  const empty = await rpc(state, 'ListFeed', undefined, directory, 'empty-conversation')
  NodeAssert.equal(
    empty.items.some((item) => item.thread === id),
    false,
  )
  await conversation(state, id, directory)
  const asked = await feedChange(state, directory, {
    name: 'question-waiting',
    accepts: (list) =>
      list.items.some(
        (item) =>
          item.thread === id &&
          FeedItem.guards.Waiting(item) &&
          item.post === null &&
          item.asking.includes('question'),
      ),
    change: () => askQuestion(state, id, directory),
  })
  NodeAssert.equal(asked.items.find((item) => item.thread === id).seen, false)
  const stopped = crypto.randomUUID()
  await rpc(
    state,
    'CreateThread',
    { id: stopped, title: 'Feed desktop Stop', projectId: null },
    directory,
    'stop-thread',
  )
  const installation = await enrol(state, directory, 'Feed Stop installation')
  try {
    await feedChange(state, directory, {
      name: 'run-working',
      accepts: (list) =>
        list.items.some((item) => item.thread === stopped && FeedItem.guards.Working(item)),
      change: () =>
        admit(
          state,
          stopped,
          'Write me a detailed 2000-word essay about the history of astronomy.',
          directory,
          'active-run',
        ),
    })
    const detail = await rpc(state, 'GetThread', { id: stopped }, directory, 'active-detail')
    const run = detail.runs.find((entry) => RunState.guards.Working(entry.state))
    NodeAssert.ok(run, 'Real Run settled before desktop Stop; no active Stop proof')
    const report = {
      device: installation.device.id,
      installation: installation.installation,
      runId: run.id,
    }
    await feedChange(state, directory, {
      name: 'desktop-stop-settled',
      accepts: (list) =>
        list.items.some((item) => item.thread === stopped && FeedItem.guards.Settled(item)),
      change: () => rpc(state, 'ReportDeviceStop', report, directory),
    })
    await settled(state, stopped, 1, 'Stopped', directory)
    const before = await rpc(state, 'ListFeed', undefined, directory, 'before-repeat-stop')
    await rpc(state, 'ReportDeviceStop', report, directory, 'repeat-desktop-stop')
    const after = await rpc(state, 'ListFeed', undefined, directory, 'after-repeat-stop')
    NodeAssert.deepEqual(after, before)
  } finally {
    await rpc(
      state,
      'RevokeDevice',
      { id: installation.device.id },
      directory,
      'cleanup-stop-installation',
    )
  }
  await json(directory + '/scope.json', {
    scope:
      'ordinary Conversation empty exclusion, real completed Run history, public question Waiting, active Run Working and desktop Stop settlement',
    blocked: [
      'Watch occurrences and Background posts require disposable Executor authority',
      'native phone and desktop controls require device runs',
    ],
  })
}
