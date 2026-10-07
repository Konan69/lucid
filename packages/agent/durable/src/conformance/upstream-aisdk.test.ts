import {
  fauxAssistantMessage,
  fauxThinking,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import {
  DefaultChatTransport,
  APICallError,
  dynamicTool,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
  tool,
  type UIMessage,
} from 'ai'
import { expect, it, onTestFinished } from 'vitest'
import { z } from 'zod'

import { resumable } from '../client.ts'
import { PlainChat } from '../fixtures/chat.ts'
import { abort, continueRun, decide, history, respond, streamRun, waiting } from '../main.ts'
import { call, consume, context, hold, host, shop, signal, texts } from './fixtures/host.ts'

/** A successful SDK turn must have an assistant; absence is a failed port, never a cast. */
function last(chat: PlainChat): UIMessage {
  const message = chat.lastMessage
  if (message === undefined || message.role !== 'assistant') throw new Error('Expected assistant')
  return message
}

// AI SDK packages/ai/src/ui/chat.test.ts:145/226, and use-chat.ui.test.tsx:414/563.
// Ports packages/ai/src/ui/chat.test.ts:145 — Chat > send a simple message > should call onFinish with message and messages.
it('should call onFinish with message and messages', async () => {
  const fixture = await host({}, {})
  const opened = await fixture.open()
  opened.faux.setResponses([fauxAssistantMessage('Hello, world!')])
  const finished: UIMessage[] = []
  let finalMessages: UIMessage[] = []
  const chat = new PlainChat({
    transport: opened.transport,
    onFinish: ({ message, messages }) => {
      finished.push(message)
      finalMessages = messages
    },
  })
  await chat.sendMessage({ text: 'Hello' })
  expect(chat.status).toBe('ready')
  expect(finished).toEqual([chat.lastMessage])
  expect(finalMessages).toEqual(chat.messages)
  expect(chat.messages.map(texts)).toEqual([['Hello'], ['Hello, world!']])
  expect(last(chat).parts).toEqual([
    { type: 'step-start' },
    { type: 'text', text: 'Hello, world!', state: 'done' },
  ])
})

// AI SDK packages/ai/src/ui/process-ui-message-stream.test.ts:1422/1747/1864/2375.
// Ports packages/ai/src/ui/process-ui-message-stream.test.ts:1747 — processUIMessageStream > server-side tool roundtrip with multiple assistant texts > should have the correct final message state.
it('server-side tool roundtrip keeps multiple assistant texts and reasoning in separate steps', async () => {
  const fixture = await host(
    { echo: tool({ inputSchema: z.object({}), execute: async () => 'Echo.' }) },
    {},
  )
  const opened = await fixture.open()
  opened.faux.setResponses([
    fauxAssistantMessage(
      [
        fauxThinking('First thought.'),
        { type: 'text', text: 'First text.' },
        fauxToolCall('echo', {}, { id: 'echo' }),
      ],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage([fauxThinking('Second thought.'), { type: 'text', text: 'Second text.' }]),
  ])
  const result = await consume(
    await streamRun(
      opened.harness,
      { conversationId: opened.root.id, content: 'Think', requestId: 'steps' },
      context,
    ),
  )
  expect(result.message.parts.map((part) => part.type)).toEqual([
    'step-start',
    'reasoning',
    'text',
    'tool-echo',
    'step-start',
    'reasoning',
    'text',
  ])
  expect(result.message.parts.filter((part) => part.type === 'reasoning')).toMatchObject([
    { type: 'reasoning', text: 'First thought.', state: 'done' },
    { type: 'reasoning', text: 'Second thought.', state: 'done' },
  ])
  expect(texts(result.message)).toEqual(['First text.', 'Second text.'])
  expect(result.chunks.filter((chunk) => chunk.type === 'start-step')).toHaveLength(2)
  expect(result.chunks.filter((chunk) => chunk.type === 'finish-step')).toHaveLength(2)
})

// AI SDK packages/ai/src/ui/process-ui-message-stream.test.ts:6215;
// packages/react/src/use-chat.ui.test.tsx:1068, callback consumer behaviour without a React view.
// Ports packages/ai/src/ui/process-ui-message-stream.test.ts:4339 — processUIMessageStream > onToolCall is executed > should have the correct final message state.
it.each(['static', 'dynamic'] as const)(
  'should call onToolCall for client-executed %s tools',
  async (kind) => {
    const registration = { inputSchema: z.object({ question: z.string() }) }
    const registered = kind === 'dynamic' ? dynamicTool(registration) : tool(registration)
    const fixture = await host({ ask: registered }, {})
    const opened = await fixture.open()
    opened.faux.setResponses([call('ask', { question: 'Which?' }, 'ask')])
    const calls: string[] = []
    const chat = new PlainChat({
      transport: opened.transport,
      onToolCall: ({ toolCall }) => {
        calls.push(toolCall.toolCallId)
      },
    })
    await chat.sendMessage({ text: 'Ask' })
    expect(calls).toEqual(['ask'])
    expect(last(chat).parts.find(isToolUIPart)).toMatchObject({
      state: 'input-available',
      input: { question: 'Which?' },
    })
    expect(await waiting(opened.harness, opened.root.id, context)).toHaveLength(1)
  },
)

// AI SDK packages/ai/src/ui/chat.test.ts:3384.
// Ports packages/ai/src/ui/chat.test.ts:3384 — Chat > sendAutomaticallyWhen > should not send message when sendAutomaticallyWhen returns false via promise.
it('should not send message when sendAutomaticallyWhen returns false via promise', async () => {
  const fixture = await shop()
  const opened = await fixture.open()
  opened.faux.setResponses([
    call('ask', { question: 'Which?' }, 'ask'),
    fauxAssistantMessage('Never.'),
  ])
  const chat = new PlainChat({
    transport: opened.transport,
    sendAutomaticallyWhen: async () => false,
  })
  await chat.sendMessage({ text: 'Ask' })
  await chat.addToolOutput({ tool: 'ask', toolCallId: 'ask', output: 'Savings' })
  expect(chat.status).toBe('ready')
  expect(opened.faux.state.callCount).toBe(1)
  expect(await waiting(opened.harness, opened.root.id, context)).toHaveLength(1)
  expect(last(chat).parts.find(isToolUIPart)).toMatchObject({
    state: 'output-available',
    output: 'Savings',
  })
})

// AI SDK packages/ai/src/ui/chat.test.ts:3194/2023, process-ui-message-stream.test.ts:389.
// Ports packages/ai/src/ui/chat.test.ts:2023 — Chat > should handle error parts.
it('should not send message when the server responded with an error', async () => {
  const fixture = await host({}, {}, { retry: { enabled: false } })
  const opened = await fixture.open()
  opened.faux.setResponses([
    fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'Invalid request' }),
  ])
  const errors: Error[] = []
  let automaticChecks = 0
  const chat = new PlainChat({
    transport: opened.transport,
    onError: (error) => {
      errors.push(error)
    },
    sendAutomaticallyWhen: () => {
      automaticChecks++
      return true
    },
  })
  await chat.sendMessage({ text: 'Try' })
  expect(chat.status).toBe('error')
  expect(errors).toHaveLength(1)
  const error = errors[0]
  if (error === undefined) throw new Error('Expected stream error')
  expect(error.message).toBe('Invalid request')
  expect(automaticChecks).toBe(0)
  expect(opened.faux.state.callCount).toBe(1)
})

