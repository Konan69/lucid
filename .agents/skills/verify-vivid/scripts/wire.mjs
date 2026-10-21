import * as NodeFSP from 'node:fs/promises'
import { Schema, Result } from 'effect'
import { RpcSerialization } from 'effect/rpc'
import { SendMessageRequest, ThreadDetail } from '@vivid/contracts'
import { VividRpc } from '@vivid/contracts/rpc'
import { json } from './process.mjs'
export { json } from './process.mjs'

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
          const detail = decode(ThreadDetail, value)
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

/** Main's Person gateway uses SendMessageRequest, not migration's ai ChatBody. */
export async function admit(state, thread, text, directory, name = 'chat', attachments = []) {
  const body = encode(SendMessageRequest, {
    kind: 'user',
    body: text,
    idempotencyKey: crypto.randomUUID(),
    attachments,
  })
  await json(directory + '/' + name + '.request.json', body)
  return request(state, `/api/vivid/${thread}`, { method: 'POST', body, directory, name })
}

/** The installed public SDK validates live chunks and waits on Flue's durable submission signal.
 * Recording wraps only fetch: bytes, status and route are captured without altering the protocol. */
export async function client(state, thread, directory, name = 'stream', ready) {
  const flue = await import('@flue/sdk')
  const account = JSON.parse(await NodeFSP.readFile(state.scratch + '/account.json', 'utf8'))
  let number = 0
  return flue.createFlueClient({
    url: state.web + `/api/vivid/${thread}`,
    headers: { cookie: account.cookie, origin: state.web },
    fetch: async (input, options) => {
      const response = await fetch(input, options)
      if (ready) ready.resolve(response.status)
      const file = directory + '/' + name + '-' + ++number
      await json(file + '.json', {
        url: String(input),
        status: response.status,
        contentType: response.headers.get('content-type'),
      })
      await NodeFSP.writeFile(file + '.sse', '')
      const capture = new TransformStream({
        async transform(bytes, controller) {
          await NodeFSP.appendFile(file + '.sse', bytes)
          controller.enqueue(bytes)
        },
      })
      return new Response(response.body.pipeThrough(capture), {
        status: response.status,
        headers: response.headers,
      })
    },
  })
}

/** Separate admission from observation for held-tool, reconnect and stop recipes. */
export async function read(state, thread, admission, directory, name = 'stream', ready) {
  const api = await client(state, thread, directory, name, ready)
  const reply = await api.read(admission, { signal: AbortSignal.timeout(300_000) })
  await json(directory + '/' + name + '-reply.json', reply)
  return reply.text
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

/** Main's web client asks for Flue's history view through the same server gateway. */
export async function history(state, thread, directory, name = 'history') {
  const api = await client(state, thread, directory, name)
  const page = await api.history({ signal: AbortSignal.timeout(15_000) })
  await json(directory + '/' + name + '.json', page)
  return page
}
/** Flue health advertises the selected model; its protected routes remain token-gated. */
export async function status(state) {
  const response = await fetch(`http://127.0.0.1:${state.ports.runtime}/health`, {
    signal: AbortSignal.timeout(5000),
  })
  if (response.status !== 200) throw new Error(`Runtime health HTTP ${response.status}`)
  return decode(
    Schema.Struct({ model: Schema.String, service: Schema.String, status: Schema.String }),
    await response.json(),
  )
}
