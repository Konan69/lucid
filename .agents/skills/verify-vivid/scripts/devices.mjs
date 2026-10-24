import * as NodeFSP from 'node:fs/promises'
import * as NodeAssert from 'node:assert/strict'
import { DeviceListResponse, DevicePresence, DeviceRequest } from '@vivid/contracts'
import { VividRpc } from '@vivid/contracts/rpc'
import { runtimeHeaders } from '@vivid/contracts/auth'
import { Schema, Result } from 'effect'
import { RpcSerialization } from 'effect/rpc'
import { encode, rpc, json } from './wire.mjs'

const Account = Schema.Struct({ cookie: Schema.String })
const decodeAccount = Schema.decodeUnknownResult(Schema.fromJsonString(Account))
const Request = Schema.TaggedStruct('Request', {
  id: Schema.String,
  tag: Schema.String,
  payload: Schema.Unknown,
  headers: Schema.Array(Schema.Array(Schema.String)),
})

/** Enrolment is the public desktop boundary. Each installation belongs only to this proof. */
export async function enrol(state, directory, name) {
  const installation = crypto.randomUUID()
  const { device } = await rpc(state, 'EnrolDevice', { installation, name }, directory, name)
  NodeAssert.equal(device.access._tag, 'Pending')
  return { device, installation }
}

/** Decode stream values with the production codec and close the owned HTTP body on every exit. */
async function observe(state, request, signal, accept) {
  const { tag, payload } = request
  const account = Result.getOrThrow(
    decodeAccount(await NodeFSP.readFile(state.scratch + '/account.json', 'utf8')),
  )
  const procedure = VividRpc.requests.get(tag)
  NodeAssert.ok(procedure, 'Missing public stream ' + tag)
  const success = { WatchDevices: DeviceListResponse, WatchDeviceRequests: DeviceRequest }[tag]
  const Packet = Schema.TaggedUnion({
    Chunk: { values: Schema.Array(RpcSerialization.ndjson.codecFor(success)) },
    Exit: { exit: Schema.Struct({ _tag: Schema.String }) },
    Pong: {},
  })
  const decodePacket = Schema.decodeUnknownResult(Schema.fromJsonString(Packet))
  const response = await fetch(state.web + '/api/rpc', {
    method: 'POST',
    headers: { cookie: account.cookie, origin: state.web, 'content-type': 'application/ndjson' },
    body: JSON.stringify(Request.make({ id: '1', tag, payload, headers: [] })) + '\n',
    signal,
  })
  NodeAssert.equal(response.status, 200, tag + ' refused')
  let buffer = ''
  for await (const bytes of response.body) {
    buffer += Buffer.from(bytes).toString('utf8')
    let newline
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      const packet = Result.getOrThrow(decodePacket(line))
      const values = Packet.match(packet, {
        Chunk: (chunk) => chunk.values,
        Exit: (exit) => {
          NodeAssert.equal(exit.exit._tag, 'Success', line)
          return []
        },
        Pong: () => [],
      })
      const found = values.find(accept)
      if (found !== undefined) return found
    }
  }
}

/** WatchDevices supplies the publication receipt. Elapsed time never implies connectivity. */
export async function deviceState(state, directory, name, accepts) {
  const abort = new AbortController()
  try {
    const value = await observe(
      state,
      { tag: 'WatchDevices', payload: null },
      AbortSignal.any([abort.signal, AbortSignal.timeout(90_000)]),
      accepts,
    )
    NodeAssert.ok(value, 'WatchDevices ended before ' + name)
    await json(directory + '/' + name + '.json', value)
    return value
  } finally {
    abort.abort()
  }
}

/** Keep a separately allowed device genuinely Connected through its public native request stream. */
export async function connectedOther(state, directory, action) {
  const other = await enrol(state, directory, 'Other computer')
  await rpc(state, 'AllowDevice', { id: other.device.id }, directory, 'allow-other')
  const abort = new AbortController()
  const received = []
  await json(directory + '/native-stream-request.json', {
    tag: 'WatchDeviceRequests',
    device: other.device.id,
    ability: { pages: true, apps: false, egress: false, signins: false },
  })
  const listening = observe(
    state,
    {
      tag: 'WatchDeviceRequests',
      payload: {
        device: other.device.id,
        installation: other.installation,
        ability: { pages: true, apps: false, egress: false, signins: false },
      },
    },
    abort.signal,
    (value) => {
      received.push(value)
      return false
    },
  ).then(
    () => ({ ended: true }),
    (error) => {
      if (abort.signal.aborted) return { aborted: true }
      throw error
    },
  )
  // Observe failures immediately even when the publication observer is still waiting.
  void listening.catch(() => {})
  try {
    await Promise.race([
      deviceState(state, directory, 'other-connected', (list) =>
        list.devices.some(
          (d) => d.id === other.device.id && DevicePresence.guards.Connected(d.presence),
        ),
      ),
      listening.then(() => {
        throw new Error('Native stream ended before Connected receipt')
      }),
    ])
    return await action(other.device)
  } finally {
    abort.abort()
    const receipt = await listening
    await json(directory + '/native-stream-response.json', { received, ...receipt })
    await deviceState(state, directory, 'other-disconnected', (list) =>
      list.devices.some(
        (d) => d.id === other.device.id && DevicePresence.guards.Offline(d.presence),
      ),
    )
    await rpc(state, 'RevokeDevice', { id: other.device.id }, directory, 'revoke-other')
    await json(directory + '/device-stream-cleanup.json', { device: other.device.id, ...receipt })
  }
}

