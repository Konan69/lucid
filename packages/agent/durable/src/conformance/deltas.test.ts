import { runForPi } from '../pi.ts'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from '@effect/vitest'
import {
  type ChatTransport,
  type UIMessage,
  type UIMessageChunk,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  tool,
} from 'ai'
import { Effect, Option, Predicate, Schema, Deferred } from 'effect'
import { z } from 'zod'
import { client, Decision } from '../fixtures/chat.ts'
import { providerFamilies, waitForFrame } from '../fixtures/provider.ts'
import { host } from './fixtures/host.ts'

const partialInput = Schema.decodeUnknownOption(Schema.Struct({ input: Schema.String }))

/** Observe stock transport chunks without replacing its parsing or the Chat stream reader. */
function recording(
  transport: ChatTransport<UIMessage>,
  chunks: UIMessageChunk[],
): ChatTransport<UIMessage> {
  return {
    reconnectToStream: (request) => transport.reconnectToStream(request),
    sendMessages: (request) =>
      runForPi(
        Effect.gen(function* () {
          return (yield* Effect.promise(() => transport.sendMessages(request))).pipeThrough(
            new TransformStream({
              transform(chunk, controller) {
                chunks.push(chunk)
                controller.enqueue(chunk)
              },
            }),
          )
        }),
        undefined,
      ),
  }
}

/** Source-derived raw partials grow in real SDK state; parsed-only/grammar shapes never invent JSON. */
it.live.each([...providerFamilies, 'parsed', 'custom'] as const)(
  'streams %s input through stock Chat before final approval',
  (partialFamily) =>
    Effect.gen(function* () {
      const raw = partialFamily !== 'parsed' && partialFamily !== 'custom'
      const first = yield* Deferred.make<void>()
      const second = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()
      const releaseSecond = yield* Deferred.make<void>()
      const input = { input: 'abcdefghijklmnopqrstuvwxyz' }
      const paid: (typeof input)[] = []
      let gated = 0
      const fixture = yield* host(
        {
          pay: tool({
            inputSchema: z.object({ input: z.string() }),
            execute: (args) => {
              paid.push(args)
              return Promise.resolve(args)
            },
          }),
        },
        { approval: { pay: true } },
        { progress: { partialIntervalMs: 1 } },
        {
          partialFamily,
          tokenSize: { min: 1, max: 1 },
          onFrame: (event, abortSignal) => {
            if (event.type !== 'toolcall_delta') return Effect.void
            const block = event.partial.content[event.contentIndex]
            if (block === undefined || block.type !== 'toolCall') throw new Error('Expected tool')
            const text = block.arguments.input
            if (!Predicate.isString(text)) return Effect.void
            if (gated === 0 && (!raw || text.length >= 5)) {
              gated = 1
              return waitForFrame(Deferred.await(releaseFirst), abortSignal)
            }
            if (raw && gated === 1 && text.length >= 15) {
              gated = 2
              return waitForFrame(Deferred.await(releaseSecond), abortSignal)
            }
            return Effect.void
          },
        },
      )
      const opened = yield* fixture.open()
      // Release provider gates before the scoped harness waits for its running work.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          Deferred.doneUnsafe(releaseFirst, Effect.void)
          Deferred.doneUnsafe(releaseSecond, Effect.void)
        }),
      )
      opened.faux.setResponses([
        fauxAssistantMessage([fauxToolCall('pay', input, { id: 'streamed' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('Done.'),
      ])
      const chunks: UIMessageChunk[] = []
      const { chat, next } = client({
        transport: recording(opened.transport, chunks),
        sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
        onMessage: (message) => {
          const part = message.parts.find(isToolUIPart)
          if (part === undefined || part.state !== 'input-streaming') return
          if (!raw) {
            Deferred.doneUnsafe(first, Effect.void)
            return
          }
          const value = partialInput(part.input)
          if (Option.isNone(value)) return
          if (value.value.input.length >= 5) Deferred.doneUnsafe(first, Effect.void)
          if (value.value.input.length >= 15) Deferred.doneUnsafe(second, Effect.void)
        },
      })
      let done = next()
      const sent = chat.sendMessage({ text: 'Pay' })
      yield* Deferred.await(first)
      expect(
        chunks.some(
          (chunk) =>
            chunk.type === 'tool-input-available' || chunk.type === 'tool-approval-request',
        ),
      ).toBe(false)
      expect(paid).toEqual([])
      yield* Deferred.succeed(releaseFirst, undefined)
      if (raw) {
        yield* Deferred.await(second)
        expect(chunks.filter((chunk) => chunk.type === 'tool-input-delta').length).toBeGreaterThan(
          1,
        )
        expect(chunks.some((chunk) => chunk.type === 'tool-input-available')).toBe(false)
      }
      yield* Deferred.succeed(releaseSecond, undefined)
      yield* Effect.promise(() => sent)
      expect(yield* done).toEqual(Decision.cases.Settled.make({}))
      if (chat.lastMessage === undefined) throw new Error('Expected message')
      const part = chat.lastMessage.parts.find(isToolUIPart)
      if (part === undefined || part.state !== 'approval-requested')
        throw new Error('Expected approval')
      expect(part.input).toEqual(input)
      const deltas = chunks.flatMap((chunk) =>
        chunk.type === 'tool-input-delta' ? [chunk.inputTextDelta] : [],
      )
      expect(raw ? deltas.length > 1 : deltas.length === 0).toBe(true)
      expect(JSON.stringify(input).startsWith(deltas.join(''))).toBe(true)
      expect(chunks.filter((chunk) => chunk.type === 'tool-input-start')).toHaveLength(1)
      expect(chunks.filter((chunk) => chunk.type === 'tool-input-available')).toHaveLength(1)
      done = next()
      yield* Effect.promise(() =>
        Promise.resolve(chat.addToolApprovalResponse({ id: part.approval.id, approved: true })),
      )
      expect(yield* done).toEqual(Decision.cases.Settled.make({}))
      expect(paid).toEqual([input])
      expect(chat.status).toBe('ready')
    }),
)
