import * as NodeChildProcess from 'node:child_process'
import * as NodeEvents from 'node:events'
import * as NodeFSP from 'node:fs/promises'
import * as NodeHttp from 'node:http'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeReadline from 'node:readline'
import * as NodeURL from 'node:url'

import { Chat } from '@ai-sdk/react'
import { expect, it } from '@effect/vitest'
import { HoldId } from '@vivid/durable/core'
import {
  DefaultChatTransport,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
  validateUIMessages,
  type UIMessage,
} from 'ai'
import { Effect, Schema } from 'effect'

import { start } from './serve.ts'

const decodeListeningAddress = Schema.decodeUnknownSync(Schema.URLFromString)
const History = Schema.Struct({ messages: Schema.Array(Schema.MutableJson) })
const decodeHistory = Schema.decodeUnknownSync(Schema.fromJsonString(History))
const decodeWaiting = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        holdId: HoldId,
        callId: Schema.String,
        toolName: Schema.String,
        kind: Schema.Literals(['approval', 'answer', 'later']),
      }),
    ),
  ),
)

/** Subscribe to SDK state, without timers or polling; remove all listeners on either settlement. */
function observed(chat: Chat<UIMessage>, predicate: () => boolean) {
  const events = new NodeEvents.EventEmitter<{ settled: []; error: [Error] }>()
  const promise = NodeEvents.EventEmitter.once(events, 'settled').then(() => {})
  const releases: (() => void)[] = []
  const inspect = () => {
    if (chat.error !== undefined) {
      releases.forEach((release) => release())
      events.emit('error', chat.error)
    } else if (predicate()) {
      releases.forEach((release) => release())
      events.emit('settled')
    }
  }
  releases.push(
    chat['~registerMessagesCallback'](inspect),
    chat['~registerStatusCallback'](inspect),
    chat['~registerErrorCallback'](inspect),
  )
  inspect()
  return promise
}

/** Use the installed SDK's concrete Chat, since ai itself exports only AbstractChat. */
function client(address: string, id: string) {
  return new Chat<UIMessage>({
    id,
    transport: new DefaultChatTransport({ api: `${address}/chat` }),
    sendAutomaticallyWhen: (input) =>
      lastAssistantMessageIsCompleteWithApprovalResponses(input) ||
      lastAssistantMessageIsCompleteWithToolCalls(input),
  })
}

/** Read text only; tool state is checked independently in the approval and answer cases. */
function text(chat: Chat<UIMessage>) {
  const message = chat.lastMessage
  if (message === undefined || message.role !== 'assistant') return ''
  return message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
}

/** Validate server history through the stock SDK at this real HTTP response boundary. */
async function history(address: string, id: string) {
  const response = await fetch(`${address}/chat/${id}/history`)
  expect(response.status).toBe(200)
  const body = decodeHistory(await response.text())
  return validateUIMessages({ messages: body.messages })
}

/** Pi owns durable entry ids; compare all observable roles and parts, as conformance/history does. */
function contents(messages: UIMessage[]) {
  return messages.map((message) => ({ role: message.role, parts: message.parts }))
}

/** A finished tool turn must retain its assistant and its observable tool parts. */
function toolParts(chat: Chat<UIMessage>) {
  const message = chat.lastMessage
  if (message === undefined) throw new Error('Expected an assistant message')
  return message.parts.filter(isToolUIPart)
}

/** Approval identity is the stock SDK part's opaque approval id, never its provider call id. */
function approval(chat: Chat<UIMessage>) {
  const message = chat.lastMessage
  if (message === undefined) throw new Error('Expected an assistant message')
  const part = message.parts.find(isToolUIPart)
  if (part === undefined || part.state !== 'approval-requested')
    throw new Error('Expected a stock approval part')
  return part.approval.id
}

/** Echo uses the default transport's POST and global fetch, with no in-process request adapter. */
async function echo(chat: Chat<UIMessage>) {
  await chat.sendMessage({ text: 'hello' })
  expect(chat.status).toBe('ready')
  expect(chat.error).toBeUndefined()
  expect(text(chat)).toBe('Echo: hello')
}

