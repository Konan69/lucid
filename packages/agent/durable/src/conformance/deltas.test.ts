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
import { Effect, Option, Predicate, Schema } from 'effect'
import { onTestFinished } from 'vitest'
import { z } from 'zod'
import { PlainChat } from '../fixtures/chat.ts'
import { providerFamilies, waitForFrame } from '../fixtures/provider.ts'
import { host, signal } from './fixtures/host.ts'

const partialInput = Schema.decodeUnknownOption(Schema.Struct({ input: Schema.String }))

/** Observe stock transport chunks without replacing its parsing or the Chat stream reader. */
function recording(
  transport: ChatTransport<UIMessage>,
  chunks: UIMessageChunk[],
): ChatTransport<UIMessage> {
  return {
    reconnectToStream: (request) => transport.reconnectToStream(request),
    sendMessages: async (request) =>
      (await transport.sendMessages(request)).pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            chunks.push(chunk)
            controller.enqueue(chunk)
          },
        }),
      ),
  }
}

/** Source-derived raw partials grow in real SDK state; parsed-only/grammar shapes never invent JSON. */
it.live.each([...providerFamilies, 'parsed', 'custom'] as const)(
  'streams %s input through stock Chat before final approval',
  (partialFamily) =>
    Effect.promise(async () => {
      const raw = partialFamily !== 'parsed' && partialFamily !== 'custom'
      const first = signal()
      const second = signal()
      const releaseFirst = signal()
      const releaseSecond = signal()
      const input = { input: 'abcdefghijklmnopqrstuvwxyz' }
      const paid: (typeof input)[] = []
      let gated = 0
      const fixture = await host(
        {
          pay: tool({
            inputSchema: z.object({ input: z.string() }),
            execute: async (args) => {
              paid.push(args)
              return args
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
              return waitForFrame(
                Effect.promise(() => releaseFirst.promise),
                abortSignal,
              )
            }
            if (raw && gated === 1 && text.length >= 15) {
              gated = 2
              return waitForFrame(
                Effect.promise(() => releaseSecond.promise),
                abortSignal,
              )
            }
            return Effect.void
          },
        },
      )
      onTestFinished(() => {
        releaseFirst.resolve()
        releaseSecond.resolve()
      })
      const opened = await fixture.open()
      opened.faux.setResponses([
        fauxAssistantMessage([fauxToolCall('pay', input, { id: 'streamed' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('Done.'),
      ])
      const chunks: UIMessageChunk[] = []
      let done = signal()
      const chat = new PlainChat({
        transport: recording(opened.transport, chunks),
        sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
        onFinish: () => done.resolve(),
        onError: (error) => done.reject(error),
        onMessage: (message) => {
          const part = message.parts.find(isToolUIPart)
          if (part === undefined || part.state !== 'input-streaming') return
          if (!raw) {
            first.resolve()
            return
          }
          const value = partialInput(part.input)
          if (Option.isNone(value)) return
          if (value.value.input.length >= 5) first.resolve()
          if (value.value.input.length >= 15) second.resolve()
        },
      })
      const sent = chat.sendMessage({ text: 'Pay' })
      await first.promise
      expect(
        chunks.some(
          (chunk) =>
            chunk.type === 'tool-input-available' || chunk.type === 'tool-approval-request',
        ),
      ).toBe(false)
      expect(paid).toEqual([])
      releaseFirst.resolve()
      if (raw) {
        await second.promise
        expect(chunks.filter((chunk) => chunk.type === 'tool-input-delta').length).toBeGreaterThan(
          1,
        )
        expect(chunks.some((chunk) => chunk.type === 'tool-input-available')).toBe(false)
      }
      releaseSecond.resolve()
      await sent
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
      done = signal()
      await chat.addToolApprovalResponse({ id: part.approval.id, approved: true })
      await done.promise
      expect(paid).toEqual([input])
      expect(chat.status).toBe('ready')
    }),
)
