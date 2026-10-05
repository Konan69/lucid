import {
  fauxAssistantMessage,
  fauxThinking,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import {
  createUIMessageStreamResponse,
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
  tool,
  type ChatInit,
  type UIMessage,
} from 'ai'
import { expect, it } from 'vitest'
import { z } from 'zod'

import { PlainChat } from '../fixtures/chat.ts'
import { answer, attachRun, continueRun, decide, respond, streamRun, waiting } from '../index.ts'
import { call, consume, context, host, modelText, shop, signal, texts } from './fixtures/host.ts'

/**
 * As in src/chat.test.ts and upstream chat.test.ts, drive AbstractChat rather than a mock client.
 * Arm the completion before each SDK action: onFinish is the observable end of an automatic POST.
 */
function client(
  transport: DefaultChatTransport<UIMessage>,
  predicate: ChatInit<UIMessage>['sendAutomaticallyWhen'],
) {
  let completion = Promise.withResolvers<void>()
  const chat = new PlainChat({
    transport,
    sendAutomaticallyWhen: predicate,
    onFinish: () => completion.resolve(),
    onError: (error) => completion.reject(error),
  })
  /** Await the next response without relying on stream timing or status polling. */
  const next = () => {
    completion = Promise.withResolvers<void>()
    return completion.promise
  }
  return { chat, next }
}

// AI SDK packages/ai/src/ui-message-stream/ui-message-chunks.test.ts: returns UI message chunks; accepts reset-step chunks.
// consume validates all chunks with uiMessageChunkSchema before folding; exercise each bridge lifecycle.
it.each(['text', 'reasoning', 'approval', 'answer', 'denial', 'retry'] as const)(
  'emits a valid SDK UI stream for %s',
  async (kind) => {
    const fixture = await shop()
    const opened = await fixture.open()
    switch (kind) {
      case 'text':
        opened.faux.setResponses([fauxAssistantMessage('Done.')])
        break
      case 'reasoning':
        opened.faux.setResponses([
          fauxAssistantMessage([fauxThinking('Checking.'), { type: 'text', text: 'Done.' }]),
        ])
        break
      case 'approval':
      case 'denial':
        opened.faux.setResponses([
          call('pay', { amount: 500 }, 'held'),
          fauxAssistantMessage('Done.'),
        ])
        break
      case 'answer':
        opened.faux.setResponses([
          call('ask', { question: 'Which?' }, 'held'),
          fauxAssistantMessage('Done.'),
        ])
        break
      case 'retry':
        opened.faux.setResponses([
          fauxAssistantMessage('Partial.', {
            stopReason: 'error',
            errorMessage: '503 Service Unavailable',
          }),
          fauxAssistantMessage('Done.'),
        ])
        break
    }
    const first = await consume(
      await streamRun(
        opened.harness,
        { conversationId: opened.root.id, content: 'Do it', requestId: kind },
        context,
      ),
    )
    if (kind === 'approval' || kind === 'denial' || kind === 'answer') {
      if (kind === 'answer')
        await answer(opened.harness, opened.root.id, { callId: 'held', output: 'savings' }, context)
      else
        await decide(
          opened.harness,
          opened.root.id,
          { callId: 'held', approved: kind === 'approval', reason: 'No budget' },
          context,
        )
      const stream = await continueRun(opened.harness, opened.root.id, new Set(['held']), context)
      if (stream === undefined) throw new Error('Expected a continuation')
      const result = await consume(stream, first.message)
      expect(texts(result.message)).toEqual(['Done.'])
    } else expect(texts(first.message)).toEqual(['Done.'])
    expect(first.chunks.at(0)).toMatchObject({ type: 'start' })
    expect(first.chunks.at(-1)).toMatchObject({ type: 'finish' })
  },
)

// AI SDK packages/ai/src/ui/chat.test.ts: addToolApprovalResponse > approved with automatic sending > should update tool invocation to show the approval response.
it('addToolApprovalResponse automatically resumes one assistant message', async () => {
  const fixture = await shop()
  const opened = await fixture.open()
  opened.faux.setResponses([
    fauxAssistantMessage(
      [{ type: 'text', text: 'Checking.' }, fauxToolCall('pay', { amount: 500 }, { id: 'pay' })],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('Paid.'),
  ])
  const { chat, next } = client(
    opened.transport,
    lastAssistantMessageIsCompleteWithApprovalResponses,
  )
  await chat.sendMessage({ text: 'Pay' })
  expect(chat.status).toBe('ready')
  const id = chat.lastMessage?.id
  expect(fixture.paid).toEqual([])
  const finished = next()
  await chat.addToolApprovalResponse({ id: 'pay', approved: true })
  await finished
  expect(chat.status).toBe('ready')
  expect(chat.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
  expect(chat.lastMessage?.id).toBe(id)
  if (chat.lastMessage === undefined) throw new Error('Expected an assistant message')
  expect(texts(chat.lastMessage)).toEqual(['Checking.', 'Paid.'])
  expect(chat.lastMessage.parts.find((part) => part.type === 'tool-pay')).toMatchObject({
    state: 'output-available',
    output: { receipt: 500 },
  })
  expect(fixture.paid).toEqual([500])
})

// AI SDK packages/ai/src/ui/chat.test.ts: sendAutomaticallyWhen > should send message when a tool output is submitted.
it('addToolOutput automatically resumes one assistant message', async () => {
  const fixture = await shop()
  const opened = await fixture.open()
  opened.faux.setResponses([
    call('ask', { question: 'Which account?' }, 'ask'),
    (request) => fauxAssistantMessage(`Using ${modelText(request.messages).split('\n').at(-1)}.`),
  ])
  const { chat, next } = client(opened.transport, lastAssistantMessageIsCompleteWithToolCalls)
  await chat.sendMessage({ text: 'Ask' })
  expect(chat.lastMessage?.parts.find((part) => part.type === 'tool-ask')).toMatchObject({
    state: 'input-available',
    input: { question: 'Which account?' },
  })
  const id = chat.lastMessage?.id
  const finished = next()
  await chat.addToolOutput({ tool: 'ask', toolCallId: 'ask', output: 'savings' })
  await finished
  expect(chat.status).toBe('ready')
  expect(chat.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
  expect(chat.lastMessage?.id).toBe(id)
  if (chat.lastMessage === undefined) throw new Error('Expected an assistant message')
  expect(texts(chat.lastMessage)).toEqual(['Using savings.'])
  expect(chat.lastMessage.parts.find((part) => part.type === 'tool-ask')).toMatchObject({
    state: 'output-available',
    output: 'savings',
  })
})

// AI SDK packages/ai/src/ui/last-assistant-message-is-complete-with-approval-responses.test.ts: should return false if some tools still have approval-requested state.
it('the stock approval predicate waits for both decisions before posting', async () => {
  const fixture = await shop()
  const opened = await fixture.open()
  opened.faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall('pay', { amount: 100 }, { id: 'one' }),
        fauxToolCall('pay', { amount: 200 }, { id: 'two' }),
      ],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('Resolved.'),
  ])
  const { chat, next } = client(
    opened.transport,
    lastAssistantMessageIsCompleteWithApprovalResponses,
  )
  await chat.sendMessage({ text: 'Pay both' })
  await chat.addToolApprovalResponse({ id: 'one', approved: true })
  expect(chat.status).toBe('ready')
  expect(fixture.paid).toEqual([])
  expect(await waiting(opened.harness, opened.root.id, context)).toHaveLength(2)
  const finished = next()
  await chat.addToolApprovalResponse({ id: 'two', approved: false, reason: 'Budget' })
  await finished
  expect(fixture.paid).toEqual([100])
  expect(
    chat.lastMessage?.parts.find((part) => 'toolCallId' in part && part.toolCallId === 'two'),
  ).toMatchObject({ state: 'output-denied' })
  expect(chat.messages.filter((message) => message.role === 'assistant')).toHaveLength(1)
})

// AI SDK packages/ai/src/ui/chat.test.ts: sendAutomaticallyWhen > should submit a client tool output when completed text follows the tool call.
it('the stock tool predicate submits an output even when completed text follows the call', async () => {
  const fixture = await shop()
  const opened = await fixture.open()
  opened.faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall('ask', { question: 'Which account?' }, { id: 'ask' }),
        { type: 'text', text: 'Waiting for your answer.' },
      ],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('Answered.'),
  ])
  const { chat, next } = client(opened.transport, lastAssistantMessageIsCompleteWithToolCalls)
  await chat.sendMessage({ text: 'Ask' })
  const finished = next()
  await chat.addToolOutput({ tool: 'ask', toolCallId: 'ask', output: 'savings' })
  await finished
  expect(chat.status).toBe('ready')
  expect(chat.messages.filter((message) => message.role === 'assistant')).toHaveLength(1)
  if (chat.lastMessage === undefined) throw new Error('Expected an assistant message')
  expect(texts(chat.lastMessage)).toEqual(['Waiting for your answer.', 'Answered.'])
})