// AI SDK packages/react/src/use-chat.ui.test.tsx:2510; HttpChatTransport: 204 is an idle receipt.
// Ports packages/react/src/use-chat.ui.test.tsx:2510 — use-chat > resume with no active stream should not flash submitted status > should not transition to submitted when no active stream exists.
it('resume with no active stream does not transition to submitted', async () => {
  const fixture = await host({}, {})
  const opened = await fixture.open()
  const chat = new PlainChat({ transport: opened.transport })
  await chat.resumeStream()
  expect(chat.status).toBe('ready')
  expect(chat.messages).toEqual([])
  expect(opened.faux.state.callCount).toBe(0)
  expect(await opened.transport.reconnectToStream({ chatId: 'idle' })).toBeNull()
})

// AI SDK packages/ai/src/ui/chat.test.ts:3477.
// Ports packages/ai/src/ui/chat.test.ts:3477 — Chat > clearError > should clear the error and set the status to ready.
it('should clear the error and set the status to ready', async () => {
  const fixture = await host({}, {}, { retry: { enabled: false } })
  const opened = await fixture.open()
  opened.faux.setResponses([
    fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'Invalid request' }),
    fauxAssistantMessage('Recovered.'),
  ])
  const chat = new PlainChat({ transport: opened.transport })
  await chat.sendMessage({ text: 'Try' })
  expect(chat.status).toBe('error')
  chat.clearError()
  expect(chat.status).toBe('ready')
  expect(chat.error).toBeUndefined()
  await chat.sendMessage({ text: 'Again' })
  expect(texts(last(chat))).toEqual(['Recovered.'])
})

