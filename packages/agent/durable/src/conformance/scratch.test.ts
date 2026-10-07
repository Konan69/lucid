import { consumeReadable as consume, ReadFailed, type ReadResult } from '../fixtures/reading.ts'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from '@effect/vitest'
import { isToolUIPart, readUIMessageStream, tool, type UIMessage, type UIMessageChunk } from 'ai'
import { Effect, Option, Predicate, Deferred, Fiber, Stream } from 'effect'
import { z } from 'zod'
import { attachRun, streamRun } from '../main.ts'
import { waitForFrame } from '../fixtures/provider.ts'
import { context, host } from './fixtures/host.ts'

/** The reader signals a genuine partial input receipt, then keeps consuming to the final state. */
const readPartial = Effect.fn('Test.readPartial')(function* (
  stream: ReadableStream<UIMessageChunk>,
  before: (message: UIMessage) => void,
) {
  let message = Option.none<UIMessage>()
  yield* Stream.runForEach(
    Stream.fromAsyncIterable(readUIMessageStream({ stream }), (cause) => new ReadFailed({ cause })),
    (next) =>
      Effect.sync(() => {
        message = Option.some(next)
        before(next)
      }),
  )
  if (Option.isNone(message)) return yield* new ReadFailed({ cause: new Error('Expected message') })
  return message.value
})

/** One captured raw prefix plus the buffered tail is one JSON text for every reporting entry point. */
it.live.each(['attach', 'get', 'post'] as const)(
  'reconnects mid-arguments through %s without repeated deltas',
  (kind) =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>()
      let gated = false
      const fixture = yield* host(
        {
          work: tool({
            inputSchema: z.object({ input: z.string() }),
            execute: (args) => Promise.resolve(args),
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
            return waitForFrame(Deferred.await(release), abortSignal)
          },
        },
      )
      const opened = yield* fixture.open()
      // Release the provider before scoped harness cleanup waits for the active run.
      yield* Effect.addFinalizer(() => Effect.sync(() => Deferred.doneUnsafe(release, Effect.void)))
      const input = { input: 'abcdefghijklmnopqrstuvwxyz' }
      opened.faux.setResponses([
        fauxAssistantMessage([fauxToolCall('work', input, { id: 'wire' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('Finished.'),
      ])
      const source = yield* Effect.promise(() =>
        streamRun(
          opened.harness,
          { conversationId: opened.root.id, content: 'Work', requestId: 'scratch' },
          context,
        ),
      )
      const [raw, folded] = source.tee()
      const live = yield* consume(raw, Option.none()).pipe(Effect.forkScoped)
      const appeared = yield* Deferred.make<void>()
      let partial = Option.none<UIMessage>()
      const reading = yield* readPartial(folded, (message) => {
        const part = message.parts.find(isToolUIPart)
        if (part === undefined || part.state !== 'input-streaming' || part.input === undefined)
          return
        partial = Option.some(structuredClone(message))
        Deferred.doneUnsafe(appeared, Effect.void)
      }).pipe(Effect.forkScoped)
      yield* Deferred.await(appeared)
      const retained = Option.getOrThrow(partial)
      let replay: Fiber.Fiber<ReadResult, ReadFailed>
      switch (kind) {
        case 'post': {
          // The stock transport performs the one real POST and parses its response SSE.
          const stream = yield* Effect.promise(() =>
            opened.transport.sendMessages({
              chatId: 'scratch',
              messages: [retained],
              trigger: 'submit-message',
              messageId: retained.id,
              abortSignal: undefined,
            }),
          )
          replay = yield* consume(stream, Option.some(retained)).pipe(Effect.forkScoped)
          break
        }
        case 'get': {
          const stream = yield* Effect.promise(() =>
            opened.transport.reconnectToStream({ chatId: 'scratch' }),
          )
          if (stream === null) throw new Error('Expected an active run')
          replay = yield* consume(stream, Option.none()).pipe(Effect.forkScoped)
          break
        }
        case 'attach': {
          const attached = yield* Effect.promise(() =>
            attachRun(opened.harness, opened.root.id, context),
          )
          if (attached.status !== 'running') throw new Error('Expected attachment')
          replay = yield* consume(attached.stream, Option.none()).pipe(Effect.forkScoped)
          break
        }
      }
      yield* Deferred.succeed(release, undefined)
      const result = yield* Fiber.join(replay)
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
      expect((yield* Fiber.join(live)).message.parts).toEqual(result.message.parts)
      yield* Fiber.join(reading)
    }),
)