/** Keep a real tool running while reconnect attaches; release is a tool completion, not a clock. */
async function running() {
  const entered = signal()
  const release = signal()
  const fixture = await host(
    {
      work: tool({
        description: 'Build a report',
        inputSchema: z.object({}),
        execute: async () => {
          entered.resolve()
          await release.promise
          return '12 pages'
        },
      }),
    },
    {},
  )
  const opened = await fixture.open()
  opened.faux.setResponses([
    fauxAssistantMessage(
      [{ type: 'text', text: 'Starting.' }, fauxToolCall('work', {}, { id: 'work' })],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('Finished.'),
  ])
  const original = await streamRun(
    opened.harness,
    { conversationId: opened.root.id, content: 'Build', requestId: 'build' },
    context,
  )
  await entered.promise
  await original.cancel()
  return { ...opened, release }
}

// AI SDK packages/ai/src/ui/chat.test.ts: should not copy the previous assistant message when resuming a stream.
// The host maps GET to public attachRun; the separate tests below exercise respond's GET support.
it('a host reconnect route streams the active run through the stock transport', async () => {
  const opened = await running()
  const attached = signal()
  const transport = new DefaultChatTransport<UIMessage>({
    api: 'http://durable.test/chat',
    fetch: async (url, init) => {
      const request = new Request(url, init)
      if (request.method !== 'GET') return respond(opened.harness, opened.root.id, request, context)
      const stream = await attachRun(opened.harness, opened.root.id, context)
      if (stream === undefined) return new Response(null, { status: 204 })
      attached.resolve()
      return createUIMessageStreamResponse({ stream })
    },
  })
  const chat = new PlainChat({ transport })
  // PlainChat's existing state starts empty; hydrate through AbstractChat's public setter.
  chat.messages = [{ id: 'user', role: 'user', parts: [{ type: 'text', text: 'Build' }] }]
  const resumed = chat.resumeStream()
  await attached.promise
  opened.release.resolve()
  await resumed
  expect(chat.status).toBe('ready')
  expect(chat.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
  if (chat.lastMessage === undefined) throw new Error('Expected the resumed message')
  expect(texts(chat.lastMessage)).toEqual(['Starting.', 'Finished.'])
  expect(chat.lastMessage.parts.find((part) => part.type === 'tool-work')).toMatchObject({
    state: 'output-available',
    output: '12 pages',
  })
})

// AI SDK packages/ai/src/ui/chat.test.ts: should continue an active text part when resuming after a disconnect.
// Gap: attachRun replays the whole prefix into AbstractChat's retained response, duplicating old text.
it.fails('snapshot reconnect after a network interruption does not duplicate text', async () => {
  const entered = signal()
  const release = signal()
  const fixture = await host(
    {
      work: tool({
        description: 'Build a report',
        inputSchema: z.object({}),
        execute: async () => {
          entered.resolve()
          await release.promise
          return '12 pages'
        },
      }),
    },
    {},
  )
  const opened = await fixture.open()
  opened.faux.setResponses([
    fauxAssistantMessage(
      [{ type: 'text', text: 'Starting.' }, fauxToolCall('work', {}, { id: 'work' })],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('Finished.'),
  ])
  const attached = signal()
  const transport = new DefaultChatTransport<UIMessage>({
    api: 'http://durable.test/chat',
    fetch: async (url, init) => {
      const request = new Request(url, init)
      if (request.method === 'GET') {
        const stream = await attachRun(opened.harness, opened.root.id, context)
        if (stream === undefined) return new Response(null, { status: 204 })
        attached.resolve()
        return createUIMessageStreamResponse({ stream })
      }
      const response = await respond(opened.harness, opened.root.id, request, context)
      if (response.body === null) throw new Error('Expected an SSE body')
      const decoder = new TextDecoder()
      // Fault the transport after receiving real text, leaving Pi and its stream translator intact.
      const dropped = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            if (decoder.decode(chunk).includes('tool-input-available')) {
              controller.error(new TypeError('network connection lost'))
              return
            }
            controller.enqueue(chunk)
          },
        }),
      )
      return new Response(dropped, { headers: response.headers })
    },
  })
  const chat = new PlainChat({ transport })
  try {
    await chat.sendMessage({ text: 'Build' })
    await entered.promise
    expect(chat.status).toBe('error')
    if (chat.lastMessage === undefined) throw new Error('Expected the disconnected message')
    expect(texts(chat.lastMessage)).toEqual(['Starting.'])
    chat.clearError()
    const resumed = chat.resumeStream()
    await attached.promise
    release.resolve()
    await resumed
    expect(chat.status).toBe('ready')
    expect(chat.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    if (chat.lastMessage === undefined) throw new Error('Expected the resumed message')
    expect(texts(chat.lastMessage)).toEqual(['Starting.', 'Finished.'])
  } finally {
    release.resolve()
    await opened.root.waitForIdle(context)
  }
})

