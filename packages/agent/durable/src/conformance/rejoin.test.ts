import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import {
  DefaultChatTransport,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  tool,
  type UIMessage,
} from 'ai'
import { Match } from 'effect'
import { expect, it } from 'vitest'
import { z } from 'zod'

import { resumption } from '../client.ts'
import { PlainChat } from '../fixtures/chat.ts'
import { attachRun, decide, holdId, rejoinRun, RejoinInvalid, respond, streamRun } from '../main.ts'
import { context, consume, host, signal, texts } from './fixtures/host.ts'

/** Retry attempts stay in one step; tool rounds and steers advance steps identically in both paths. */
it.each(['parallel', 'sequential', 'retry', 'steer'] as const)(
  'uses the live step index in the %s snapshot',
  async (runKind) => {
    const entered = signal()
    const release = signal()
    const execution = runKind === 'sequential' ? 'sequential' : 'parallel'
    const fixture = await host(
      {
        work: tool({
          inputSchema: z.object({}),
          execute: async () => {
            entered.resolve()
            await release.promise
            return 'worked'
          },
        }),
        pay: tool({ inputSchema: z.object({}), execute: async () => 'paid' }),
      },
      { execution, approval: { pay: true } },
      { toolExecution: execution, steeringMode: 'all' },
    )
    const opened = await fixture.open()
    const parked = fauxAssistantMessage(
      [{ type: 'text', text: 'Review' }, fauxToolCall('pay', {}, { id: 'pay' })],
      { stopReason: 'toolUse' },
    )
    const preceding = Match.value(runKind).pipe(
      Match.when('retry', () => [
        fauxAssistantMessage('failed attempt', {
          stopReason: 'error',
          errorMessage: '503 Service Unavailable',
        }),
      ]),
      Match.when('steer', () => [
        fauxAssistantMessage([fauxToolCall('work', {}, { id: 'work' })], { stopReason: 'toolUse' }),
      ]),
      Match.orElse(() => []),
    )
    opened.faux.setResponses([...preceding, parked])
    try {
      const live = consume(
        await streamRun(
          opened.harness,
          { conversationId: opened.root.id, content: 'Start', requestId: runKind },
          context,
        ),
      )
      if (runKind === 'steer') {
        await entered.promise
        await opened.root.submit(
          { type: 'input', content: 'Steer', requestId: 'steer', whenBusy: 'steer' },
          context,
        )
        release.resolve()
      }
      const result = await live
      const steps = result.chunks.filter((chunk) => chunk.type === 'start-step').length
      expect(steps).toBe(runKind === 'steer' ? 2 : 1)
      const attached = await attachRun(opened.harness, opened.root.id, context)
      const rejoined = await rejoinRun(
        opened.harness,
        opened.root.id,
        { messageId: result.message.id, steps },
        context,
      )
      if (attached.status === 'idle' || rejoined.status === 'idle')
        throw new Error('Expected parked run')
      const whole = await consume(attached.stream)
      expect(whole.chunks.filter((chunk) => chunk.type === 'start-step')).toHaveLength(steps)
      expect(texts(whole.message)).toEqual(texts(result.message))
      const tail = await consume(rejoined.stream, result.message)
      expect(tail.chunks.filter((chunk) => chunk.type === 'start-step')).toHaveLength(0)
      expect(tail.message.parts.map((part) => part.type)).toEqual(
        result.message.parts.map((part) => part.type),
      )
    } finally {
      release.resolve()
    }
  },
)

/** A later response may already be present when a disconnected client rejoins its second step. */
it('rejoins retained step 2 when the run has reached step 3', async () => {
  const second = signal()
  const third = signal()
  const releaseSecond = signal()
  const releaseThird = signal()
  const fixture = await host(
    {
      work: tool({ inputSchema: z.object({}), execute: async () => 'first result' }),
      pause: tool({
        inputSchema: z.object({}),
        execute: async () => {
          second.resolve()
          await releaseSecond.promise
          return 'second result'
        },
      }),
      final: tool({
        inputSchema: z.object({}),
        execute: async () => {
          third.resolve()
          await releaseThird.promise
          return 'third result'
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
    fauxAssistantMessage(
      [{ type: 'text', text: 'Finished.' }, fauxToolCall('final', {}, { id: 'final' })],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('Done.'),
  ])
  const link = resumption()
  const attached = signal()
  const chat = new PlainChat({
    onFinish: link.onFinish,
    transport: new DefaultChatTransport<UIMessage>({
      api: 'http://durable.test/chat',
      prepareReconnectToStreamRequest: link.prepare,
      fetch: async (url, init) => {
        const request = new Request(url, init)
        const response = await respond(opened.harness, opened.root.id, request, context)
        if (request.method === 'GET') {
          attached.resolve()
          return response
        }
        if (response.body === null) throw new Error('Expected SSE body')
        const decoder = new TextDecoder()
        let secondText = false
        return new Response(
          response.body.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                const text = decoder.decode(chunk)
                if (secondText && text.includes('text-end')) {
                  controller.error(new TypeError('network connection lost'))
                  return
                }
                if (text.includes('"delta":"Fin"')) secondText = true
                controller.enqueue(chunk)
              },
            }),
          ),
          { headers: response.headers },
        )
      },
    }),
  })
  try {
    await chat.sendMessage({ text: 'Start' })
    await second.promise
    expect(chat.status).toBe('error')
    releaseSecond.resolve()
    await third.promise
    chat.clearError()
    const resumed = chat.resumeStream()
    await attached.promise
    releaseThird.resolve()
    await resumed
    expect(chat.status).toBe('ready')
    if (chat.lastMessage === undefined) throw new Error('Expected assistant')
    expect(texts(chat.lastMessage)).toEqual(['Starting.', 'Fin', 'Finished.', 'Done.'])
    expect(chat.lastMessage.parts.map((part) => part.type)).toEqual([
      'step-start',
      'text',
      'tool-work',
      'step-start',
      'text',
      'tool-pause',
      'step-start',
      'text',
      'tool-final',
      'step-start',
      'text',
    ])
  } finally {
    releaseSecond.resolve()
    releaseThird.resolve()
    await opened.root.waitForIdle(context)
  }
})

