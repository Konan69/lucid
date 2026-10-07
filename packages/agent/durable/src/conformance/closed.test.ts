import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from '@effect/vitest'
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
  tool,
  type UIMessage,
} from 'ai'
import { Effect } from 'effect'
import { onTestFinished } from 'vitest'
import { z } from 'zod'
import { abort, continueRun, respond, RunMissing, streamRun } from '../main.ts'
import { waitForFrame } from '../fixtures/provider.ts'
import { PlainChat } from '../fixtures/chat.ts'
import { call, consume, context, host, shop, signal } from './fixtures/host.ts'

/** A provider frame gate holds the input open until the real SDK has received its start. */
for (const predicate of [
  lastAssistantMessageIsCompleteWithToolCalls,
  lastAssistantMessageIsCompleteWithApprovalResponses,
])
  it.live(`finishes an aborted input with ${predicate.name} without a POST loop`, () =>
    Effect.promise(async () => {
      const release = signal()
      const fixture = await host(
        { pay: tool({ inputSchema: z.object({ amount: z.number() }), execute: async () => 1 }) },
        { approval: { pay: true } },
        { progress: { partialIntervalMs: 1 } },
        {
          partialFamily: 'anthropic',
          onFrame: (event, abortSignal) =>
            event.type === 'toolcall_start'
              ? waitForFrame(
                  Effect.promise(() => release.promise),
                  abortSignal,
                )
              : Effect.void,
        },
      )
      const opened = await fixture.open()
      onTestFinished(() => release.resolve())
      opened.faux.setResponses([
        fauxAssistantMessage([fauxToolCall('pay', { amount: 100 }, { id: 'partial' })], {
          stopReason: 'toolUse',
        }),
      ])
      const started = signal()
      const done = signal()
      let posts = 0
      const transport = new DefaultChatTransport<UIMessage>({
        api: 'http://durable.test/chat',
        fetch: async (url, init) => {
          posts += 1
          if (posts > 2) throw new Error('Unexpected repeated POST')
          const response = await respond(
            opened.harness,
            opened.root.id,
            new Request(url, init),
            context,
          )
          return response
        },
      })
      // Decode through the real transport, observing only its public chunk stream before the SDK.
      const chat = new PlainChat({
        transport: {
          reconnectToStream: (input) => transport.reconnectToStream(input),
          sendMessages: async (input) => {
            const stream = await transport.sendMessages(input)
            return stream.pipeThrough(
              new TransformStream({
                transform(chunk, controller) {
                  controller.enqueue(chunk)
                  if (chunk.type === 'tool-input-start') started.resolve()
                },
              }),
            )
          },
        },
        sendAutomaticallyWhen: predicate,
        onFinish: () => done.resolve(),
        onError: (error) => done.reject(error),
      })
      const sending = chat.sendMessage({ text: 'Pay' })
      await started.promise
      await abort(opened.harness, opened.root.id, context)
      release.resolve()
      await sending
      await done.promise
      expect(chat.status).toBe('ready')
      expect(posts).toBe(1)
      if (chat.lastMessage === undefined) throw new Error('Expected aborted assistant')
      expect(chat.lastMessage.parts.find((part) => 'toolCallId' in part)).toMatchObject({
        state: 'output-error',
      })
      // A manual retry with no new settlement is safe for either stock predicate too.
      const stream = await continueRun(
        opened.harness,
        opened.root.id,
        {
          messageId: chat.lastMessage.id,
          known: new Set(['partial']),
        },
        context,
      )
      const chunks = []
      for await (const chunk of stream) chunks.push(chunk)
      expect(chunks).toEqual([
        {
          type: 'start',
          messageId: chat.lastMessage.id,
          messageMetadata: chat.lastMessage.metadata,
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
          messageId: chat.lastMessage.id,
          messageMetadata: chat.lastMessage.metadata,
        },
        { type: 'finish', messageMetadata: chat.lastMessage.metadata },
      ])
      const missing = await respond(
        opened.harness,
        opened.root.id,
        new Request('http://durable.test/chat', {
          method: 'POST',
          body: JSON.stringify({
            messages: [
              {
                id: chat.lastMessage.id,
                role: 'assistant',
                parts: [{ type: 'tool-pay', toolCallId: 'never-made' }],
              },
            ],
          }),
        }),
        context,
      )
      expect(missing.status).toBe(409)
    }),
  )

/** A finished run with no new outputs/decisions acknowledges the same message without replaying parts. */
it.live('acknowledges a finished message without another automatic tool POST', () =>
  Effect.promise(async () => {
    const fixture = await host(
      {
        pay: tool({
          inputSchema: z.object({}),
          execute: async (): Promise<number> => {
            throw new Error('Payment refused')
          },
        }),
      },
      {},
    )
    const opened = await fixture.open()
    opened.faux.setResponses([call('pay', {}, 'finished'), fauxAssistantMessage('Done.')])
    const result = await consume(
      await streamRun(
        opened.harness,
        {
          conversationId: opened.root.id,
          content: 'Pay',
          requestId: 'done',
        },
        context,
      ),
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
    await chat.sendMessage()
    expect(posts).toBe(1)
    expect(chat.status).toBe('ready')
    expect(chat.lastMessage).toEqual(message)
  }),
)

/** A parked abort has no aborted partial entry; a successor generation's calls still cannot match it. */
it.live('acknowledges a parked aborted run without borrowing the successor generation', () =>
  Effect.promise(async () => {
    const fixture = await shop()
    const opened = await fixture.open()
    opened.faux.setResponses([call('pay', { amount: 1 }, 'old'), call('pay', { amount: 2 }, 'new')])
    const old = await consume(
      await streamRun(
        opened.harness,
        {
          conversationId: opened.root.id,
          content: 'First',
          requestId: 'old',
        },
        context,
      ),
    )
    await abort(opened.harness, opened.root.id, context)
    await consume(
      await streamRun(
        opened.harness,
        {
          conversationId: opened.root.id,
          content: 'Second',
          requestId: 'new',
        },
        context,
      ),
    )
    const existing = await continueRun(
      opened.harness,
      opened.root.id,
      { messageId: old.message.id, known: new Set(['old']) },
      context,
    )
    const chunks = []
    for await (const chunk of existing) chunks.push(chunk)
    expect(chunks.at(-1)).toEqual({ type: 'finish', messageMetadata: old.message.metadata })
    await expect(
      continueRun(
        opened.harness,
        opened.root.id,
        {
          messageId: old.message.id,
          known: new Set(['new']),
        },
        context,
      ),
    ).rejects.toBeInstanceOf(RunMissing)
    expect(fixture.paid).toEqual([])
  }),
)
