import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from '@effect/vitest'
import { isToolUIPart, readUIMessageStream, tool, type UIMessage, type UIMessageChunk } from 'ai'
import { Effect, Option, Predicate } from 'effect'
import { onTestFinished } from 'vitest'
import { z } from 'zod'
import { attachRun, rejoinRun, streamRun } from '../main.ts'
import { waitForFrame } from '../fixtures/provider.ts'
import { consume, context, host, signal } from './fixtures/host.ts'

/** The reader signals a genuine partial input receipt, then keeps consuming to the final state. */
async function readPartial(
  stream: ReadableStream<UIMessageChunk>,
  before: (message: UIMessage) => void,
) {
  let message = Option.none<UIMessage>()
  for await (const next of readUIMessageStream({ stream })) {
    message = Option.some(next)
    before(next)
  }
  if (Option.isNone(message)) throw new Error('Expected message')
  return message.value
}

/** One captured raw prefix plus the buffered tail is one JSON text for every reporting entry point. */
it.live.each(['attach', 'rejoin', 'post'] as const)(
  'reconnects mid-arguments through %s without repeated deltas',
  (kind) =>
    Effect.promise(async () => {
      const release = signal()
      let gated = false
      const fixture = await host(
        {
          work: tool({
            inputSchema: z.object({ input: z.string() }),
            execute: async (args) => args,
          }),
        },
        {},
        { progress: { partialIntervalMs: 1 } },
        {
          partialFamily: 'anthropic',
          tokenSize: { min: 1, max: 1 },
          onFrame: (event, abortSignal) => {
            if (event.type !== 'toolcall_delta' || gated) return Effect.void
            const block = event.partial.content[event.contentIndex]
            if (block === undefined || block.type !== 'toolCall') throw new Error('Expected tool')
            if (!Predicate.isString(block.arguments.input) || block.arguments.input.length < 5)
              return Effect.void
            gated = true
            return waitForFrame(
              Effect.promise(() => release.promise),
              abortSignal,
            )
          },
        },
      )
      onTestFinished(() => release.resolve())
      const opened = await fixture.open()
      const input = { input: 'abcdefghijklmnopqrstuvwxyz' }
      opened.faux.setResponses([
        fauxAssistantMessage([fauxToolCall('work', input, { id: 'wire' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('Finished.'),
      ])
      const source = await streamRun(
        opened.harness,
        { conversationId: opened.root.id, content: 'Work', requestId: 'scratch' },
        context,
      )
      const [raw, folded] = source.tee()
      const live = consume(raw)
      const appeared = signal()
      let partial = Option.none<UIMessage>()
      const reading = readPartial(folded, (message) => {
        const part = message.parts.find(isToolUIPart)
        if (part === undefined || part.state !== 'input-streaming' || part.input === undefined)
          return
        partial = Option.some(structuredClone(message))
        appeared.resolve()
      })
      await appeared.promise
      const retained = Option.getOrThrow(partial)
      const attached =
        kind === 'post'
          ? undefined
          : await (kind === 'attach'
              ? attachRun(opened.harness, opened.root.id, context)
              : rejoinRun(
                  opened.harness,
                  opened.root.id,
                  { messageId: retained.id, steps: 1 },
                  context,
                ))
      let replay: Promise<Awaited<ReturnType<typeof consume>>>
      if (kind === 'post') {
        // The stock transport performs the one real POST and parses its response SSE.
        const stream = await opened.transport.sendMessages({
          chatId: 'scratch',
          messages: [retained],
          trigger: 'submit-message',
          messageId: retained.id,
          abortSignal: undefined,
        })
        replay = consume(stream, retained)
      } else {
        if (attached === undefined || attached.status !== 'running')
          throw new Error('Expected attachment')
        replay = kind === 'attach' ? consume(attached.stream) : consume(attached.stream, retained)
      }
      release.resolve()
      const result = await replay
      const deltas = result.chunks.flatMap((chunk) =>
        chunk.type === 'tool-input-delta' ? [chunk.inputTextDelta] : [],
      )
      expect(deltas.length).toBeGreaterThan(0)
      expect(JSON.stringify(input).startsWith(deltas.join(''))).toBe(true)
      expect(result.chunks.filter((chunk) => chunk.type === 'tool-input-start')).toHaveLength(1)
      expect(result.message.parts.find(isToolUIPart)).toMatchObject({
        state: 'output-available',
        input,
      })
      expect(result.message.parts.filter((part) => part.type === 'step-start')).toHaveLength(2)
      expect((await live).message.parts).toEqual(result.message.parts)
      await reading
    }),
)