// AI SDK packages/ai/src/ui/chat.test.ts:3631, SDK options forwarding into real HTTP ingress.
// Ports packages/ai/src/ui/chat.test.ts:3631 — Chat > addToolOutput options forwarding > should forward options to makeRequest when auto-sending.
it('should forward options to makeRequest when auto-sending', async () => {
  const fixture = await shop()
  const opened = await fixture.open()
  const requests: Request[] = []
  const transport = new DefaultChatTransport<UIMessage>({
    api: 'http://durable.test/chat',
    fetch: async (url, init) => {
      const request = new Request(url, init)
      requests.push(request.clone())
      return respond(opened.harness, opened.root.id, request, context)
    },
  })
  opened.faux.setResponses([
    call('ask', { question: 'Which?' }, 'ask'),
    fauxAssistantMessage('Done.'),
  ])
  const finished = signal()
  const chat = new PlainChat({
    transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    onFinish: () => {
      if (requests.length === 2) finished.resolve()
    },
    onError: (error) => finished.reject(error),
  })
  await chat.sendMessage({ text: 'Ask' })
  await chat.addToolOutput({
    tool: 'ask',
    toolCallId: 'ask',
    output: 'Savings',
    options: { headers: { 'x-upstream': 'forwarded' }, body: { additional: 'field' } },
  })
  await finished.promise
  const request = requests[1]
  if (request === undefined) throw new Error('Expected continuation request')
  expect(request.headers.get('x-upstream')).toBe('forwarded')
  expect(await request.text()).toContain('"additional":"field"')
  expect(texts(last(chat))).toEqual(['Done.'])
})

// AI SDK packages/ai/src/ui/chat.test.ts:2844-2986 expects the error output to complete the call.
// HTTP error results settle the waiting answer hold and reach the model as tool errors.
// Ports packages/ai/src/ui/chat.test.ts:2844 — Chat > sendAutomaticallyWhen > should send message when a tool error result is submitted.
it('should send message when a tool error result is submitted', async () => {
  const fixture = await shop()
  const opened = await fixture.open()
  opened.faux.setResponses([
    call('ask', { question: 'Which?' }, 'ask'),
    fauxAssistantMessage('Handled failure.'),
  ])
  const chat = new PlainChat({ transport: opened.transport })
  await chat.sendMessage({ text: 'Ask' })
  await chat.addToolOutput({
    state: 'output-error',
    tool: 'ask',
    toolCallId: 'ask',
    errorText: 'Person could not answer',
  })
  const stream = await opened.transport.sendMessages({
    chatId: chat.id,
    abortSignal: undefined,
    trigger: 'submit-message',
    messages: chat.messages,
    messageId: last(chat).id,
  })
  const result = await consume(stream, last(chat))
  expect(await waiting(opened.harness, opened.root.id, context)).toEqual([])
  expect(texts(result.message)).toEqual(['Handled failure.'])
})

// AI SDK packages/ai/src/ui/chat.test.ts:2988-3192, process-ui-message-stream.test.ts:6343-6609.
// Registered SDK dynamicTool calls retain dynamic identity through client output settlement.
// Ports packages/ai/src/ui/chat.test.ts:2988 — Chat > sendAutomaticallyWhen > should send message when a dynamic tool output is submitted.
it('should send message when a dynamic tool output is submitted', async () => {
  const fixture = await host(
    { dynamic: dynamicTool({ inputSchema: z.object({ question: z.string() }) }) },
    {},
  )
  const opened = await fixture.open()
  opened.faux.setResponses([
    call('dynamic', { question: 'Which?' }, 'dynamic'),
    fauxAssistantMessage('Answered.'),
  ])
  const calls: string[] = []
  const chat = new PlainChat({
    transport: opened.transport,
    onToolCall: ({ toolCall }) => {
      calls.push(toolCall.toolCallId)
    },
  })
  await chat.sendMessage({ text: 'Ask' })
  expect(calls).toEqual(['dynamic'])
  expect(last(chat).parts.find(isToolUIPart)).toMatchObject({
    type: 'dynamic-tool',
    toolName: 'dynamic',
    state: 'input-available',
  })
  await chat.addToolOutput({ tool: 'dynamic', toolCallId: 'dynamic', output: 'Savings' })
  const resumed = await consume(
    await opened.transport.sendMessages({
      chatId: chat.id,
      trigger: 'submit-message',
      messageId: last(chat).id,
      messages: chat.messages,
      abortSignal: undefined,
    }),
    last(chat),
  )
  expect(resumed.message.parts.find(isToolUIPart)).toMatchObject({
    type: 'dynamic-tool',
    state: 'output-available',
    output: 'Savings',
  })
  expect(texts(resumed.message)).toEqual(['Answered.'])
  expect(await waiting(opened.harness, opened.root.id, context)).toEqual([])
})

