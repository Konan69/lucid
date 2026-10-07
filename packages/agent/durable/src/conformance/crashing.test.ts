import { Deferred, Effect, Schema } from 'effect'
import { runForPi } from '../pi.ts'

import * as NodeChildProcess from 'node:child_process'
import * as NodeEvents from 'node:events'
import * as NodeURL from 'node:url'
import { expect, it } from '@effect/vitest'
import { DefaultChatTransport, validateUIMessages, type UIMessage } from 'ai'
import { waitForFrame } from '../fixtures/provider.ts'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { listen, recoveredReply } from '../fixtures/reconnect.ts'
import { resumable, ConnectionLost } from '../client.ts'
import { PlainChat } from '../fixtures/chat.ts'
import { host, texts } from './fixtures/host.ts'
const History = Schema.fromJsonString(Schema.Struct({ messages: Schema.Array(Schema.MutableJson) }))
const decodeHistory = Schema.decodeUnknownSync(History)
/** Kill only this captured child; observe its exit before another process opens its SQLite files. */
function kill(child: NodeChildProcess.ChildProcessWithoutNullStreams) {
  return Effect.gen(function* () {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = NodeEvents.EventEmitter.once(child, 'exit')
    child.kill('SIGKILL')
    yield* Effect.promise(() => exited)
  })
}
/** Same-instance bodyless reconnect after SIGKILL must replace a crash attempt, not append it.
 * Pi generation.js:245–254 converts the interrupted partial into an aborted entry; request:93–97
 * then regenerates on the SAME task. Stock transport retains its private network-error state;
 * the guarded transport discards it. Both must present the final reply exactly once. */
it.live.each(['stock', 'guarded'] as const)(
  'replaces a killed single-step generation with %s transport',
  (kind) =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>()
      const fixture = yield* host(
        {},
        {},
        {},
        {
          onFrame: (event, abortSignal) =>
            event.type === 'text_delta'
              ? waitForFrame(Deferred.await(release), abortSignal)
              : Effect.void,
        },
      )
      const child = NodeChildProcess.spawn(
        process.execPath,
        [NodeURL.fileURLToPath(new URL('../fixtures/reconnect.ts', import.meta.url)), fixture.file],
        { stdio: 'pipe' },
      )
      yield* Effect.addFinalizer(() => kill(child))
      child.stderr.resume()
      const [bound] = yield* Effect.promise(() =>
        NodeEvents.EventEmitter.once(child.stdout, 'data'),
      )
      if (!Buffer.isBuffer(bound)) throw new Error('Expected TCP address')
      let current = bound.toString().trim()
      const partial = yield* Deferred.make<void>()
      const transport = new DefaultChatTransport<UIMessage>({
        api: `${current}/chat`,
        fetch: (url, init) =>
          runForPi(
            Effect.gen(function* () {
              const requested = new URL(url instanceof Request ? url.url : url)
              const response = yield* Effect.promise(() =>
                fetch(new URL(requested.pathname + requested.search, current), init),
              )
              // The GET's prefix proves its atomic watch exists before regeneration may complete.
              if (requested.pathname.endsWith('/stream')) Deferred.doneUnsafe(release, Effect.void)
              return response
            }),
            undefined,
          ),
      })
      const chat = new PlainChat({
        id: 'crashed',
        transport: kind === 'guarded' ? resumable(transport) : transport,
        onMessage: (message) => {
          if (message.role === 'assistant' && texts(message).join('').length > 0)
            Deferred.doneUnsafe(partial, Effect.void)
        },
      })
      const sending = chat.sendMessage({ text: 'Regenerate' })
      yield* Deferred.await(partial)
      const dropped = chat.lastMessage
      if (dropped === undefined) throw new Error('Expected the partial assistant')
      expect(texts(dropped).join('')).not.toBe(recoveredReply)
      yield* kill(child)
      yield* Effect.promise(() => sending)
      expect(chat.status).toBe('error')
      if (kind === 'guarded') expect(chat.error).toBeInstanceOf(ConnectionLost)
      const reopened = yield* fixture.open()
      yield* Effect.addFinalizer(() => Effect.sync(() => Deferred.doneUnsafe(release, Effect.void)))
      reopened.faux.setResponses([fauxAssistantMessage(recoveredReply)])
      reopened.harness.resume()
      const next = yield* listen(reopened.harness, reopened.root)
      current = next.address
      yield* Effect.promise(() => chat.resumeStream())
      expect(chat.status).toBe('ready')
      expect(chat.error).toBeUndefined()
      const last = chat.lastMessage
      if (last === undefined) throw new Error('Expected recovered assistant')
      const response = yield* Effect.promise(() => fetch(`${current}/chat/crashed/history`))
      const body = decodeHistory(yield* Effect.promise(() => response.text()))
      const history = yield* Effect.promise(() => validateUIMessages({ messages: body.messages }))
      const stored = history.at(-1)
      if (stored === undefined) throw new Error('Expected settled history')
      expect(texts(last)).toEqual([recoveredReply])
      expect(last.id).toBe(dropped.id)
      expect(stored.id).toBe(dropped.id)
      expect(texts(last)).toEqual(texts(stored))
      expect(chat.messages.filter((message) => message.role === 'assistant')).toHaveLength(1)
      if (kind === 'guarded') expect(last.parts).toEqual(stored.parts)
    }),
)