/** A fetch abort detaches observation; hydrate history before the SDK's actual GET reconnect. */
async function slow(chat: Chat<UIMessage>, address: string) {
  const shown = observed(chat, () => chat.status === 'streaming' && text(chat).length > 0)
  const sent = chat.sendMessage({ text: 'slow' })
  await shown
  const prefix = text(chat)
  await chat.stop()
  await sent
  expect(chat.status).toBe('ready')
  expect(prefix).not.toContain('The final sentence')
  chat.messages = await history(address, chat.id)
  await chat.resumeStream()
  expect(chat.status).toBe('ready')
  expect(chat.error).toBeUndefined()
  expect(text(chat)).toBe(
    'This reply arrives a little at a time. You can disconnect while these sentences are streaming. Reconnect to the same chat and the durable turn will continue. The final sentence confirms that the whole reply arrived.',
  )
}

/** The public stock approval predicate automatically sends the tool settlement continuation. */
async function approve(chat: Chat<UIMessage>) {
  await chat.sendMessage({ text: 'approve' })
  const finished = observed(
    chat,
    () => chat.status === 'ready' && text(chat) === 'Payment confirmed.',
  )
  await chat.addToolApprovalResponse({ id: approval(chat), approved: true })
  await finished
  expect(toolParts(chat)).toMatchObject([
    { type: 'tool-pay', state: 'output-available', output: { receipt: 100 } },
  ])
}

/** The stock denial continuation must keep the denied part and tell the person no payment occurred. */
async function deny(chat: Chat<UIMessage>) {
  await chat.sendMessage({ text: 'approve' })
  const finished = observed(
    chat,
    () => chat.status === 'ready' && text(chat).startsWith('Payment was not made:'),
  )
  await chat.addToolApprovalResponse({
    id: approval(chat),
    approved: false,
    reason: 'too expensive',
  })
  await finished
  expect(toolParts(chat)).toMatchObject([{ type: 'tool-pay', state: 'output-denied' }])
  expect(text(chat)).toContain('too expensive')
  expect(text(chat)).not.toContain('Payment confirmed.')
}

/** A tool without execute waits for addToolOutput, which the stock tool-call predicate sends. */
async function ask(chat: Chat<UIMessage>) {
  await chat.sendMessage({ text: 'ask' })
  const message = chat.lastMessage
  if (message === undefined) throw new Error('Expected an assistant message')
  const part = message.parts.find(isToolUIPart)
  if (part === undefined || part.state !== 'input-available')
    throw new Error('Expected a client tool')
  const finished = observed(chat, () => chat.status === 'ready' && text(chat).includes('savings'))
  await chat.addToolOutput({ tool: 'ask', toolCallId: part.toolCallId, output: 'savings' })
  await finished
  expect(toolParts(chat)).toMatchObject([
    { type: 'tool-ask', state: 'output-available', output: 'savings' },
  ])
}

const cases = { echo, slow, approve, deny, ask }

/** Omit Content-Length to prove the host also enforces its limit while reading chunked bytes. */
function oversizedChunks(address: string) {
  return Effect.callback<number, Error>((resume) => {
    const request = NodeHttp.request(`${address}/chat`, { method: 'POST' }, (response) => {
      response.resume()
      const status = response.statusCode
      if (status === undefined) resume(Effect.fail(new Error('Expected an HTTP status')))
      else resume(Effect.succeed(status))
    })
    request.on('error', (error) => resume(Effect.fail(error)))
    request.write('x'.repeat(5 * 1024 * 1024))
    request.end('x')
    return Effect.sync(() => request.destroy())
  })
}