// AI SDK packages/react/src/use-chat.ui.test.tsx:1572-1660 / 1794-1907.
// Adaptation: Pi accepts inline images; unsupported files/URLs must fail before durable admission.
// Upstream packages/react/src/use-chat.ui.test.tsx:1572 — use-chat > file attachments with data url > should handle text file attachment and submission.
// Upstream packages/react/src/use-chat.ui.test.tsx:1794 — use-chat > file attachments with url > should handle image file attachment and submission.
it.each([
  {
    name: 'text file attachment',
    mediaType: 'text/plain',
    url: 'data:text/plain;base64,dGVzdCBmaWxlIGNvbnRlbnQ=',
  },
  {
    name: 'remote image attachment',
    mediaType: 'image/png',
    url: 'https://files.example.test/image.png',
  },
])('refuses $name with HTTP 400 before admission', async ({ mediaType, url }) => {
  const fixture = await host({}, {})
  const opened = await fixture.open()
  opened.faux.setResponses([fauxAssistantMessage('Attached.')])
  const chat = new PlainChat({ transport: opened.transport })
  await chat.sendMessage({ text: 'See attachment', files: [{ type: 'file', mediaType, url }] })
  expect(chat.status).toBe('error')
  expect(chat.error).toBeInstanceOf(APICallError)
  expect(chat.error).toMatchObject({ statusCode: 400 })
  expect(opened.faux.state.callCount).toBe(0)
  expect((await history(opened.harness, opened.root.id, { limit: 10 }, context)).messages).toEqual(
    [],
  )
})

// AI SDK packages/ai/src/ui/chat.test.ts:955/959; stop cancels SDK observation, not host work.
// Contrast is intentional: the host's explicit abort API is covered by conformance/abort.test.ts.
// Ports packages/ai/src/ui/chat.test.ts:955 — Chat > send handle a stop and an aborted response stream > should have been aborted.
it('should have been aborted when the client stops the response stream', async () => {
  const fixture = await host({}, {})
  const opened = await fixture.open()
  const entered = signal()
  const released = signal()
  opened.faux.setResponses([
    async () => {
      entered.resolve()
      await released.promise
      return fauxAssistantMessage('Host completed.')
    },
  ])
  const finished = signal()
  let aborted = false
  const chat = new PlainChat({
    transport: opened.transport,
    onFinish: ({ isAbort }) => {
      aborted = isAbort
      finished.resolve()
    },
    onError: (error) => finished.reject(error),
  })
  const sending = chat.sendMessage({ text: 'Answer' })
  await entered.promise
  await chat.stop()
  released.resolve()
  await sending
  await finished.promise
  expect(aborted).toBe(true)
  expect(chat.status).toBe('ready')
  await opened.root.waitForIdle(context)
  const saved = await history(opened.harness, opened.root.id, { limit: 10 }, context)
  const message = saved.messages.at(-1)
  if (message === undefined) throw new Error('Expected stored assistant')
  expect(message.parts).toContainEqual({ type: 'text', text: 'Host completed.', state: 'done' })
  await abort(opened.harness, opened.root.id, context)
})

// AI SDK packages/ai/src/ui/chat.test.ts:1875-1921.
// Ports packages/ai/src/ui/chat.test.ts:1875 — Chat > should use an explicitly provided ID when replacing a user message.
it('should use an explicitly provided ID when replacing a user message', async () => {
  const fixture = await host({}, {})
  const opened = await fixture.open()
  opened.faux.setResponses([fauxAssistantMessage('Original.'), fauxAssistantMessage('Edited.')])
  const chat = new PlainChat({ transport: opened.transport })
  await chat.sendMessage({ text: 'Original prompt' })
  const original = chat.messages[0]
  if (original === undefined) throw new Error('Expected user')
  await chat.sendMessage({
    id: 'replacement-id',
    parts: [{ type: 'text', text: 'Edited prompt' }],
    messageId: original.id,
  })
  expect(chat.messages[0]).toMatchObject({
    id: 'replacement-id',
    role: 'user',
    parts: [{ type: 'text', text: 'Edited prompt' }],
  })
  expect(texts(last(chat))).toEqual(['Edited.'])
})

