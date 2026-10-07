import * as NodeChildProcess from 'node:child_process'
import * as NodeEvents from 'node:events'
import * as NodeURL from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { DefaultChatTransport, validateUIMessages, type UIMessage } from 'ai'
import { Effect, Schema } from 'effect'
import { waitForFrame } from '../fixtures/provider.ts'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { listen, close, recoveredReply } from '../fixtures/reconnect.ts'
import { resumable, ConnectionLost } from '../client.ts'
import { PlainChat } from '../fixtures/chat.ts'
import { host, signal, texts } from './fixtures/host.ts'

const History = Schema.fromJsonString(Schema.Struct({ messages: Schema.Array(Schema.MutableJson) }))
const decodeHistory = Schema.decodeUnknownSync(History)

/** Kill only this captured child; observe its exit before another process opens its SQLite files. */
async function kill(child: NodeChildProcess.ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = NodeEvents.EventEmitter.once(child, 'exit')
  child.kill('SIGKILL')
  await exited
}

/** Same-instance bodyless reconnect after SIGKILL must replace a crash attempt, not append it.
 * Pi generation.js:245–254 converts the interrupted partial into an aborted entry; request:93–97
 * then regenerates on the SAME task. Stock transport retains its private network-error state;
 * the guarded transport discards it. Both must present the final reply exactly once. */
it.each(['stock', 'guarded'] as const)(
  'replaces a killed single-step generation with %s transport',
  async (kind) => {
    const release = signal()
    onTestFinished(() => release.resolve())
    const fixture = await host(
      {},
      {},
      {},
      {
        onFrame: (event, abortSignal) =>
          event.type === 'text_delta'
            ? waitForFrame(
                Effect.promise(() => release.promise),
                abortSignal,
              )
            : Effect.void,
      },
    )
    const child = NodeChildProcess.spawn(
      process.execPath,
      [NodeURL.fileURLToPath(new URL('../fixtures/reconnect.ts', import.meta.url)), fixture.file],
      { stdio: 'pipe' },
    )
    onTestFinished(() => kill(child))
    child.stderr.resume()
    const [bound] = await NodeEvents.EventEmitter.once(child.stdout, 'data')
    if (!Buffer.isBuffer(bound)) throw new Error('Expected TCP address')
    let current = bound.toString().trim()
    const partial = signal()
    const transport = new DefaultChatTransport<UIMessage>({
      api: `${current}/chat`,
      fetch: async (url, init) => {
        const requested = new URL(url instanceof Request ? url.url : url)
        const response = await fetch(new URL(requested.pathname + requested.search, current), init)
        // The GET's prefix proves its atomic watch exists before regeneration may complete.
        if (requested.pathname.endsWith('/stream')) release.resolve()
        return response
      },
    })
    const chat = new PlainChat({
      id: 'crashed',
      transport: kind === 'guarded' ? resumable(transport) : transport,
      onMessage: (message) => {
        if (message.role === 'assistant' && texts(message).join('').length > 0) partial.resolve()
      },
    })
    const sending = chat.sendMessage({ text: 'Regenerate' })
    await partial.promise
    const dropped = chat.lastMessage
    if (dropped === undefined) throw new Error('Expected the partial assistant')
    expect(texts(dropped).join('')).not.toBe(recoveredReply)
    await kill(child)
    await sending
    expect(chat.status).toBe('error')
    if (kind === 'guarded') expect(chat.error).toBeInstanceOf(ConnectionLost)
    const reopened = await fixture.open()
    reopened.faux.setResponses([fauxAssistantMessage(recoveredReply)])
    reopened.harness.resume()
    const next = await listen(reopened.harness, reopened.root)
    onTestFinished(() => close(next.server))
    current = next.address
    await chat.resumeStream()
    expect(chat.status).toBe('ready')
    expect(chat.error).toBeUndefined()
    const last = chat.lastMessage
    if (last === undefined) throw new Error('Expected recovered assistant')
    const response = await fetch(`${current}/chat/crashed/history`)
    const body = decodeHistory(await response.text())
    const history = await validateUIMessages({ messages: body.messages })
    const stored = history.at(-1)
    if (stored === undefined) throw new Error('Expected settled history')
    expect(texts(last)).toEqual([recoveredReply])
    expect(texts(last)).toEqual(texts(stored))
    expect(chat.messages.filter((message) => message.role === 'assistant')).toHaveLength(1)
    if (kind === 'guarded') expect(last.parts).toEqual(stored.parts)
  },
)
