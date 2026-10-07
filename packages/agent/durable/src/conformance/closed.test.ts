import { Deferred, Effect, Option, Stream } from 'effect'
import { runForPi } from '../pi.ts'
import { FixtureFailed } from '../fixtures/harness.ts'
import { consumeReadable, ReadFailed } from '../fixtures/reading.ts'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from '@effect/vitest'
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
  tool,
  type UIMessage,
  type UIMessageChunk,
} from 'ai'
import { z } from 'zod'
import { abort, continueRun, respond, RunMissing, streamRun } from '../main.ts'
import { waitForFrame } from '../fixtures/provider.ts'
import { PlainChat } from '../fixtures/chat.ts'
import { call, context, host, shop } from './fixtures/host.ts'
/** A provider frame gate holds the input open until the real SDK has received its start. */
for (const predicate of [
  lastAssistantMessageIsCompleteWithToolCalls,
  lastAssistantMessageIsCompleteWithApprovalResponses,
])
  it.live(`finishes an aborted input with ${predicate.name} without a POST loop`, () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>()
      const fixture = yield* host(
        {
          pay: tool({
            inputSchema: z.object({ amount: z.number() }),
            execute: () => Promise.resolve(1),
          }),
        },
        { approval: { pay: true } },
        { progress: { partialIntervalMs: 1 } },
        {
          partialFamily: 'anthropic',
          onFrame: (event, abortSignal) =>
            event.type === 'toolcall_start'
              ? waitForFrame(Deferred.await(release), abortSignal)
              : Effect.void,
        },
      )
      const opened = yield* fixture.open()
      yield* Effect.addFinalizer(() => Effect.sync(() => Deferred.doneUnsafe(release, Effect.void)))
      opened.faux.setResponses([
        fauxAssistantMessage([fauxToolCall('pay', { amount: 100 }, { id: 'partial' })], {
          stopReason: 'toolUse',
        }),
      ])
      const started = yield* Deferred.make<void>()
      const done = yield* Deferred.make<void, FixtureFailed>()
      let posts = 0
      const transport = new DefaultChatTransport<UIMessage>({
        api: 'http://durable.test/chat',
        fetch: (url, init) =>
          runForPi(
            Effect.gen(function* () {
              posts += 1
              if (posts > 2) throw new Error('Unexpected repeated POST')
              const response = yield* Effect.promise(() =>
                respond(opened.harness, opened.root.id, new Request(url, init), context),
              )
              return response
            }),
            undefined,
          ),
      })
      // Decode through the real transport, observing only its public chunk stream before the SDK.
      const chat = new PlainChat({
        transport: {
          reconnectToStream: (input) => transport.reconnectToStream(input),
          sendMessages: (input) =>
            runForPi(
              Effect.gen(function* () {
                const stream = yield* Effect.promise(() => transport.sendMessages(input))
                return stream.pipeThrough(
                  new TransformStream({
                    transform(chunk, controller) {
                      controller.enqueue(chunk)
                      if (chunk.type === 'tool-input-start')
                        Deferred.doneUnsafe(started, Effect.void)
                    },
                  }),
                )
              }),
              undefined,
            ),
        },
        sendAutomaticallyWhen: predicate,
        onFinish: () => Deferred.doneUnsafe(done, Effect.void),
        onError: (error) =>
          Deferred.doneUnsafe(done, Effect.fail(new FixtureFailed({ cause: error }))),
      })
      const sending = chat.sendMessage({ text: 'Pay' })
      yield* Deferred.await(started)
      yield* Effect.promise(() => abort(opened.harness, opened.root.id, context))
      Deferred.doneUnsafe(release, Effect.void)
      yield* Effect.promise(() => sending)
      yield* Deferred.await(done)
      expect(chat.status).toBe('ready')
      expect(posts).toBe(1)
      if (chat.lastMessage === undefined) throw new Error('Expected aborted assistant')
      const last = chat.lastMessage
      expect(last.parts.find((part) => 'toolCallId' in part)).toMatchObject({
        state: 'output-error',
      })
      // A manual retry with no new settlement is safe for either stock predicate too.
      const stream = yield* Effect.promise(() =>
        continueRun(
          opened.harness,
          opened.root.id,
          {
            messageId: last.id,
            known: new Set(['partial']),
          },
          context,
        ),
      )
      const chunks: UIMessageChunk[] = []
      yield* Stream.runForEach(
        Stream.fromAsyncIterable(stream, (cause) => new ReadFailed({ cause })),
        (chunk) =>
          Effect.sync(() => {
            chunks.push(chunk)
          }),
      )
      expect(chunks).toEqual([
        {
          type: 'start',
          messageId: last.id,
          messageMetadata: last.metadata,
        },
        {
          type: 'tool-input-error',
          toolCallId: 'partial',
          toolName: 'pay',
          input: {},
          errorText: 'Tool input was interrupted before it completed',
        },
        { type: 'start-step' },
        { type: 'finish-step' },
        {
          type: 'start',
          messageId: last.id,
          messageMetadata: last.metadata,
        },
        { type: 'finish', messageMetadata: last.metadata },
      ])
      const missing = yield* Effect.promise(() =>
        respond(
          opened.harness,
          opened.root.id,
          new Request('http://durable.test/chat', {
            method: 'POST',
            body: JSON.stringify({
              messages: [
                {
                  id: last.id,
                  role: 'assistant',
                  parts: [{ type: 'tool-pay', toolCallId: 'never-made' }],
                },
              ],
            }),
          }),
          context,
        ),
      )
      expect(missing.status).toBe(409)
    }),
  )
