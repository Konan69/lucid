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
import { answer, attachRun, continueRun, decide, respond, streamRun, waiting } from '../main.ts'
import { call, consume, context, host, modelText, shop, signal, texts } from './fixtures/host.ts'

/**
 * As in src/chat.test.ts and upstream chat.test.ts, drive AbstractChat rather than a mock client.
 * Arm the completion before each SDK action: onFinish is the observable end of an automatic POST.
 */
function client(
  transport: DefaultChatTransport<UIMessage>,
  predicate: ChatInit<UIMessage>['sendAutomaticallyWhen'],
) {
  let completion = signal()
  const chat = new PlainChat({
    transport,
    sendAutomaticallyWhen: predicate,
    onFinish: () => completion.resolve(),
    onError: (error) => completion.reject(error),
  })
  /** Await the next response without relying on stream timing or status polling. */
  const next = () => {
    completion = signal()
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
  const parked = chat.lastMessage
  if (parked === undefined) throw new Error('Expected the held message')
  const id = parked.id
  expect(fixture.paid).toEqual([])
  const finished = next()
  await chat.addToolApprovalResponse({ id: 'pay', approved: true })
  await finished
  expect(chat.status).toBe('ready')
  expect(chat.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
  if (chat.lastMessage === undefined) throw new Error('Expected an assistant message')
  expect(chat.lastMessage.id).toBe(id)
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
  const parked = chat.lastMessage
  if (parked === undefined) throw new Error('Expected the held message')
  expect(parked.parts.find((part) => part.type === 'tool-ask')).toMatchObject({
    state: 'input-available',
    input: { question: 'Which account?' },
  })
  const id = parked.id
  const finished = next()
  await chat.addToolOutput({ tool: 'ask', toolCallId: 'ask', output: 'savings' })
  await finished
  expect(chat.status).toBe('ready')
  expect(chat.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
  if (chat.lastMessage === undefined) throw new Error('Expected an assistant message')
  expect(chat.lastMessage.id).toBe(id)
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
  if (chat.lastMessage === undefined) throw new Error('Expected an assistant message')
  expect(
    chat.lastMessage.parts.find((part) => 'toolCallId' in part && part.toolCallId === 'two'),
  ).toMatchObject({ state: 'output-denied' })
  expect(chat.messages.filter((message) => message.role === 'assistant')).toHaveLength(1)
})

// Installed ai/src/ui/last-assistant-message-is-complete-with-approval-responses.ts:35–40
// requires every tool in the last step to be completed or approval-responded. Pi's unstarted second
// sequential tool is input-available, so the stock client cannot automatically POST the first decision.
it('the stock approval predicate cannot advance an unstarted sequential call', async () => {
  const paid: number[] = []
  const fixture = await host(
    {
      pay: tool({
        inputSchema: z.object({ amount: z.number() }),
        execute: async ({ amount }) => {
          paid.push(amount)
          return amount
        },
      }),
    },
    { approval: { pay: true } },
    { toolExecution: 'sequential' },
  )
  const opened = await fixture.open()
  opened.faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall('pay', { amount: 1 }, { id: 'c1' }),
        fauxToolCall('pay', { amount: 2 }, { id: 'c2' }),
      ],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('Done.'),
  ])
  const { chat } = client(opened.transport, lastAssistantMessageIsCompleteWithApprovalResponses)
  await chat.sendMessage({ text: 'Pay both' })
  expect(await waiting(opened.harness, opened.root.id, context)).toMatchObject([{ callId: 'c1' }])
  await chat.addToolApprovalResponse({ id: 'c1', approved: true })
  if (chat.lastMessage === undefined) throw new Error('Expected the sequential message')
  expect(
    chat.lastMessage.parts.find((part) => 'toolCallId' in part && part.toolCallId === 'c1'),
  ).toMatchObject({ state: 'approval-responded' })
  expect(
    chat.lastMessage.parts.find((part) => 'toolCallId' in part && part.toolCallId === 'c2'),
  ).toMatchObject({ state: 'input-available' })
  expect(lastAssistantMessageIsCompleteWithApprovalResponses({ messages: chat.messages })).toBe(
    false,
  )
  expect(paid).toEqual([])
  expect(chat.status).toBe('ready')
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
      const attachedRun = await attachRun(opened.harness, opened.root.id, context)
      if (attachedRun.status === 'idle') return new Response(null, { status: 204 })
      attached.resolve()
      return createUIMessageStreamResponse({ stream: attachedRun.stream })
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
// Replaying a snapshot resets the SDK's retained current step before emitting its durable contents.
it('step 1 snapshot reconnect after a network interruption does not duplicate text', async () => {
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
        const attachedRun = await attachRun(opened.harness, opened.root.id, context)
        if (attachedRun.status === 'idle') return new Response(null, { status: 204 })
        attached.resolve()
        return createUIMessageStreamResponse({ stream: attachedRun.stream })
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
// The GET receipt opens observation before the held tool is released.
it('resumeStream reconnects to an in-progress run through respond', async () => {
  const opened = await running()
  const attached = signal()
  const transport = new DefaultChatTransport<UIMessage>({
    api: 'http://durable.test/chat',
    fetch: async (url, init) => {
      const response = await respond(
        opened.harness,
        opened.root.id,
        new Request(url, init),
        context,
      )
      attached.resolve()
      return response
    },
  })
  const chat = new PlainChat({ transport })
  try {
    const resumed = chat.resumeStream()
    await attached.promise
    opened.release.resolve()
    await resumed
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
// The Promise handler serves the bodyless GET through the public attachment seam.
it('reconnectToStream returns the in-progress run through respond', async () => {
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

// Review step.mjs: the server replays start(messageId), reset-step, then the whole run. Installed
// ai/src/ui/process-ui-message-stream.ts:144–156,938–963 resets only the current step; start changes
// identity without replacing older parts. chat.ts:852–882 retains resumable state in this Chat;
// a fresh page instead constructs a new message. No server chunk replaces the earlier steps.
// This is the one permitted expected failure: applications reload history before reconnecting.
it.fails('step 2 snapshot reconnect into a retained partial message duplicates earlier text and tools', async () => {
  const entered = signal()
  const release = signal()
  const fixture = await host(
    {
      work: tool({ inputSchema: z.object({}), execute: async () => '12 pages' }),
      pause: tool({
        inputSchema: z.object({}),
        execute: async () => {
          entered.resolve()
          await release.promise
          return 'continued'
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
    fauxAssistantMessage(
      [{ type: 'text', text: 'Fin' }, fauxToolCall('pause', {}, { id: 'pause' })],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('Finished.'),
  ])
  const attached = signal()
  const transport = new DefaultChatTransport<UIMessage>({
    api: 'http://durable.test/chat',
    fetch: async (url, init) => {
      const request = new Request(url, init)
      const response = await respond(opened.harness, opened.root.id, request, context)
      if (request.method === 'GET') {
        attached.resolve()
        return response
      }
      if (response.body === null) throw new Error('Expected an SSE body')
      const decoder = new TextDecoder()
      // Fault before closing step 2's text, retaining step 1 and the second partial text.
      let secondText = false
      const dropped = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            const text = decoder.decode(chunk)
            if (secondText && text.includes('text-end')) {
              controller.error(new TypeError('network connection lost'))
              return
            }
            if (text.includes('text-delta') && text.includes('"delta":"Fin"')) secondText = true
            controller.enqueue(chunk)
          },
        }),
      )
      return new Response(dropped, { headers: response.headers })
    },
  })
  const chat = new PlainChat({ transport })
  try {
    await chat.sendMessage({ text: 'Build in steps' })
    await entered.promise
    expect(chat.status).toBe('error')
    if (chat.lastMessage === undefined) throw new Error('Expected the retained message')
    expect(texts(chat.lastMessage)).toEqual(['Starting.', 'Fin'])
    expect(chat.lastMessage.parts.filter((part) => part.type === 'tool-work')).toHaveLength(1)
    const id = chat.lastMessage.id
    chat.clearError()
    const resumed = chat.resumeStream()
    await attached.promise
    release.resolve()
    await resumed
    expect(chat.status).toBe('ready')
    expect(chat.lastMessage.id).toBe(id)
    expect(chat.messages.filter((message) => message.role === 'assistant')).toHaveLength(1)
    expect({
      text: texts(chat.lastMessage),
      tools: chat.lastMessage.parts.filter((part) => part.type === 'tool-work').length,
    }).toEqual({ text: ['Starting.', 'Fin', 'Finished.'], tools: 1 })
  } finally {
    release.resolve()
    await opened.root.waitForIdle(context)
  }
})
