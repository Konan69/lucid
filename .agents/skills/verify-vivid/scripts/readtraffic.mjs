import * as NodeAssert from 'node:assert/strict'
import * as NodeEvents from 'node:events'
import { ThreadDetail, ThreadId } from '@vivid/contracts'
import { Option, Result, Schema } from 'effect'
import { RpcSerialization } from 'effect/rpc'
import { decode } from './wire.mjs'

const Response = Schema.Union([
  Schema.Struct({ id: Schema.Finite, result: Schema.Json }),
  Schema.Struct({ id: Schema.Finite, error: Schema.Json }),
])
const Event = Schema.Struct({ method: Schema.String, params: Schema.Json })
const Message = Schema.Union([Response, Event])
const decodeMessage = Schema.decodeUnknownResult(Schema.fromJsonString(Message))
const Created = Schema.Struct({ requestId: Schema.String, url: Schema.String })
const Frame = Schema.Struct({
  requestId: Schema.String,
  response: Schema.Struct({ payloadData: Schema.String }),
})
const Identifier = Schema.Union([Schema.String, Schema.Finite])
const Request = Schema.TaggedStruct('Request', {
  id: Identifier,
  tag: Schema.String,
  payload: Schema.Json,
})
const Chunk = Schema.TaggedStruct('Chunk', {
  requestId: Identifier,
  values: Schema.Array(Schema.Json),
})
const Exit = Schema.TaggedStruct('Exit', {
  requestId: Identifier,
  exit: Schema.Struct({ _tag: Schema.Literals(['Success', 'Failure']) }),
})
const decodeFrame = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Json))
const Targets = Schema.Struct({
  targetInfos: Schema.Array(
    Schema.Struct({ type: Schema.String, url: Schema.String, targetId: Schema.String }),
  ),
})
const ReadPayload = Schema.Struct({ id: ThreadId })
const Attached = Schema.Struct({ sessionId: Schema.String })
const decodeRequest = Schema.decodeUnknownOption(Request)
const decodeChunk = Schema.decodeUnknownOption(Chunk)
const decodeExit = Schema.decodeUnknownOption(Exit)

/** Keep public read receipts and synthetic Thread metadata only. Discard headers and conversation text. */
function outgoing(value, socket, observed) {
  const request = decodeRequest(value)
  if (Option.isNone(request)) return
  const { id, tag, payload } = request.value
  if (tag !== 'MarkThreadRead' && tag !== 'WatchThread') return
  const thread = decode(ReadPayload, payload).id
  const entry = { kind: 'request', tag, thread }
  observed.requests.set(socket + '/' + id, entry)
  observed.events.push(entry)
}

/** Correlate successful writes and live publications with the browser's own request ids. */
function incoming(value, socket, observed) {
  const chunk = decodeChunk(value)
  const exit = decodeExit(value)
  if (Option.isSome(chunk)) {
    const request = observed.requests.get(socket + '/' + chunk.value.requestId)
    if (request === undefined || request.tag !== 'WatchThread') return
    for (const item of chunk.value.values) {
      const detail = decode(RpcSerialization.ndjson.codecFor(ThreadDetail), item)
      observed.events.push({
        kind: 'standing',
        thread: detail.thread.id,
        moved: detail.thread.updatedAt,
        title: detail.thread.title,
      })
    }
  } else if (Option.isSome(exit)) {
    const request = observed.requests.get(socket + '/' + exit.value.requestId)
    if (request !== undefined && request.tag === 'MarkThreadRead')
      observed.events.push({
        kind: 'receipt',
        thread: request.thread,
        outcome: exit.value.exit._tag,
      })
  }
}

/** Network observation uses CDP events without replacing the app's WebSocket, fetch or RPC handlers. */
function record(event, observed) {
  if (event.method === 'Network.webSocketCreated') {
    const created = decode(Created, event.params)
    if (new URL(created.url).pathname === '/api/live') observed.live.add(created.requestId)
    return
  }
  const sent = event.method === 'Network.webSocketFrameSent'
  if (!sent && event.method !== 'Network.webSocketFrameReceived') return
  const frame = decode(Frame, event.params)
  if (!observed.live.has(frame.requestId)) return
  const value = Result.getOrThrow(decodeFrame(frame.response.payloadData))
  for (const packet of Array.isArray(value) ? value : [value]) {
    if (sent) outgoing(packet, frame.requestId, observed)
    else incoming(packet, frame.requestId, observed)
  }
}

/** A browser-owned observer with event-driven waits. The deadline bounds failure, never implies success. */
export async function readTraffic(run, address) {
  const url = (await run(['get', 'cdp-url'])).trim().replace(/^"|"$/gu, '')
  NodeAssert.match(url, /^wss?:\/\//u)
  const socket = new WebSocket(url)
  const pending = new Map()
  const observed = { events: [], live: new Set(), requests: new Map() }
  const changes = new NodeEvents.EventEmitter()
  const deadline = AbortSignal.timeout(300_000)
  let sequence = 0
  let failure
  const close = () => socket.close()
  deadline.addEventListener('abort', close, { once: true })
  socket.addEventListener('message', (event) => {
    try {
      const packet = Result.getOrThrow(decodeMessage(event.data))
      if ('method' in packet) {
        record(packet, observed)
        changes.emit('change')
      } else {
        const waiting = pending.get(packet.id)
        if (!waiting) return
        pending.delete(packet.id)
        if ('error' in packet) waiting.reject(new Error(JSON.stringify(packet.error)))
        else waiting.resolve(packet.result)
      }
    } catch (error) {
      failure = error
      close()
    }
  })
  socket.addEventListener('close', () => {
    failure ??= new Error('Chrome read observer closed')
    for (const waiting of pending.values()) waiting.reject(failure)
    pending.clear()
    changes.emit('change')
  })
  try {
    await NodeEvents.once(socket, 'open', { signal: deadline })
    const command = (method, params, sessionId) => {
      if (failure) throw failure
      const id = ++sequence
      const answer = Promise.withResolvers()
      pending.set(id, answer)
      socket.send(JSON.stringify({ id, method, params, sessionId }))
      return answer.promise
    }
    let session
    if (new URL(url).pathname.includes('/devtools/browser/')) {
      const targets = decode(Targets, await command('Target.getTargets', {}))
      const target = targets.targetInfos.find((t) => t.type === 'page' && t.url === address)
      NodeAssert.ok(target, 'Missing owned Thread tab')
      const attached = decode(
        Attached,
        await command('Target.attachToTarget', { targetId: target.targetId, flatten: true }),
      )
      session = attached.sessionId
    }
    await command('Network.enable', {}, session)
    return {
      events: observed.events,
      wait: async (accepts) => {
        while (!accepts(observed.events)) {
          if (failure) throw failure
          await NodeEvents.once(changes, 'change', { signal: deadline })
        }
      },
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
        deadline.removeEventListener('abort', close)
        close()
      },
    }
  } catch (error) {
    deadline.removeEventListener('abort', close)
    close()
    throw error
  }
}