/** The GET ingress validates a complete query pair before opening a watch, including while idle. */
it.each([
  'message=m',
  'steps=1',
  'message=m&steps=0',
  'message=m&steps=1.5',
  'message=m&steps=NaN',
  'message=m&steps=Infinity',
])('rejects malformed reconnect query %s with 400', async (query) => {
  const opened = await (await host({}, {})).open()
  const response = await respond(
    opened.harness,
    opened.root.id,
    new Request(`http://durable.test/chat?${query}`),
    context,
  )
  expect(response.status).toBe(400)
  expect(await response.text()).toBe('Invalid reconnect state')
})

/** A snapshot taken at an approval has the same step number as the live stream that parked there. */
it('validates step bounds, preserves whole replay for another message and rejoins a parked approval', async () => {
  let paid = 0
  const fixture = await host(
    {
      pay: tool({
        inputSchema: z.object({}),
        execute: async () => {
          paid += 1
          return 'paid'
        },
      }),
    },
    { approval: { pay: true } },
  )
  const opened = await fixture.open()
  opened.faux.setResponses([
    fauxAssistantMessage([fauxToolCall('pay', {}, { id: 'pay' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage('Done.'),
  ])
  const initial = await consume(
    await streamRun(
      opened.harness,
      { conversationId: opened.root.id, content: 'Pay', requestId: 'park' },
      context,
    ),
  )
  expect(initial.chunks.filter((chunk) => chunk.type === 'start-step')).toHaveLength(1)
  const invalid = await rejoinRun(
    opened.harness,
    opened.root.id,
    { messageId: initial.message.id, steps: 2 },
    context,
  ).then(
    () => undefined,
    (error: Error) => error,
  )
  expect(invalid).toBeInstanceOf(RejoinInvalid)
  const response = await respond(
    opened.harness,
    opened.root.id,
    new Request(
      `http://durable.test/chat?message=${encodeURIComponent(initial.message.id)}&steps=2`,
    ),
    context,
  )
  expect(response.status).toBe(400)
  const whole = await attachRun(opened.harness, opened.root.id, context)
  const other = await rejoinRun(
    opened.harness,
    opened.root.id,
    { messageId: 'older-message', steps: 500 },
    context,
  )
  if (whole.status === 'idle' || other.status === 'idle') throw new Error('Expected active run')
  expect((await consume(other.stream)).chunks).toEqual((await consume(whole.stream)).chunks)
  const initialPart = initial.message.parts.find(isToolUIPart)
  if (initialPart === undefined || initialPart.state !== 'approval-requested')
    throw new Error('Expected initial approval')
  await decide(
    opened.harness,
    opened.root.id,
    { holdId: holdId(initialPart.approval.id), approved: true },
    context,
  )
  await opened.root.waitForIdle(context)
  paid = 0
  opened.faux.setResponses([
    fauxAssistantMessage([fauxToolCall('pay', {}, { id: 'pay' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage('Done.'),
  ])
  // Reproduce a disconnect after receiving the request but before the stream's finish chunk.
  const link = resumption()
  let finished = signal()
  const chat = new PlainChat({
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onFinish: (event) => {
      link.onFinish(event)
      if (!event.isDisconnect) finished.resolve()
    },
    transport: new DefaultChatTransport<UIMessage>({
      api: 'http://durable.test/chat',
      prepareReconnectToStreamRequest: link.prepare,
      fetch: async (url, init) => {
        const request = new Request(url, init)
        const result = await respond(opened.harness, opened.root.id, request, context)
        if (request.method === 'GET' || result.body === null) return result
        const decoder = new TextDecoder()
        return new Response(
          result.body.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                if (decoder.decode(chunk).includes('"type":"finish"') && paid === 0)
                  controller.error(new TypeError('network connection lost'))
                else controller.enqueue(chunk)
              },
            }),
          ),
          { headers: result.headers },
        )
      },
    }),
  })
  await chat.sendMessage({ text: 'Pay again' })
  expect(chat.status).toBe('error')
  chat.clearError()
  await chat.resumeStream()
  if (chat.lastMessage === undefined) throw new Error('Expected assistant')
  expect(chat.lastMessage.parts.filter((part) => part.type === 'step-start')).toHaveLength(1)
  const part = chat.lastMessage.parts.find(isToolUIPart)
  if (part === undefined || part.state !== 'approval-requested')
    throw new Error('Expected approval')
  finished = signal()
  chat.addToolApprovalResponse({ id: part.approval.id, approved: true })
  await finished.promise
  await opened.root.waitForIdle(context)
  expect(paid).toBe(1)
  expect(chat.status).toBe('ready')
})
