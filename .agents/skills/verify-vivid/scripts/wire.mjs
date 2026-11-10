import * as NodeFSP from 'node:fs/promises'
import { applyImmutable, assertValidOp, isReplace } from '@earendil-works/chord/delta'
import { Schema, Result } from 'effect'
import { RpcSerialization } from 'effect/rpc'
import {
  ConversationFrame,
  ConversationState,
  SendToThreadRequest,
  ThreadDetail,
  ThreadId,
} from '@vivid/contracts'
import { VividRpc } from '@vivid/contracts/rpc'
import { json } from './process.mjs'
import { Account, decodeText, RuntimeHealth } from './receipts.mjs'
export { json } from './process.mjs'

const ConversationPacket = Schema.TaggedUnion({
  Chunk: { values: Schema.Array(ConversationFrame) },
  Exit: { exit: Schema.Unknown },
  Pong: {},
})
const WatchRequest = Schema.TaggedStruct('Request', {
  id: Schema.String,
  tag: Schema.Literal('WatchConversation'),
  payload: Schema.Struct({ threadId: ThreadId }),
  headers: Schema.Array(Schema.Array(Schema.String)),
})

/** Decode complete RPC lines before the conversation observer consumes their frames. */
async function* frames(response) {
  let buffer = ''
  const decoder = new TextDecoder()
  for await (const bytes of response.body) {
    buffer += decoder.decode(bytes, { stream: true })
    let newline
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      yield* ConversationPacket.match(decodeText(ConversationPacket, line), {
        Chunk: ({ values }) => values,
        Exit: () => {
          throw new Error('WatchConversation ended: ' + line)
        },
        Pong: () => [],
      })
    }
  }
}

/** These public ingress/egress codecs are the same contracts the web's transport and gateway use. */
export const decode = (schema, value) =>
  Result.getOrThrow(Schema.decodeUnknownResult(schema)(value))
export const encode = (schema, value) =>
  Result.getOrThrow(Schema.encodeUnknownResult(schema)(value))

