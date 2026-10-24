import * as NodeAssert from 'node:assert/strict'
import * as NodeEvents from 'node:events'
import { FeedItem, MarkFeedCardRequest } from '@vivid/contracts'
import { Option, Result, Schema } from 'effect'
import { conversation, feedChange } from './feed.mjs'
import { askQuestion } from './devices.mjs'
import { decode, json, rpc } from './wire.mjs'

const Response = Schema.Union([
  Schema.Struct({ id: Schema.Finite, result: Schema.Json }),
  Schema.Struct({ id: Schema.Finite, error: Schema.Json }),
])
const Event = Schema.Struct({ method: Schema.String, params: Schema.Json })
const Message = Schema.Union([Response, Event])
const decodeMessage = Schema.decodeUnknownResult(Schema.fromJsonString(Message))
const Created = Schema.Struct({ requestId: Schema.String, url: Schema.String })
const Sent = Schema.Struct({
  requestId: Schema.String,
  response: Schema.Struct({ payloadData: Schema.String }),
})
const Request = Schema.TaggedStruct('Request', { tag: Schema.String, payload: Schema.Json })
const decodeRequest = Schema.decodeUnknownOption(Request)
const decodeFrame = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Json))
const Targets = Schema.Struct({
  targetInfos: Schema.Array(
    Schema.Struct({ type: Schema.String, url: Schema.String, targetId: Schema.String }),
  ),
})
const Attached = Schema.Struct({ sessionId: Schema.String })

/** Decode Chrome's response/event variants before routing a command receipt or network event. */
function receive(data, pending, observation) {
  const packet = Result.getOrThrow(decodeMessage(data))
  if ('method' in packet) return record(packet, observation)
  const waiting = pending.get(packet.id)
  if (!waiting) return
  pending.delete(packet.id)
  if ('error' in packet) waiting.reject(new Error(JSON.stringify(packet.error)))
  else waiting.resolve(packet.result)
}

/** Observe only public live RPC names and card marks; discard every header and message body. */
function record(event, { live, frames }) {
  if (event.method === 'Network.webSocketCreated') {
    const created = decode(Created, event.params)
    if (created.url.endsWith('/api/live')) live.add(created.requestId)
  }
  if (event.method !== 'Network.webSocketFrameSent') return
  const sent = decode(Sent, event.params)
  if (!live.has(sent.requestId)) return
  const value = Result.getOrThrow(decodeFrame(sent.response.payloadData))
  for (const entry of Array.isArray(value) ? value : [value]) {
    Option.map(decodeRequest(entry), (request) => {
      if (request.tag === 'MarkFeedCard') {
        const mark = decode(MarkFeedCardRequest, request.payload)
        frames.push({ tag: request.tag, ...mark })
      } else frames.push({ tag: request.tag })
    })
  }
}