// AI SDK packages/ai/src/ui/chat.test.ts:1923-1949.
// Ports packages/ai/src/ui/chat.test.ts:1923 — Chat > should reject when onFinish throws.
it('should reject when onFinish throws', async () => {
  const fixture = await host({}, {})
  const opened = await fixture.open()
  opened.faux.setResponses([fauxAssistantMessage('Done.')])
  const failure = new Error('onFinish failed')
  const chat = new PlainChat({
    transport: opened.transport,
    onFinish: () => {
      throw failure
    },
  })
  await expect(chat.sendMessage({ text: 'Answer' })).rejects.toBe(failure)
  expect(opened.faux.state.callCount).toBe(1)
  expect(
    (await history(opened.harness, opened.root.id, { limit: 10 }, context)).messages,
  ).toHaveLength(2)
})

// AI SDK packages/ai/src/ui/http-chat-transport.test.ts:243-268.
// Ports packages/ai/src/ui/http-chat-transport.test.ts:243 — HttpChatTransport > error response > should throw APICallError when sending messages returns a non-OK response.
it('should throw APICallError when sending messages returns a non-OK response', async () => {
  const fixture = await host({}, {})
  const opened = await fixture.open()
  await expect(
    opened.transport.sendMessages({
      trigger: 'submit-message',
      chatId: 'invalid',
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    }),
  ).rejects.toMatchObject({ name: 'AI_APICallError', statusCode: 400 })
  expect(opened.faux.state.callCount).toBe(0)
})

// AI SDK packages/ai/src/ui/http-chat-transport.test.ts:432-457.
// Ports packages/ai/src/ui/http-chat-transport.test.ts:432 — HttpChatTransport > reconnectToStream > should throw APICallError for a non-OK response.
it('should throw APICallError for a non-OK reconnect response', async () => {
  const fixture = await host({}, {})
  const opened = await fixture.open()
  const missing = await opened.harness.createConversation(
    { ownership: { kind: 'ownerless' } },
    context,
  )
  const other = await host({}, {})
  const unrelated = await other.open()
  const transport = new DefaultChatTransport<UIMessage>({
    api: 'http://durable.test/chat',
    fetch: async (url, init) =>
      respond(unrelated.harness, missing.id, new Request(url, init), context),
  })
  await expect(transport.reconnectToStream({ chatId: 'missing' })).rejects.toBeInstanceOf(
    APICallError,
  )
  expect(unrelated.faux.state.callCount).toBe(0)
})

// AI SDK packages/ai/src/ui/chat.test.ts:2545, should delay tool output submission until the stream is finished.
// Hold only delivery of the real response's EOF: early client output must stay local until EOF.
// Ports packages/ai/src/ui/chat.test.ts:2545 — Chat > sendAutomaticallyWhen > should delay tool output submission until the stream is finished.
it('should delay tool output submission until the stream is finished', async () => {
  const fixture = await shop()
  const opened = await fixture.open()
  opened.faux.setResponses([
    call('ask', { question: 'Which?' }, 'ask'),
    fauxAssistantMessage('Answered.'),
  ])
  const delivered = signal()
  const release = signal()
  const toolSeen = signal()
  let requests = 0
  const transport = new DefaultChatTransport<UIMessage>({
    api: 'http://durable.test/chat',
    fetch: async (url, init) => {
      const response = await respond(
        opened.harness,
        opened.root.id,
        new Request(url, init),
        context,
      )
      requests++
      if (requests !== 1) return response
      if (response.body === null) throw new Error('Expected SSE body')
      const body = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform: (chunk, controller) => controller.enqueue(chunk),
          flush: async () => {
            delivered.resolve()
            await release.promise
          },
        }),
      )
      return new Response(body, { status: response.status, headers: response.headers })
    },
  })
  const chat = new PlainChat({
    transport,
    onToolCall: () => toolSeen.resolve(),
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
  })
  const pending = chat.sendMessage({ text: 'Ask' })
  onTestFinished(async () => {
    release.resolve()
    await pending
  })
  await toolSeen.promise
  await delivered.promise
  await chat.addToolOutput({ tool: 'ask', toolCallId: 'ask', output: 'Savings' })
  expect(last(chat).parts.find(isToolUIPart)).toMatchObject({
    state: 'output-available',
    output: 'Savings',
  })
  expect(requests).toBe(1)
  expect(opened.faux.state.callCount).toBe(1)
  release.resolve()
  await pending
  expect(requests).toBe(2)
  expect(texts(last(chat))).toEqual(['Answered.'])
})