// AI SDK packages/ai/src/ui/chat.test.ts: should continue an active text part when resuming after a disconnect.
// Gap: respond always parses JSON, so the stock reconnect GET fails before it can attachRun.
it.fails('resumeStream reconnects to an in-progress run through respond', async () => {
  const opened = await running()
  const chat = new PlainChat({ transport: opened.transport })
  try {
    await chat.resumeStream()
  } finally {
    opened.release.resolve()
    await opened.root.waitForIdle(context)
  }
  expect(chat.status).toBe('ready')
  expect(chat.messages.filter((message) => message.role === 'assistant')).toHaveLength(1)
  if (chat.lastMessage === undefined) throw new Error('Expected the resumed message')
  expect(texts(chat.lastMessage)).toEqual(['Starting.', 'Finished.'])
})

// AI SDK packages/ai/src/ui/chat.test.ts: should not copy the previous assistant message when resuming a stream (reconnectToStream transport seam).
// Gap: respond rejects the DefaultChatTransport reconnect GET with an empty-body JSON SyntaxError.
it.fails('reconnectToStream returns the in-progress run through respond', async () => {
  const opened = await running()
  try {
    const stream = await opened.transport.reconnectToStream({
      chatId: 'chat',
      abortSignal: undefined,
    })
    opened.release.resolve()
    if (stream === null) throw new Error('Expected the in-progress stream')
    const result = await consume(stream)
    expect(texts(result.message)).toEqual(['Starting.', 'Finished.'])
  } finally {
    opened.release.resolve()
    await opened.root.waitForIdle(context)
  }
})