/** A finished run with no new outputs/decisions acknowledges the same message without replaying parts. */
it.live('acknowledges a finished message without another automatic tool POST', () =>
  Effect.gen(function* () {
    const fixture = yield* host(
      {
        pay: tool({
          inputSchema: z.object({}),
          execute: (): Promise<number> => Promise.reject(new Error('Payment refused')),
        }),
      },
      {},
    )
    const opened = yield* fixture.open()
    opened.faux.setResponses([call('pay', {}, 'finished'), fauxAssistantMessage('Done.')])
    const result = yield* consumeReadable(
      yield* Effect.promise(() =>
        streamRun(
          opened.harness,
          {
            conversationId: opened.root.id,
            content: 'Pay',
            requestId: 'done',
          },
          context,
        ),
      ),
      Option.none(),
    )
    let posts = 0
    const transport = new DefaultChatTransport<UIMessage>({
      api: 'http://durable.test/chat',
      fetch: (url, init) => {
        posts += 1
        return respond(opened.harness, opened.root.id, new Request(url, init), context)
      },
    })
    // This output-error is the real failed tool result consumed by the SDK, not client rewriting.
    const message = result.message
    expect(message.parts.find((part) => 'toolCallId' in part)).toMatchObject({
      state: 'output-error',
    })
    const chat = new PlainChat({
      messages: [message],
      transport,
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    })
    chat.messages = [message]
    yield* Effect.promise(() => chat.sendMessage())
    expect(posts).toBe(1)
    expect(chat.status).toBe('ready')
    expect(chat.lastMessage).toEqual(message)
  }),
)
/** A parked abort has no aborted partial entry; a successor generation's calls still cannot match it. */
it.live('acknowledges a parked aborted run without borrowing the successor generation', () =>
  Effect.gen(function* () {
    const fixture = yield* shop()
    const opened = yield* fixture.open()
    opened.faux.setResponses([call('pay', { amount: 1 }, 'old'), call('pay', { amount: 2 }, 'new')])
    const old = yield* consumeReadable(
      yield* Effect.promise(() =>
        streamRun(
          opened.harness,
          {
            conversationId: opened.root.id,
            content: 'First',
            requestId: 'old',
          },
          context,
        ),
      ),
      Option.none(),
    )
    yield* Effect.promise(() => abort(opened.harness, opened.root.id, context))
    yield* consumeReadable(
      yield* Effect.promise(() =>
        streamRun(
          opened.harness,
          {
            conversationId: opened.root.id,
            content: 'Second',
            requestId: 'new',
          },
          context,
        ),
      ),
      Option.none(),
    )
    const existing = yield* Effect.promise(() =>
      continueRun(
        opened.harness,
        opened.root.id,
        { messageId: old.message.id, known: new Set(['old']) },
        context,
      ),
    )
    const chunks: UIMessageChunk[] = []
    yield* Stream.runForEach(
      Stream.fromAsyncIterable(existing, (cause) => new ReadFailed({ cause })),
      (chunk) =>
        Effect.sync(() => {
          chunks.push(chunk)
        }),
    )
    expect(chunks.at(-1)).toEqual({ type: 'finish', messageMetadata: old.message.metadata })
    yield* Effect.map(
      Effect.flip(
        Effect.tryPromise({
          try: () =>
            continueRun(
              opened.harness,
              opened.root.id,
              {
                messageId: old.message.id,
                known: new Set(['new']),
              },
              context,
            ),
          catch: (cause) => new FixtureFailed({ cause }),
        }),
      ),
      (failed) => expect(failed.cause).toBeInstanceOf(RunMissing),
    )
    expect(fixture.paid).toEqual([])
  }),
)