// AI SDK packages/ai/src/ui/chat.test.ts:654/712/746, disconnected response onFinish/final/live messages.
// Inject a network loss into the actual SSE bytes; the host remains held until GET is attached.
// Ports packages/ai/src/ui/chat.test.ts:654 — Chat > send handle a disconnected response stream > should call onFinish with message and messages.
it('calls onFinish with the recovered message after a disconnected response', async () => {
  const entered = signal()
  const release = signal()
  const attached = signal()
  const fixture = await host(
    {
      pause: tool({
        inputSchema: z.object({}),
        execute: async () => {
          entered.resolve()
          await release.promise
          return 'Continued.'
        },
      }),
    },
    {},
  )
  const opened = await fixture.open()
  opened.faux.setResponses([
    fauxAssistantMessage(
      [{ type: 'text', text: 'Starting.' }, fauxToolCall('pause', {}, { id: 'pause' })],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('Finished.'),
  ])
  const transport = new DefaultChatTransport<UIMessage>({
    api: 'http://durable.test/chat',
    fetch: async (url, init) => {
      const request = new Request(url, init)
      const response = await respond(opened.harness, opened.root.id, request, context)
      if (request.method === 'GET') {
        attached.resolve()
        return response
      }
      if (response.body === null) throw new Error('Expected SSE body')
      const decoder = new TextDecoder()
      const body = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform: (chunk, controller) => {
            if (decoder.decode(chunk).includes('tool-input-available'))
              controller.error(new TypeError('network connection lost'))
            else controller.enqueue(chunk)
          },
        }),
      )
      return new Response(body, { headers: response.headers })
    },
  })
  const completions: UIMessage[] = []
  let completedMessages: UIMessage[] = []
  const chat = new PlainChat({
    transport: resumable(transport),
    onFinish: ({ message, messages }) => {
      completions.push(message)
      completedMessages = messages
    },
  })
  onTestFinished(async () => {
    release.resolve()
    await opened.root.waitForIdle(context)
  })
  await chat.sendMessage({ text: 'Build' })
  await entered.promise
  expect(chat.status).toBe('error')
  expect(texts(last(chat))).toEqual(['Starting.'])
  chat.clearError()
  const pending = chat.resumeStream()
  await attached.promise
  release.resolve()
  await pending
  expect(chat.status).toBe('ready')
  expect(completions.at(-1)).toEqual(last(chat))
  expect(completedMessages).toEqual(chat.messages)
  expect(chat.messages.map(texts)).toEqual([['Build'], ['Starting.', 'Finished.']])
})

// AI SDK packages/ai/src/ui/chat.test.ts:3704, addToolApprovalResponse options forwarding:
// should forward options to makeRequest when auto-sending.
// Ports packages/ai/src/ui/chat.test.ts:3704 — Chat > addToolApprovalResponse options forwarding > should forward options to makeRequest when auto-sending.
it('forwards approval options to makeRequest when auto-sending', async () => {
  const fixture = await shop()
  const opened = await fixture.open()
  opened.faux.setResponses([call('pay', { amount: 100 }, 'pay'), fauxAssistantMessage('Paid.')])
  const requests: Request[] = []
  const transport = new DefaultChatTransport<UIMessage>({
    api: 'http://durable.test/chat',
    fetch: async (url, init) => {
      const request = new Request(url, init)
      requests.push(request.clone())
      return respond(opened.harness, opened.root.id, request, context)
    },
  })
  const finished = signal()
  const chat = new PlainChat({
    transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onFinish: () => {
      if (requests.length === 2) finished.resolve()
    },
    onError: (error) => finished.reject(error),
  })
  await chat.sendMessage({ text: 'Pay' })
  const part = last(chat).parts.find(isToolUIPart)
  if (part === undefined || part.state !== 'approval-requested')
    throw new Error('Expected approval')
  await chat.addToolApprovalResponse({
    id: part.approval.id,
    approved: true,
    options: { headers: { 'x-upstream': 'approval' }, body: { additional: 'approval' } },
  })
  await finished.promise
  const request = requests[1]
  if (request === undefined) throw new Error('Expected continuation request')
  expect(request.headers.get('x-upstream')).toBe('approval')
  expect(await request.text()).toContain('"additional":"approval"')
  expect(fixture.paid).toEqual([100])
  expect(texts(last(chat))).toEqual(['Paid.'])
})