/** Record bounded public responses, but never cookie/session credentials. Caller chooses evidence name. */
export async function request(
  state,
  path,
  { method = 'GET', body, name, directory, stream = false, headersReady } = {},
) {
  const credentials = JSON.parse(await NodeFSP.readFile(state.scratch + '/account.json', 'utf8'))
  const response = await fetch(state.web + path, {
    method,
    headers: {
      origin: state.web,
      cookie: credentials.cookie,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(300_000),
  })
  if (headersReady) headersReady.resolve(response.status)
  let text = ''
  let readError
  try {
    for await (const bytes of response.body) text += Buffer.from(bytes).toString('utf8')
  } catch (error) {
    readError = error
  }
  const evidence = { method, path, status: response.status, body: text }
  if (readError) evidence.readError = readError.message
  if (name) await json(directory + '/' + name + '.json', evidence)
  if (stream && name) await NodeFSP.writeFile(directory + '/' + name + '.sse', text)
  if (readError) throw readError
  if (response.status >= 400) throw new Error(`${method} ${path}: ${response.status} ${text}`)
  if (stream) return text
  return text === '' ? null : JSON.parse(text)
}

/** Person RPC packets follow host.live.test.ts personPacket, including newline-delimited framing. */
export async function rpc(state, tag, payload, directory, name = tag) {
  const account = JSON.parse(await NodeFSP.readFile(state.scratch + '/account.json', 'utf8'))
  const procedure = VividRpc.requests.get(tag)
  if (!procedure) throw new Error('Unknown public RPC ' + tag)
  // RPC's JSON codec encodes Void as null. Plain Schema encoding leaves undefined, which
  // JSON.stringify omits and the real ListRoutines route correctly refuses (rc.116 codecForJson).
  const value = encode(RpcSerialization.ndjson.codecFor(procedure.payloadSchema), payload)
  const packet = { _tag: 'Request', id: '1', tag, payload: value, headers: [] }
  const response = await fetch(state.web + '/api/rpc', {
    method: 'POST',
    headers: { cookie: account.cookie, origin: state.web, 'content-type': 'application/ndjson' },
    body: JSON.stringify(packet) + '\n',
    signal: AbortSignal.timeout(300_000),
  })
  const text = await response.text()
  if (directory)
    await json(directory + '/' + name + '.json', {
      tag,
      payload: value,
      status: response.status,
      body: text,
    })
  const packets = text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  const exit = packets.find((packet) => packet._tag === 'Exit')
  if (response.status !== 200 || !exit || exit.exit._tag !== 'Success')
    throw new Error(`${tag}: ${response.status} ${text}`)
  return decode(RpcSerialization.ndjson.codecFor(procedure.successSchema), exit.exit.value)
}

/** WatchThread is the product publication signal; SSE termination alone never proves settlement.
 * This finite read closes its own stream on the first matching durable ThreadDetail. No polling. */
/**
 * Follow WatchThread until `accept` holds for the Thread's detail, within `deadline` milliseconds.
 * For a state the server reaches on its own, such as an ask that runs out at its deadline.
 */
export async function until(state, thread, accept, deadline, directory, name = 'until') {
  const account = JSON.parse(await NodeFSP.readFile(state.scratch + '/account.json', 'utf8'))
  const abort = new AbortController()
  const timeout = setTimeout(() => abort.abort(new Error(name + ' deadline')), deadline)
  try {
    const response = await fetch(state.web + '/api/rpc', {
      method: 'POST',
      headers: { cookie: account.cookie, origin: state.web, 'content-type': 'application/ndjson' },
      body:
        JSON.stringify({
          _tag: 'Request',
          id: '1',
          tag: 'WatchThread',
          payload: { id: thread },
          headers: [],
        }) + '\n',
      signal: abort.signal,
    })
    let buffer = ''
    for await (const bytes of response.body) {
      buffer += Buffer.from(bytes).toString('utf8')
      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        const packet = JSON.parse(line)
        if (packet._tag === 'Exit' && packet.exit._tag === 'Failure') throw new Error(line)
        if (packet._tag !== 'Chunk') continue
        for (const value of packet.values) {
          const detail = decode(RpcSerialization.ndjson.codecFor(ThreadDetail), value)
          if (accept(detail)) {
            if (directory) await json(directory + '/' + name + '.json', detail)
            return detail
          }
        }
      }
    }
    throw new Error('WatchThread ended before ' + name)
  } finally {
    clearTimeout(timeout)
    abort.abort()
  }
}

export async function settled(state, thread, count, terminal = 'Completed', directory) {
  const account = JSON.parse(await NodeFSP.readFile(state.scratch + '/account.json', 'utf8'))
  const abort = new AbortController()
  const timeout = setTimeout(
    () => abort.abort(new Error('WatchThread settlement deadline')),
    300_000,
  )
  try {
    const response = await fetch(state.web + '/api/rpc', {
      method: 'POST',
      headers: { cookie: account.cookie, origin: state.web, 'content-type': 'application/ndjson' },
      body:
        JSON.stringify({
          _tag: 'Request',
          id: '1',
          tag: 'WatchThread',
          payload: { id: thread },
          headers: [],
        }) + '\n',
      signal: abort.signal,
    })
    let buffer = ''
    for await (const bytes of response.body) {
      buffer += Buffer.from(bytes).toString('utf8')
      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        const packet = JSON.parse(line)
        if (packet._tag === 'Exit' && packet.exit._tag === 'Failure') throw new Error(line)
        if (packet._tag !== 'Chunk') continue
        for (const value of packet.values) {
          const detail = decode(RpcSerialization.ndjson.codecFor(ThreadDetail), value)
          if (
            detail.runs.length === count &&
            detail.runs.every((run) => run.state._tag === terminal)
          ) {
            if (directory) await json(directory + '/settlement.json', detail)
            return detail
          }
          if (detail.runs.some((run) => run.state._tag === 'Failed'))
            throw new Error(JSON.stringify(detail.runs))
        }
      }
    }
    throw new Error('WatchThread ended before settlement')
  } finally {
    clearTimeout(timeout)
    abort.abort()
  }
}