/** The standalone action routes settle the same public waiting identity as SDK continuations. */
async function actionRoutes(address: string, kind: 'approve' | 'deny' | 'ask') {
  const chat = client(address, `action-${kind}`)
  await chat.sendMessage({ text: kind === 'deny' ? 'approve' : kind })
  const waiting = await fetch(`${address}/chat/${chat.id}/waiting`)
  expect(waiting.status).toBe(200)
  const rows = decodeWaiting(await waiting.text())
  expect(rows).toHaveLength(1)
  const row = rows[0]
  if (row === undefined) throw new Error('Expected a waiting tool')
  expect(row.kind).toBe(kind === 'ask' ? 'answer' : 'approval')
  const decision =
    kind !== 'ask'
      ? await fetch(`${address}/chat/${chat.id}/decide`, {
          method: 'POST',
          body: JSON.stringify({
            holdId: row.holdId,
            approved: kind === 'approve',
            reason: 'too expensive',
          }),
        })
      : await fetch(`${address}/chat/${chat.id}/answer`, {
          method: 'POST',
          body: JSON.stringify({ holdId: row.holdId, output: 'savings' }),
        })
  expect(decision.status).toBe(200)
  chat.messages = await history(address, chat.id)
  await chat.resumeStream()
  const settled = await history(address, chat.id)
  const assistant = settled.at(-1)
  if (assistant === undefined) throw new Error('Expected settled history')
  expect(assistant.role).toBe('assistant')
  const result = assistant.parts
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('')
  if (kind === 'deny') {
    expect(result).toContain('Payment was not made:')
    expect(result).toContain('too expensive')
    expect(result).not.toContain('Payment confirmed.')
  } else expect(result).toContain(kind === 'approve' ? 'Payment confirmed.' : 'savings')
  const cleared = await fetch(`${address}/chat/${chat.id}/waiting`)
  expect(decodeWaiting(await cleared.text())).toEqual([])
}

/** Explicit abort stops the durable run, unlike the fetch abort exercised by the slow case. */
async function abortRoute(address: string) {
  const chat = client(address, 'action-abort')
  const shown = observed(chat, () => chat.status === 'streaming' && text(chat).length > 0)
  const sent = chat.sendMessage({ text: 'slow' })
  await shown
  const stopped = await fetch(`${address}/chat/${chat.id}/abort`, { method: 'POST' })
  expect(stopped.status).toBe(204)
  await sent
  const idle = await fetch(`${address}/chat/${chat.id}/stream`)
  expect(idle.status).toBe(204)
  const stored = await history(address, chat.id)
  expect(stored[0]).toMatchObject({ role: 'user', parts: [{ type: 'text', text: 'slow' }] })
}

// The bound host, global fetch, SDK Chat, SQLite restart and history are all real public seams.
it.live.each(['echo', 'slow', 'approve', 'deny', 'ask'] as const)(
  'serves %s over TCP and preserves its SDK history after restart',
  (kind) =>
    Effect.scoped(
      Effect.gen(function* () {
        const dataDirectory = yield* Effect.acquireRelease(
          Effect.promise(() =>
            NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'durable-example-test-')),
          ),
          (directory) =>
            Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
        )
        const options = { host: '127.0.0.1', port: 0, dataDirectory }
        const first = yield* Effect.acquireRelease(
          Effect.promise(() => start(options)),
          (host) => Effect.promise(() => host.close()),
        )
        const chat = client(first.address, `tcp-${kind}`)
        yield* Effect.promise(() => cases[kind](chat, first.address))
        const settled = yield* Effect.promise(() => history(first.address, chat.id))
        expect(contents(settled)).toEqual(contents(chat.messages))
        yield* Effect.promise(() => first.close())
        const second = yield* Effect.acquireRelease(
          Effect.promise(() => start(options)),
          (host) => Effect.promise(() => host.close()),
        )
        const restored = yield* Effect.promise(() => history(second.address, chat.id))
        expect(restored).toEqual(settled)
        expect(contents(restored)).toEqual(contents(chat.messages))
        const continued = client(second.address, chat.id)
        continued.messages = restored
        yield* Effect.promise(() => continued.sendMessage({ text: 'after restart' }))
        expect(text(continued)).toBe('Echo: after restart')
        const after = yield* Effect.promise(() => history(second.address, chat.id))
        expect(contents(after)).toEqual(contents(continued.messages))
      }),
    ),
)