// AI SDK packages/ai/src/ui/process-ui-message-stream.test.ts:8030/9117/9853, dynamic approval request/result/denial final state.
// SDK dynamicTool registration retains dynamic identity while parked and after settlement.
// Ports packages/ai/src/ui/process-ui-message-stream.test.ts:8030 — processUIMessageStream > tool approval requests (dynamic tool) > should have the correct final message state.
it.each([true, false])(
  'retains dynamic identity through approval=%s and execution',
  async (approved) => {
    let executions = 0
    const fixture = await host(
      {
        dynamic: dynamicTool({
          inputSchema: z.object({}),
          execute: async () => {
            executions++
            return 'Dynamic output.'
          },
        }),
      },
      { approval: { dynamic: true } },
    )
    const opened = await fixture.open()
    opened.faux.setResponses([call('dynamic', {}, 'dynamic'), fauxAssistantMessage('Settled.')])
    const initial = await consume(
      await streamRun(
        opened.harness,
        { conversationId: opened.root.id, content: 'Go', requestId: 'dynamic' },
        context,
      ),
    )
    expect(initial.message.parts.find(isToolUIPart)).toMatchObject({
      type: 'dynamic-tool',
      toolName: 'dynamic',
      state: 'approval-requested',
    })
    await decide(
      opened.harness,
      opened.root.id,
      {
        holdId: await hold(opened.harness, opened.root.id, 'dynamic'),
        approved,
        reason: 'Decision',
      },
      context,
    )
    const result = await consume(
      await continueRun(
        opened.harness,
        opened.root.id,
        { messageId: initial.message.id, known: new Set(['dynamic']) },
        context,
      ),
      initial.message,
    )
    expect(result.message.parts.find(isToolUIPart)).toMatchObject({
      type: 'dynamic-tool',
      toolName: 'dynamic',
      state: approved ? 'output-available' : 'output-denied',
    })
    expect(executions).toBe(approved ? 1 : 0)
    expect(texts(result.message)).toEqual(['Settled.'])
    expect(await waiting(opened.harness, opened.root.id, context)).toEqual([])
  },
)

// AI SDK packages/ai/src/ui/process-ui-message-stream.test.ts:7599/7707/7717/7772, tool title support:
// includes title in static/dynamic invocation parts and preserves it in output/error states.
// SDK titles are retained through the emitted input and output/error states.
// Ports packages/ai/src/ui/process-ui-message-stream.test.ts:7599 — processUIMessageStream > tool title support > static tool with title > should include title in tool invocation parts.
it.each([
  { kind: 'static', failed: false },
  { kind: 'dynamic', failed: false },
  { kind: 'static', failed: true },
])('preserves $kind tool title with failed=$failed', async ({ kind, failed }) => {
  const registration = {
    title: 'Upstream tool',
    inputSchema: z.object({}),
    execute: async () => {
      if (failed) throw new Error('Tool execution failed')
      return 'Result.'
    },
  }
  const registered = kind === 'dynamic' ? dynamicTool(registration) : tool(registration)
  const fixture = await host({ titled: registered }, {})
  const opened = await fixture.open()
  opened.faux.setResponses([call('titled', {}, 'title'), fauxAssistantMessage('Done.')])
  const result = await consume(
    await streamRun(
      opened.harness,
      { conversationId: opened.root.id, content: 'Run', requestId: 'title' },
      context,
    ),
  )
  expect(result.chunks.filter((chunk) => chunk.type === 'tool-input-available')).toMatchObject([
    { title: 'Upstream tool' },
  ])
  expect(result.message.parts.find(isToolUIPart)).toMatchObject({
    title: 'Upstream tool',
    state: failed ? 'output-error' : 'output-available',
    type: kind === 'dynamic' ? 'dynamic-tool' : 'tool-titled',
  })
  if (failed)
    expect(result.message.parts.find(isToolUIPart)).toMatchObject({
      errorText: expect.stringContaining('Tool execution failed'),
    })
  else expect(result.message.parts.find(isToolUIPart)).toMatchObject({ output: 'Result.' })
})