/** Admission uses the same Person RPC and delivery key as every shipped client. */
export async function admit(state, thread, text, directory, name = 'chat', attachments = []) {
  const body = decode(SendToThreadRequest, {
    threadId: thread,
    text,
    pictures: attachments,
    key: crypto.randomUUID(),
  })
  await json(directory + '/' + name + '.request.json', encode(SendToThreadRequest, body))
  return rpc(state, 'SendToThread', body, directory, name)
}

/** Follow the public conversation link, checking Pi's delta operations before applying them.
 * Every observation owns and closes its HTTP stream, including a first-snapshot history read. */
export async function* conversation(state, thread, { directory, name, ready }) {
  const account = decodeText(
    Account,
    await NodeFSP.readFile(state.scratch + '/account.json', 'utf8'),
  )
  const abort = new AbortController()
  const file = directory + '/' + name + '.ndjson'
  await NodeFSP.writeFile(file, '')
  try {
    const response = await fetch(state.web + '/api/rpc', {
      method: 'POST',
      headers: { cookie: account.cookie, origin: state.web, 'content-type': 'application/ndjson' },
      body:
        JSON.stringify(
          WatchRequest.make({
            id: '1',
            tag: 'WatchConversation',
            payload: { threadId: thread },
            headers: [],
          }),
        ) + '\n',
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(300_000)]),
    })
    if (ready) ready.resolve(response.status)
    await json(directory + '/' + name + '.response.json', {
      tag: 'WatchConversation',
      threadId: thread,
      status: response.status,
    })
    if (!response.ok) throw new Error('WatchConversation HTTP ' + response.status)
    let current
    for await (const frame of frames(response)) {
      await NodeFSP.appendFile(file, JSON.stringify(frame) + '\n')
      current = ConversationFrame.match(frame, {
        Whole: ({ state: whole }) => whole,
        Changes: ({ ops }) => {
          if (!current) throw new Error('Conversation changes arrived before Whole')
          for (const op of ops) {
            assertValidOp(op)
            if (isReplace(op)) throw new Error('Conversation changes replaced Whole')
          }
          return decode(ConversationState, applyImmutable(current, ops))
        },
      })
      yield current
    }
    throw new Error('WatchConversation closed before observation')
  } finally {
    abort.abort()
  }
}

/** A joined delivery reads the reply named by its settlement, never by the product Run id. */
export async function read(state, thread, admission, directory, name = 'stream', ready) {
  const submissionId = admission.run.submissionId
  if (!submissionId) throw new Error('Admitted Run has no runtime submission id')
  for await (const page of conversation(state, thread, { directory, name, ready })) {
    const settlement = page.settlements.find((entry) => entry.submissionId === submissionId)
    if (!settlement) continue
    await json(directory + '/' + name + '-reply.json', { settlement, page })
    if (settlement.outcome !== 'completed')
      throw new Error('Conversation delivery ' + settlement.outcome)
    return page.messages
      .filter(
        (message) => message.role === 'assistant' && message.submissionId === settlement.answeredBy,
      )
      .flatMap((message) => message.parts)
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n\n')
  }
  throw new Error('Conversation ended before settlement')
}
export async function chat(state, thread, text, directory, name = 'chat', attachments = []) {
  return read(
    state,
    thread,
    await admit(state, thread, text, directory, name, attachments),
    directory,
    name,
  )
}

/** A fresh subscription starts with the durable conversation whole, as a client reload does. */
export async function history(state, thread, directory, name = 'history') {
  for await (const page of conversation(state, thread, { directory, name })) {
    await json(directory + '/' + name + '.json', page)
    return page
  }
  throw new Error('Conversation ended before history')
}
/** Pi health advertises the selected model; its protected routes remain token-gated. */
export async function status(state) {
  const response = await fetch(`http://127.0.0.1:${state.ports.runtime}/health`, {
    signal: AbortSignal.timeout(5000),
  })
  if (response.status !== 200) throw new Error(`Runtime health HTTP ${response.status}`)
  return decodeText(RuntimeHealth, await response.text())
}