// Reject oversized and malformed ingress before conversation creation; preflight is development CORS.
it.live('bounds HTTP request bytes and handles CORS, malformed input and missing chats', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const dataDirectory = yield* Effect.acquireRelease(
        Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'durable-example-test-')),
        ),
        (directory) =>
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
      )
      const host = yield* Effect.acquireRelease(
        Effect.promise(() => start({ host: '127.0.0.1', port: 0, dataDirectory })),
        (opened) => Effect.promise(() => opened.close()),
      )
      yield* Effect.promise(async () => {
        const preflight = await fetch(`${host.address}/chat`, { method: 'OPTIONS' })
        expect(preflight.status).toBe(204)
        expect(preflight.headers.get('access-control-allow-origin')).toBe('*')
        const invalid = await fetch(`${host.address}/chat`, { method: 'POST', body: '{}' })
        expect(invalid.status).toBe(400)
        for (const id of ['.', '..']) {
          const inaccessible = await fetch(`${host.address}/chat`, {
            method: 'POST',
            body: JSON.stringify({
              id,
              messages: [{ id: 'dot', role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
            }),
          })
          expect(inaccessible.status).toBe(400)
        }
        const oversized = await fetch(`${host.address}/chat`, {
          method: 'POST',
          body: 'x'.repeat(5 * 1024 * 1024 + 1),
        })
        expect(oversized.status).toBe(413)
        const missing = await fetch(`${host.address}/chat/missing/history`)
        expect(missing.status).toBe(404)
        const wrongMethod = await fetch(`${host.address}/chat/missing/stream`, {
          method: 'POST',
          body: '{}',
        })
        expect(wrongMethod.status).toBe(405)
      })
      expect(yield* oversizedChunks(host.address)).toBe(413)
    }),
  ),
)

// Exercise the routes a non-chat client can use, still over real TCP with the same harness authority.
it.live('serves waiting, decide, answer and explicit abort routes', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const dataDirectory = yield* Effect.acquireRelease(
        Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'durable-example-test-')),
        ),
        (directory) =>
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
      )
      const host = yield* Effect.acquireRelease(
        Effect.promise(() => start({ host: '127.0.0.1', port: 0, dataDirectory })),
        (opened) => Effect.promise(() => opened.close()),
      )
      yield* Effect.promise(() => actionRoutes(host.address, 'approve'))
      yield* Effect.promise(() => actionRoutes(host.address, 'deny'))
      yield* Effect.promise(() => actionRoutes(host.address, 'ask'))
      yield* Effect.promise(() => abortRoute(host.address))
    }),
  ),
)

/** Own only a PID returned by spawn; finalization never finds or kills another session's process. */
function processHost(directory: string) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const child = NodeChildProcess.spawn(
        process.execPath,
        [NodeURL.fileURLToPath(new URL('./serve.ts', import.meta.url))],
        {
          stdio: 'pipe',
          env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DURABLE_DATA: directory },
        },
      )
      const pid = child.pid
      if (pid === undefined) throw new Error('Expected the spawned example PID')
      const diagnostics: string[] = []
      const events = new NodeEvents.EventEmitter<{ warning: [] }>()
      const warning = NodeEvents.EventEmitter.once(events, 'warning').then(() => {})
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        diagnostics.push(chunk)
        if (diagnostics.join('').includes('Unauthenticated development example'))
          events.emit('warning')
      })
      return { child, pid, diagnostics, warning }
    }),
    (host) => Effect.promise(() => killHost(host)),
  )
}

type ProcessHost = {
  readonly child: NodeChildProcess.ChildProcessWithoutNullStreams
  readonly pid: number
  readonly diagnostics: string[]
  readonly warning: Promise<void>
}

/** Harness.beforeClose joins task invocations; SIGKILL models a real crash instead of awaiting close. */
async function killHost(host: ProcessHost) {
  if (host.child.exitCode !== null || host.child.signalCode !== null) return
  const exited = NodeEvents.EventEmitter.once(host.child, 'exit')
  process.kill(host.pid, 'SIGKILL')
  await exited
}