// AI SDK packages/ai/src/ui/process-ui-message-stream.test.ts:7521/9422, tool returns preliminary results,
// including initial tool execution after approval with preliminary tool output.
// AsyncIterable execution retains its final yielded value. Preliminary values are deliberately
// not streamed; preserve all static/dynamic and approval/no-approval variants.
// Ports packages/ai/src/ui/process-ui-message-stream.test.ts:7521 — processUIMessageStream > preliminary tool results > should have the correct final message state.
it.each([
  { kind: 'static', approval: false },
  { kind: 'static', approval: true },
  { kind: 'dynamic', approval: false },
  { kind: 'dynamic', approval: true },
])(
  'preserves the final $kind generator output with approval=$approval',
  async ({ kind, approval }) => {
    const registration = {
      inputSchema: z.object({}),
      execute: async function* () {
        yield { status: 'loading' }
        yield { status: 'success' }
      },
    }
    const progress = kind === 'dynamic' ? dynamicTool(registration) : tool(registration)
    const fixture = await host({ progress }, { approval: { progress: approval } })
    const opened = await fixture.open()
    opened.faux.setResponses([call('progress', {}, 'progress'), fauxAssistantMessage('Done.')])
    const initial = await consume(
      await streamRun(
        opened.harness,
        { conversationId: opened.root.id, content: 'Run', requestId: 'progress' },
        context,
      ),
    )
    let result = initial
    if (approval) {
      expect(initial.message.parts.find(isToolUIPart)).toMatchObject({
        state: 'approval-requested',
      })
      await decide(
        opened.harness,
        opened.root.id,
        { holdId: await hold(opened.harness, opened.root.id, 'progress'), approved: true },
        context,
      )
      result = await consume(
        await continueRun(
          opened.harness,
          opened.root.id,
          { messageId: initial.message.id, known: new Set(['progress']) },
          context,
        ),
        initial.message,
      )
    }
    const outputs = result.chunks.filter((chunk) => chunk.type === 'tool-output-available')
    expect(outputs).toHaveLength(1)
    expect(outputs).toMatchObject([{ output: { status: 'success' } }])
    expect(outputs[0]).not.toMatchObject({ preliminary: true })
    const part = result.message.parts.find(isToolUIPart)
    expect(part).toMatchObject({ state: 'output-available', output: { status: 'success' } })
    expect(part).not.toMatchObject({ preliminary: true })
    expect(texts(result.message)).toEqual(['Done.'])
  },
)

// AI SDK last-assistant-message-is-complete-with-tool-calls.test.ts:
// dynamic complete/waiting/error, mixed complete/incomplete, and multi-step last-step-only cases.
// Port the predicate result separately from dynamic UI identity: current static-tagged parts still
// classify correctly. Client output-error admission remains a distinct gap in chat.test.ts:2844.
// Ports packages/ai/src/ui/last-assistant-message-is-complete-with-tool-calls.test.ts:156 — lastAssistantMessageIsCompleteWithToolCalls > should return true when dynamic tool call is complete.
it.each([
  { name: 'dynamic complete', output: 'value', mixed: false, plainDone: false, multiple: false },
  { name: 'dynamic waiting', output: 'none', mixed: false, plainDone: false, multiple: false },
  { name: 'dynamic error', output: 'error', mixed: false, plainDone: false, multiple: false },
  { name: 'mixed complete', output: 'value', mixed: true, plainDone: true, multiple: false },
  { name: 'mixed incomplete', output: 'value', mixed: true, plainDone: false, multiple: false },
  { name: 'last-step complete', output: 'value', mixed: false, plainDone: false, multiple: true },
  { name: 'last-step incomplete', output: 'none', mixed: false, plainDone: false, multiple: true },
] as const)('classifies $name tool completion from the real stream', async (given) => {
  const fixture = await host(
    {
      dynamic: dynamicTool({ inputSchema: z.object({}) }),
      plain: tool({ inputSchema: z.object({}) }),
      echo: tool({ inputSchema: z.object({}), execute: async () => 'Earlier.' }),
    },
    {},
  )
  const opened = await fixture.open()
  const calls = [fauxToolCall('dynamic', {}, { id: 'dynamic' })]
  if (given.mixed) calls.push(fauxToolCall('plain', {}, { id: 'plain' }))
  const response = fauxAssistantMessage(calls, { stopReason: 'toolUse' })
  opened.faux.setResponses(given.multiple ? [call('echo', {}, 'echo'), response] : [response])
  const chat = new PlainChat({ transport: opened.transport })
  await chat.sendMessage({ text: 'Go' })
  expect(lastAssistantMessageIsCompleteWithToolCalls({ messages: chat.messages })).toBe(false)
  if (given.output === 'value')
    await chat.addToolOutput({ tool: 'dynamic', toolCallId: 'dynamic', output: 'Answered.' })
  if (given.output === 'error')
    await chat.addToolOutput({
      tool: 'dynamic',
      toolCallId: 'dynamic',
      state: 'output-error',
      errorText: 'Could not answer',
    })
  if (given.plainDone)
    await chat.addToolOutput({ tool: 'plain', toolCallId: 'plain', output: 'Plain.' })
  const complete = given.output !== 'none' && (!given.mixed || given.plainDone)
  expect(lastAssistantMessageIsCompleteWithToolCalls({ messages: chat.messages })).toBe(complete)
  expect(last(chat).parts.filter((part) => part.type === 'step-start')).toHaveLength(
    given.multiple ? 2 : 1,
  )
  expect(opened.faux.state.callCount).toBe(given.multiple ? 2 : 1)
})