/** Chrome's public CDP events observe the transport without replacing app or SDK methods. */
async function traffic(run, address) {
  const url = (await run(['get', 'cdp-url'])).trim().replace(/^"|"$/gu, '')
  NodeAssert.match(url, /^wss?:\/\//u)
  const socket = new WebSocket(url)
  const pending = new Map()
  const observation = { frames: [], live: new Set() }
  let failure
  let sequence = 0
  socket.addEventListener('message', (event) => {
    try {
      receive(event.data, pending, observation)
    } catch (error) {
      failure = error
      socket.close()
    }
  })
  socket.addEventListener('close', () => {
    for (const waiting of pending.values())
      waiting.reject(failure ?? new Error('Chrome observer closed'))
    pending.clear()
  })
  const deadline = AbortSignal.timeout(90_000)
  const expire = () => socket.close()
  deadline.addEventListener('abort', expire, { once: true })
  try {
    await NodeEvents.once(socket, 'open', { signal: deadline })
    const command = (method, params = {}, sessionId) => {
      if (failure) throw failure
      NodeAssert.equal(socket.readyState, WebSocket.OPEN, 'Chrome observer is closed')
      const id = ++sequence
      const answer = Promise.withResolvers()
      pending.set(id, answer)
      socket.send(JSON.stringify({ id, method, params, sessionId }))
      return answer.promise
    }
    let session
    if (new URL(url).pathname.includes('/devtools/browser/')) {
      const targets = decode(Targets, await command('Target.getTargets'))
      const target = targets.targetInfos.find((t) => t.type === 'page' && t.url === address)
      NodeAssert.ok(target, 'Missing owned browser tab')
      const attached = decode(
        Attached,
        await command('Target.attachToTarget', {
          targetId: target.targetId,
          flatten: true,
        }),
      )
      session = attached.sessionId
    }
    await command('Network.enable', {}, session)
    return {
      frames: observation.frames,
      // Two paint callbacks let the visibility observer report a fully rendered waiting card.
      painted: () =>
        command(
          'Runtime.evaluate',
          {
            expression:
              'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
            awaitPromise: true,
          },
          session,
        ),
      close: () => {
        deadline.removeEventListener('abort', expire)
        socket.close()
      },
    }
  } catch (error) {
    deadline.removeEventListener('abort', expire)
    socket.close()
    throw error
  }
}

/** Real conversation history and a public question produce ordinary Feed items, never fixtures.
 * Opening, returning and reloading re-trigger visibility while CDP checks actual outgoing RPCs. */
export async function feedBrowser(state, id, directory, browser) {
  const { run, capture } = browser
  const title = 'Verify Feed ' + id.slice(0, 8)
  await rpc(state, 'PatchThread', { id, patch: { title } }, directory)
  await conversation(state, id, directory)
  const observed = await traffic(run, state.web + '/t/' + id)
  try {
    await feedChange(state, directory, {
      name: 'browser-question-waiting',
      accepts: (list) =>
        list.items.some((item) => item.thread === id && FeedItem.guards.Waiting(item)),
      change: () => askQuestion(state, id, directory),
    })
    const list = await rpc(state, 'ListFeed', undefined, directory, 'waiting-list')
    const item = list.items.find((entry) => entry.thread === id)
    NodeAssert.equal(item._tag, 'Waiting')
    NodeAssert.equal(item.post, null)
    const visible = `Array.from(document.querySelectorAll('article')).some(card => card.querySelector('h2 button')?.textContent.trim() === ${JSON.stringify(title)} && card.innerText.includes('Vivid has a question for you. Open it to answer.'))`
    await run(['open', state.web + '/feed'])
    await run(['wait', '--fn', visible])
    await observed.painted()
    await capture('ordinary-waiting')
    await run(['find', 'role', 'button', 'click', '--name', title, '--exact'])
    await run(['wait', '--url', '**/t/' + id])
    await run(['wait', '--text', 'Which colour should the verification use?'])
    await capture('opened-thread')
    await run(['open', state.web + '/feed'])
    await run(['wait', '--fn', visible])
    await observed.painted()
    await capture('returned-feed')
    await run(['reload'])
    await run(['wait', '--fn', visible])
    await observed.painted()
    await capture('feed-reloaded')
    NodeAssert.ok(
      observed.frames.some((frame) => frame.tag === 'WatchFeed'),
      'No live Feed traffic observed',
    )
    NodeAssert.deepEqual(
      observed.frames.filter((frame) => frame.tag === 'MarkFeedCard' && frame.card === item.card),
      [],
      'Derived Conversation sent a persisted-card mark',
    )
    await json(directory + '/rpc-traffic.json', observed.frames)
    const after = await rpc(state, 'ListFeed', undefined, directory, 'after-visibility')
    NodeAssert.equal(after.items.find((entry) => entry.thread === id).seen, false)
  } finally {
    await json(directory + '/rpc-traffic.json', observed.frames)
    observed.close()
  }
  await json(directory + '/scope.json', {
    scope:
      'real completed Conversation, public question shown on Feed, open its Thread, return and reload without invalid MarkFeedCard requests',
    blocked: [
      'Background posts, actions and seen/Done need disposable Watch delivery',
      'phone and desktop native controls need device runs',
    ],
  })
}