/** Public RPC evidence covers durable Pending and explicit decisions without invoking any model. */
export async function devices(state, _thread, directory) {
  await connectedOther(state, directory, async (other) => {
    const pending = await enrol(state, directory, 'Pending computer')
    const repeated = await rpc(
      state,
      'EnrolDevice',
      {
        installation: pending.installation,
        name: pending.device.name,
      },
      directory,
      'repeat-enrolment',
    )
    NodeAssert.deepEqual(repeated.device.access, pending.device.access)
    const list = await rpc(state, 'ListDevices', undefined, directory, 'pending-list')
    NodeAssert.deepEqual(
      list.devices.find((d) => d.id === pending.device.id),
      pending.device,
    )
    NodeAssert.equal(list.devices.find((d) => d.id === other.id).presence._tag, 'Connected')
    const allowed = await rpc(state, 'AllowDevice', { id: pending.device.id }, directory)
    NodeAssert.equal(allowed.device.access._tag, 'Allowed')
    const switched = await rpc(state, 'ListDevices', undefined, directory, 'switched-list')
    NodeAssert.equal(switched.devices.find((d) => d.id === other.id).access._tag, 'Revoked')
    const revoked = await rpc(state, 'RevokeDevice', { id: pending.device.id }, directory)
    NodeAssert.equal(revoked.device.access._tag, 'Revoked')
    const denied = await enrol(state, directory, 'Denied computer')
    const decision = await rpc(state, 'RevokeDevice', { id: denied.device.id }, directory, 'deny')
    NodeAssert.equal(decision.device.access._tag, 'Revoked')
    const again = await rpc(
      state,
      'EnrolDevice',
      {
        installation: denied.installation,
        name: denied.device.name,
      },
      directory,
      'denied-reenrolment',
    )
    NodeAssert.deepEqual(again.device.access, decision.device.access)
  })
  await json(directory + '/scope.json', {
    modelCalls: 0,
    restart:
      'unsupported: supervisor only supports capture and cleanup; fresh-registry and deadline proof belong to database integration suite',
    scope:
      'public enrolment, repeated enrolment, connected-other Pending, Allow, Deny, revoke and owned stream closure',
  })
}

/** AskInput is the shipped runtime RPC, authenticated for the disposable Person and Thread.
 * This creates a real question through its owning handler, without a model or database fixture.
 * It proves coexistence of controls only, not model question generation or answer delivery. */
export async function askQuestion(state, thread, directory) {
  const procedure = VividRpc.requests.get('AskInput')
  NodeAssert.ok(procedure)
  const payload = encode(RpcSerialization.ndjson.codecFor(procedure.payloadSchema), {
    questions: [
      {
        question: 'Which colour should the verification use?',
        options: [
          { label: 'Amber', detail: 'Use amber.' },
          { label: 'Indigo', detail: 'Use indigo.' },
        ],
        selection: 'One',
        allowsOwnAnswer: false,
      },
    ],
  })
  const token = await NodeFSP.readFile(state.scratch + '/runtime-token', 'utf8')
  const response = await fetch(state.web + '/api/rpc', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + token,
      origin: state.web,
      [runtimeHeaders.thread]: thread,
      [runtimeHeaders.actor]: state.person,
      'content-type': 'application/ndjson',
    },
    body: JSON.stringify(Request.make({ id: '1', tag: 'AskInput', payload, headers: [] })) + '\n',
    signal: AbortSignal.timeout(90_000),
  })
  const text = await response.text()
  await json(directory + '/coexisting-question.json', {
    status: response.status,
    payload,
    body: text,
  })
  NodeAssert.equal(response.status, 200)
  const Answer = Schema.TaggedStruct('Exit', {
    exit: Schema.TaggedStruct('Success', {
      value: RpcSerialization.ndjson.codecFor(procedure.successSchema),
    }),
  })
  const decodeAnswer = Schema.decodeUnknownResult(Schema.fromJsonString(Answer))
  const packets = text
    .trim()
    .split('\n')
    .map((line) => Result.getOrThrow(decodeAnswer(line)))
  NodeAssert.equal(packets.length, 1, 'Expected one AskInput RPC exit')
  const result = packets[0].exit.value
  NodeAssert.equal(result.request.state._tag, 'Waiting')
  return result.request
}