/** Wait for the CLI's actual bind receipt, and verify its warning is emitted once per startup. */
async function boundAddress(host: ProcessHost) {
  const lines = NodeReadline.createInterface({ input: host.child.stdout })
  try {
    for await (const line of lines) {
      const prefix = 'Durable example listening at '
      if (line.startsWith(prefix)) {
        const bound = decodeListeningAddress(line.slice(prefix.length).split(' ')[0])
        await host.warning
        expect(
          host.diagnostics.join('').match(/Unauthenticated development example/gu),
        ).toHaveLength(1)
        return bound.origin
      }
    }
    throw new Error('Example process exited before listening')
  } finally {
    lines.close()
    host.child.stdout.resume()
  }
}

// Pi 1.0.4 README "Persist and Resume"; a read-only GET must finish recovered work without another POST.
it.live.each(['slow', 'approve'] as const)(
  'recovers a crashed %s turn over TCP exactly once',
  (kind) =>
    Effect.scoped(
      Effect.gen(function* () {
        const dataDirectory = yield* Effect.acquireRelease(
          Effect.promise(() =>
            NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'durable-example-crash-')),
          ),
          (directory) =>
            Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
        )
        const crashed = yield* processHost(dataDirectory)
        const firstAddress = yield* Effect.promise(() => boundAddress(crashed))
        const original = client(firstAddress, `crash-${kind}`)
        if (kind === 'slow') {
          const shown = observed(
            original,
            () => original.status === 'streaming' && text(original).length > 0,
          )
          const sent = original.sendMessage({ text: 'slow' })
          yield* Effect.promise(() => shown)
          expect(text(original)).not.toContain('The final sentence')
          yield* Effect.promise(() => killHost(crashed))
          yield* Effect.promise(() => sent)
        } else {
          yield* Effect.promise(() => original.sendMessage({ text: 'approve' }))
          expect(toolParts(original)).toMatchObject([
            { type: 'tool-pay', state: 'approval-requested' },
          ])
          yield* Effect.promise(() => killHost(crashed))
        }
        const reopened = yield* Effect.acquireRelease(
          Effect.promise(() => start({ host: '127.0.0.1', port: 0, dataDirectory })),
          (host) => Effect.promise(() => host.close()),
        )
        const resumed = client(reopened.address, original.id)
        resumed.messages = yield* Effect.promise(() => history(reopened.address, original.id))
        yield* Effect.promise(() => resumed.resumeStream())
        if (kind === 'approve') {
          expect(approval(resumed)).toBe(approval(original))
          const finished = observed(
            resumed,
            () => resumed.status === 'ready' && text(resumed) === 'Payment confirmed.',
          )
          yield* Effect.promise(async () =>
            resumed.addToolApprovalResponse({ id: approval(resumed), approved: true }),
          )
          yield* Effect.promise(() => finished)
          expect(toolParts(resumed)).toMatchObject([
            { type: 'tool-pay', state: 'output-available', output: { receipt: 100 } },
          ])
        } else
          expect(text(resumed)).toContain(
            'The final sentence confirms that the whole reply arrived.',
          )
        expect(resumed.status).toBe('ready')
        expect(resumed.error).toBeUndefined()
        const stored = yield* Effect.promise(() => history(reopened.address, original.id))
        expect(stored.map((message) => message.role)).toEqual(['user', 'assistant'])
        expect(contents(stored)).toEqual(contents(resumed.messages))
        expect(yield* Effect.promise(() => history(reopened.address, original.id))).toEqual(stored)
      }),
    ),
)

// The CLI bind receipt promises safe shutdown even when a signal arrives immediately afterwards.
it.live.each(['SIGINT', 'SIGTERM'] as const)('closes the executable host on %s', (stop) =>
  Effect.scoped(
    Effect.gen(function* () {
      const dataDirectory = yield* Effect.acquireRelease(
        Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'durable-example-signal-')),
        ),
        (directory) =>
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
      )
      const host = yield* processHost(dataDirectory)
      yield* Effect.promise(() => boundAddress(host))
      yield* Effect.promise(async () => {
        const exited = NodeEvents.EventEmitter.once(host.child, 'exit')
        process.kill(host.pid, stop)
        const [code, signal] = await exited
        expect(code).toBe(0)
        expect(signal).toBeNull()
      })
    }),
  ),
)
