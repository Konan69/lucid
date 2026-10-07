import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
  isToolUIPart,
  tool,
  type UIMessage,
  type UIMessageChunk,
  type ChatTransport,
} from 'ai'
import { expect, it, onTestFinished } from 'vitest'
import { z } from 'zod'
import { Effect, Predicate, Match } from 'effect'
import { waitForFrame } from '../fixtures/provider.ts'

import { resumable, ConnectionLost, connectionLostInput, closeInputs } from '../client.ts'
import { ChatTurn } from '../core.ts'
import { PlainChat } from '../fixtures/chat.ts'
import { respond, waiting, decodeTurn, attachRun, streamRun, TurnWaiting } from '../main.ts'
import { context, host, signal, texts, consume } from './fixtures/host.ts'

/** A later response may already be present when a disconnected client resumes from its second step. */
it('replays a dropped step 2 when the run has reached step 3', async () => {
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
  const attached = signal()
  const chat = new PlainChat({
    transport: resumable(
      new DefaultChatTransport<UIMessage>({
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
    ),
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

/** Chunk faults exercise the public transport protocol, independent of SSE packet boundaries. */
function disconnect(
  source: ReadableStream<UIMessageChunk>,
  input: { step: number; marker: 'text-delta' | 'tool-input-available' | 'tool-input-delta' },
) {
  const reader = source.getReader()
  let step = 0
  let cut = false
  return new ReadableStream<UIMessageChunk>(
    {
      async pull(controller) {
        if (cut) {
          await reader.cancel()
          controller.error(new TypeError('network connection lost'))
          return
        }
        const next = await reader.read()
        if (next.done) return controller.close()
        if (next.value.type === 'start-step') step += 1
        controller.enqueue(next.value)
        if (step === input.step && next.value.type === input.marker) cut = true
      },
      cancel: (reason) => reader.cancel(reason),
    },
    { highWaterMark: 0 },
  )
}

/** Three actual tool rounds keep the selected run attachable until the GET watch is open. */
async function reconnectFixture(
  step: number,
  marker: 'text-delta' | 'tool-input-available' | 'tool-input-delta',
) {
  const entered = signal()
  const release = signal()
  onTestFinished(() => release.resolve())
  const gate = (index: number) =>
    tool({
      inputSchema: z.object({}),
      execute: async () => {
        if (index === step) {
          entered.resolve()
          await release.promise
        }
        return `result ${index}`
      },
    })
  const fixture = await host(
    { one: gate(1), two: gate(2), three: gate(3), ask: tool({ inputSchema: z.object({}) }) },
    {},
  )
  const opened = await fixture.open()
  opened.faux.setResponses([
    fauxAssistantMessage([{ type: 'text', text: 'S1.' }, fauxToolCall('one', {}, { id: 'one' })], {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage([{ type: 'text', text: 'S2.' }, fauxToolCall('two', {}, { id: 'two' })], {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage(
      [{ type: 'text', text: 'S3.' }, fauxToolCall('three', {}, { id: 'three' })],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('Done.'),
  ])
  const get = signal()
  let pendingGet = false
  const proceed = signal()
  onTestFinished(() => proceed.resolve())
  const base: ChatTransport<UIMessage> = {
    sendMessages: async (input) =>
      disconnect(await opened.transport.sendMessages(input), { step, marker }),
    reconnectToStream: async (input) => {
      if (pendingGet) {
        get.resolve()
        const stopped = signal()
        if (input.abortSignal !== undefined)
          input.abortSignal.addEventListener(
            'abort',
            () => stopped.reject(new DOMException('Stopped', 'AbortError')),
            { once: true },
          )
        await Promise.race([proceed.promise, stopped.promise])
      }
      const stream = await opened.transport.reconnectToStream(input)
      get.resolve()
      return stream
    },
  }
  return {
    opened,
    entered,
    release,
    get,
    proceed,
    transport: resumable(base),
    delayGet: () => {
      pendingGet = true
    },
  }
}

/** Each run step is rebuilt once after either a text receipt or a completed tool input. */
it.each([
  [1, 'text-delta'],
  [1, 'tool-input-available'],
  [2, 'text-delta'],
  [2, 'tool-input-available'],
  [3, 'text-delta'],
  [3, 'tool-input-available'],
] as const)('replaces a dropped step %s at %s with whole-run replay', async (step, marker) => {
  const fixture = await reconnectFixture(step, marker)
  const chat = new PlainChat({ transport: fixture.transport })
  await chat.sendMessage({ text: 'Start' })
  await fixture.entered.promise
  expect(chat.error).toBeInstanceOf(ConnectionLost)
  if (marker === 'text-delta' && chat.lastMessage !== undefined) {
    for (const part of chat.lastMessage.parts.filter(isToolUIPart)) {
      expect(part.state).not.toBe('input-streaming')
    }
  }
  chat.clearError()
  const resumed = chat.resumeStream()
  await fixture.get.promise
  fixture.release.resolve()
  await resumed
  expect(chat.status).toBe('ready')
  expect(chat.messages.filter((message) => message.role === 'assistant')).toHaveLength(1)
  assertWhole(chat.lastMessage)
})

/** A shared guard holds no claims: a fresh Chat always receives every earlier step too. */
it('shares a transport with a fresh Chat without losing earlier steps', async () => {
  const fixture = await reconnectFixture(2, 'tool-input-available')
  const first = new PlainChat({ transport: fixture.transport })
  await first.sendMessage({ text: 'Start' })
  await fixture.entered.promise
  const fresh = new PlainChat({ transport: fixture.transport })
  const resumed = fresh.resumeStream()
  await fixture.get.promise
  fixture.release.resolve()
  await resumed
  expect(fresh.status).toBe('ready')
  assertWhole(fresh.lastMessage)
})

/** Stopping an unresolved GET must not leave a stale step claim for the subsequent resume. */
it.each(['text-delta', 'tool-input-available'] as const)(
  'resumes after stopping a pending GET at %s',
  async (marker) => {
    const fixture = await reconnectFixture(2, marker)
    const chat = new PlainChat({ transport: fixture.transport })
    await chat.sendMessage({ text: 'Start' })
    await fixture.entered.promise
    fixture.delayGet()
    chat.clearError()
    const pending = chat.resumeStream()
    await fixture.get.promise
    await chat.stop()
    await pending
    fixture.proceed.resolve()
    const next = chat.resumeStream()
    fixture.release.resolve()
    await next
    expect(chat.status).toBe('ready')
    assertWhole(chat.lastMessage)
  },
)

/** Assert parts individually: concatenating text would conceal repeated steps or tool parts. */
function assertWhole(message: PlainChat['lastMessage']) {
  if (message === undefined) throw new Error('Expected completed assistant message')
  expect(texts(message)).toEqual(['S1.', 'S2.', 'S3.', 'Done.'])
  expect(message.parts.map((part) => part.type)).toEqual([
    'step-start',
    'text',
    'tool-one',
    'step-start',
    'text',
    'tool-two',
    'step-start',
    'text',
    'tool-three',
    'step-start',
    'text',
  ])
  expect(message.parts.filter(isToolUIPart).map((part) => part.state)).toEqual([
    'output-available',
    'output-available',
    'output-available',
  ])
}

/** A stale partial belongs to its old id; another device's active run is a separate message. */
it('resumes a newer run without merging it into the disconnected older message', async () => {
  const fixture = await reconnectFixture(2, 'tool-input-available')
  const first = new PlainChat({ transport: fixture.transport })
  await first.sendMessage({ text: 'Start' })
  await fixture.entered.promise
  const old = structuredClone(first.lastMessage)
  if (old === undefined) throw new Error('Expected old partial')
  fixture.release.resolve()
  await fixture.opened.root.waitForIdle(context)
  fixture.opened.faux.setResponses([
    fauxAssistantMessage(
      [{ type: 'text', text: 'New run.' }, fauxToolCall('ask', {}, { id: 'ask' })],
      { stopReason: 'toolUse' },
    ),
  ])
  const second = new PlainChat({ transport: fixture.opened.transport })
  await second.sendMessage({ text: 'Another run' })
  first.clearError()
  await first.resumeStream()
  expect(first.status).toBe('ready')
  const assistants = first.messages.filter((message) => message.role === 'assistant')
  expect(assistants).toHaveLength(2)
  expect(assistants[0]).toEqual(old)
  expect(first.lastMessage).toEqual(second.lastMessage)
  if (first.lastMessage === undefined) throw new Error('Expected newer message')
  expect(first.lastMessage.id).not.toBe(old.id)
})

/** Approval requests survive a drop before their delivery, using the stock automatic-send predicate. */
it('resumes a parked approval and approves through the SDK part', async () => {
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
    fauxAssistantMessage('Paid.'),
  ])
  let dropped = false
  const transport: ChatTransport<UIMessage> = {
    sendMessages: async (input) => {
      const stream = await opened.transport.sendMessages(input)
      if (dropped) return stream
      dropped = true
      return disconnect(stream, { step: 1, marker: 'tool-input-available' })
    },
    reconnectToStream: (input) => opened.transport.reconnectToStream(input),
  }
  let completion = signal()
  const chat = new PlainChat({
    transport: resumable(transport),
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onFinish: () => completion.resolve(),
  })
  await chat.sendMessage({ text: 'Pay' })
  expect(chat.status).toBe('error')
  chat.clearError()
  await chat.resumeStream()
  if (chat.lastMessage === undefined) throw new Error('Expected approval message')
  const part = chat.lastMessage.parts.find(isToolUIPart)
  if (part === undefined || part.state !== 'approval-requested') throw new Error('Expected request')
  completion = signal()
  await chat.addToolApprovalResponse({ id: part.approval.id, approved: true })
  await completion.promise
  expect(chat.status).toBe('ready')
  expect(paid).toBe(1)
  if (chat.lastMessage === undefined) throw new Error('Expected completed message')
  expect(texts(chat.lastMessage)).toEqual(['Paid.'])
})

/** The synthetic output-error marker is not a known call and never answers or approves it. */
it('ignores synthetic connection errors in a real resume body', async () => {
  const fixture = await host({ ask: tool({ inputSchema: z.object({}) }) }, {})
  const opened = await fixture.open()
  opened.faux.setResponses([
    fauxAssistantMessage([fauxToolCall('ask', {}, { id: 'ask' })], { stopReason: 'toolUse' }),
  ])
  const chat = new PlainChat({ transport: opened.transport })
  await chat.sendMessage({ text: 'Ask' })
  if (chat.lastMessage === undefined) throw new Error('Expected answer hold')
  const rows = await waiting(opened.harness, opened.root.id, context)
  const body = {
    messages: [
      {
        ...chat.lastMessage,
        parts: [
          {
            type: 'tool-ask',
            toolCallId: 'ask',
            state: 'output-error',
            errorText: connectionLostInput,
            output: 'must not settle',
          },
        ],
      },
    ],
  }
  const turn = await decodeTurn(body)
  if (!ChatTurn.guards.Resume(turn)) throw new Error('Expected resume turn')
  expect(turn.known).toEqual([])
  expect(turn.outputs).toEqual([])
  expect(turn.decisions).toEqual([])
  const response = await respond(
    opened.harness,
    opened.root.id,
    new Request('http://durable.test/chat', { method: 'POST', body: JSON.stringify(body) }),
    context,
  )
  expect(response.status).toBe(200)
  if (response.body === null) throw new Error('Expected response stream')
  await response.text()
  expect(await waiting(opened.harness, opened.root.id, context)).toEqual(rows)
})

/** Retained provider JSON is interrupted locally, then replay replaces the synthetic input error. */
it('closes a dropped raw input and resumes its real call without repeating arguments', async () => {
  const release = signal()
  onTestFinished(() => release.resolve())
  let gated = false
  const fixture = await host(
    {
      work: tool({ inputSchema: z.object({ input: z.string() }), execute: async (input) => input }),
    },
    {},
    { progress: { partialIntervalMs: 1 } },
    {
      partialFamily: 'anthropic',
      tokenSize: { min: 1, max: 1 },
      onFrame: (event, abortSignal) => {
        if (event.type !== 'toolcall_delta' || gated) return Effect.void
        const block = event.partial.content[event.contentIndex]
        if (block === undefined || block.type !== 'toolCall') throw new Error('Expected tool block')
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
  const opened = await fixture.open()
  const input = { input: 'abcdefghijklmnopqrstuvwxyz' }
  opened.faux.setResponses([
    fauxAssistantMessage([fauxToolCall('work', input, { id: 'work' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage('Finished.'),
  ])
  const get = signal()
  const chunks: UIMessageChunk[] = []
  let posts = 0
  const base: ChatTransport<UIMessage> = {
    sendMessages: async (options) => {
      posts += 1
      return disconnect(await opened.transport.sendMessages(options), {
        step: 1,
        marker: 'tool-input-delta',
      })
    },
    reconnectToStream: async (options) => {
      const stream = await opened.transport.reconnectToStream(options)
      get.resolve()
      if (stream === null) return null
      return stream.pipeThrough(
        new TransformStream<UIMessageChunk, UIMessageChunk>({
          transform(chunk, controller) {
            chunks.push(chunk)
            controller.enqueue(chunk)
          },
        }),
      )
    },
  }
  const chat = new PlainChat({
    transport: resumable(base),
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
  })
  await chat.sendMessage({ text: 'Work' })
  expect(chat.error).toBeInstanceOf(ConnectionLost)
  if (chat.lastMessage === undefined) throw new Error('Expected interrupted message')
  expect(chat.lastMessage.parts.find(isToolUIPart)).toMatchObject({
    state: 'output-error',
    errorText: connectionLostInput,
  })
  chat.clearError()
  const resumed = chat.resumeStream()
  await get.promise
  release.resolve()
  await resumed
  expect(chat.status).toBe('ready')
  expect(posts).toBe(1)
  const deltas = chunks.flatMap((chunk) =>
    chunk.type === 'tool-input-delta' ? [chunk.inputTextDelta] : [],
  )
  expect(JSON.stringify(input).startsWith(deltas.join(''))).toBe(true)
  expect(chunks.filter((chunk) => chunk.type === 'tool-input-start')).toHaveLength(1)
  expect(chat.messages.filter((message) => message.role === 'assistant')).toHaveLength(1)
  if (chat.lastMessage === undefined) throw new Error('Expected completed message')
  expect(chat.lastMessage.parts.filter(isToolUIPart)).toEqual([
    expect.objectContaining({ state: 'output-available', input, output: input }),
  ])
  expect(chat.lastMessage.parts.map((part) => part.type)).toEqual([
    'step-start',
    'tool-work',
    'step-start',
    'text',
  ])
})

/** Fetch owns AbortSignal cancellation; the guard preserves the SDK's actual isAbort finish. */
it('keeps stop during a stream as an abort rather than ConnectionLost', async () => {
  const release = signal()
  const visible = signal()
  onTestFinished(() => release.resolve())
  const fixture = await host(
    {
      work: tool({
        inputSchema: z.object({}),
        execute: async () => {
          await release.promise
          return 'worked'
        },
      }),
    },
    {},
  )
  const opened = await fixture.open()
  opened.faux.setResponses([
    fauxAssistantMessage([fauxToolCall('work', {}, { id: 'work' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage('Done.'),
  ])
  const finishes: { isAbort: boolean; isDisconnect: boolean; isError: boolean }[] = []
  const chat = new PlainChat({
    transport: resumable(
      new DefaultChatTransport({
        api: 'http://durable.test/chat',
        fetch: async (url, init) => {
          const request = new Request(url, init)
          const response = await respond(opened.harness, opened.root.id, request, context)
          if (response.body === null) throw new Error('Expected SSE response')
          const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), {
            signal: request.signal,
          })
          return new Response(body, { headers: response.headers })
        },
      }),
    ),
    onMessage: (message) => {
      if (message.parts.some((part) => isToolUIPart(part) && part.state === 'input-available'))
        visible.resolve()
    },
    onFinish: ({ isAbort, isDisconnect, isError }) => {
      finishes.push({ isAbort, isDisconnect, isError })
    },
  })
  const sending = chat.sendMessage({ text: 'Work' })
  await visible.promise
  await chat.stop()
  await sending
  expect(chat.status).toBe('ready')
  expect(chat.error).toBeUndefined()
  expect(finishes).toEqual([{ isAbort: true, isDisconnect: false, isError: false }])
  release.resolve()
  await opened.root.waitForIdle(context)
})

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
      if (attached.status === 'idle') throw new Error('Expected parked run')
      const whole = await consume(attached.stream)
      expect(whole.chunks.filter((chunk) => chunk.type === 'start-step')).toHaveLength(steps)
      expect(texts(whole.message)).toEqual(texts(result.message))
      expect(whole.message.parts.map((part) => part.type)).toEqual(
        result.message.parts.map((part) => part.type),
      )
    } finally {
      release.resolve()
    }
  },
)

/** A status refusal remains actionable typed text; it must not reconnect to another person's run. */
it('preserves a 409 through resumable at transport acquisition', async () => {
  const opened = await (
    await host(
      { pay: tool({ inputSchema: z.object({ amount: z.number() }), execute: async () => 'paid' }) },
      { approval: { pay: true } },
    )
  ).open()
  opened.faux.setResponses([
    fauxAssistantMessage([fauxToolCall('pay', { amount: 1 }, { id: 'pay' })], {
      stopReason: 'toolUse',
    }),
  ])
  const first = new PlainChat({ transport: opened.transport })
  await first.sendMessage({ text: 'First' })
  const second = new PlainChat({ transport: resumable(opened.transport) })
  await second.sendMessage({ text: 'Refused' })
  expect(second.status).toBe('error')
  expect(second.error).not.toBeInstanceOf(ConnectionLost)
  if (second.error === undefined) throw new Error('Expected HTTP refusal')
  expect(second.error.message).toBe(new TurnWaiting({ conversationId: opened.root.id }).message)
})

/** chat.ts:437–473 replaces a known user using sendMessage({messageId, text}). Lost HTTP
 * admission is retried with that identity: absent turns are admitted once and present turns join. */
it.each([false, true])(
  'retries a lost POST with the SDK user identity (admitted=%s)',
  async (admitted) => {
    const opened = await (
      await host(
        {
          pay: tool({ inputSchema: z.object({ amount: z.number() }), execute: async () => 'paid' }),
        },
        { approval: { pay: true } },
      )
    ).open()
    opened.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('pay', { amount: 1 }, { id: 'pay' })], {
        stopReason: 'toolUse',
      }),
    ])
    let lost = false
    const chat = new PlainChat({
      transport: resumable(
        new DefaultChatTransport<UIMessage>({
          api: 'http://durable.test/chat',
          fetch: async (url, init) => {
            const request = new Request(url, init)
            if (request.method === 'POST' && !lost) {
              lost = true
              if (admitted)
                await (await respond(opened.harness, opened.root.id, request, context)).text()
              throw new TypeError('fetch network failed')
            }
            return respond(opened.harness, opened.root.id, request, context)
          },
        }),
      ),
    })
    await chat.sendMessage({ text: 'Pay once' })
    expect(chat.error).toBeInstanceOf(ConnectionLost)
    const user = chat.messages[0]
    if (user === undefined || user.role !== 'user') throw new Error('Expected user')
    chat.clearError()
    await chat.resumeStream()
    if (!admitted) expect(chat.messages).toEqual([user])
    await chat.sendMessage({ messageId: user.id, text: 'Pay once' })
    expect(chat.status).toBe('ready')
    expect(opened.faux.state.callCount).toBe(1)
    expect(chat.messages.filter((message) => message.role === 'user')).toEqual([user])
    expect(chat.messages.filter((message) => message.role === 'assistant')).toHaveLength(1)
  },
)

/** The stock output predicate sees the synthetic terminal part as complete. Its one POST must
 * restore the missing input and request approval, instead of muting the call and looping. */
it.each(['pay', 'work'] as const)(
  're-presents a locally interrupted %s input when an earlier client call is answered',
  async (second) => {
    const release = signal()
    const visible = signal()
    onTestFinished(() => release.resolve())
    const fixture = await host(
      {
        ask: tool({ inputSchema: z.object({}) }),
        work: tool({
          inputSchema: z.object({ amount: z.number() }),
          execute: async () => {
            await release.promise
            return 'worked'
          },
        }),
        pay: tool({ inputSchema: z.object({ amount: z.number() }), execute: async () => 'paid' }),
      },
      { approval: { pay: true } },
    )
    const opened = await fixture.open()
    opened.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('ask', {}, { id: 'ask' }),
          fauxToolCall(second, { amount: 7 }, { id: 'pay' }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('Finished.'),
    ])
    let posts = 0
    const finished = signal()
    const chat = new PlainChat({
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
      onMessage: (message) => {
        if (
          posts === 2 &&
          message.parts.some(
            (part) =>
              isToolUIPart(part) && part.type === 'tool-work' && part.state === 'input-available',
          )
        )
          visible.resolve()
      },
      onFinish: ({ isError }) => {
        if (posts === 2 && !isError) finished.resolve()
      },
      transport: resumable({
        sendMessages: async (input) => {
          posts++
          const stream = await opened.transport.sendMessages(input)
          return posts === 1
            ? disconnect(stream, { step: 1, marker: 'tool-input-available' })
            : stream
        },
        reconnectToStream: (input) => opened.transport.reconnectToStream(input),
      }),
    })
    await chat.sendMessage({ text: 'Ask then pay' })
    expect(chat.error).toBeInstanceOf(ConnectionLost)
    chat.clearError()
    await chat.addToolOutput({ tool: 'ask', toolCallId: 'ask', output: 'yes' })
    if (second === 'work') {
      await visible.promise
      release.resolve()
    }
    await finished.promise
    expect(posts).toBe(2)
    expect(chat.status).toBe('ready')
    if (chat.lastMessage === undefined) throw new Error('Expected approval')
    const pay = chat.lastMessage.parts
      .filter(isToolUIPart)
      .find((part) => part.toolCallId === 'pay')
    if (pay === undefined) throw new Error('Expected real pay input')
    expect(pay.state).toBe(second === 'pay' ? 'approval-requested' : 'output-available')
    expect(pay.input).toEqual({ amount: 7 })
    expect(
      (await waiting(opened.harness, opened.root.id, context)).map((row) => row.callId),
    ).toEqual(second === 'pay' ? ['pay'] : [])
  },
)

/** S-stop: the SDK does not notify the transport when stop discards its private reader. Close
 * client-held streaming inputs before bodyless replay; no step or earlier result is seeded twice. */
it('closes stopped step-2 inputs before resuming the same Chat', async () => {
  const release = signal()
  const streaming = signal()
  const attached = signal()
  onTestFinished(() => release.resolve())
  let gated = false
  const fixture = await host(
    {
      one: tool({ inputSchema: z.object({}), execute: async () => 'r1' }),
      two: tool({ inputSchema: z.object({ input: z.string() }), execute: async () => 'r2' }),
    },
    {},
    { progress: { partialIntervalMs: 1 } },
    {
      partialFamily: 'anthropic',
      commitFrames: true,
      tokenSize: { min: 1, max: 1 },
      onFrame: (event, abortSignal) => {
        if (event.type !== 'toolcall_delta' || gated) return Effect.void
        const block = event.partial.content[event.contentIndex]
        if (block === undefined || block.type !== 'toolCall' || block.name !== 'two')
          return Effect.void
        if (!Predicate.isString(block.arguments.input) || block.arguments.input.length < 8)
          return Effect.void
        gated = true
        return waitForFrame(
          Effect.promise(() => release.promise),
          abortSignal,
        )
      },
    },
  )
  const opened = await fixture.open()
  opened.faux.setResponses([
    fauxAssistantMessage([{ type: 'text', text: 'S1.' }, fauxToolCall('one', {}, { id: 'one' })], {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage(
      [
        { type: 'text', text: 'S2.' },
        fauxToolCall('two', { input: 'abcdefghijklmnopqrstuvwxyz' }, { id: 'two' }),
      ],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('Done.'),
  ])
  const base = new DefaultChatTransport<UIMessage>({
    api: 'http://durable.test/chat',
    fetch: async (url, init) => {
      const request = new Request(url, init)
      const response = await respond(opened.harness, opened.root.id, request, context)
      if (response.body === null) return response
      return new Response(
        response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), {
          signal: request.signal,
        }),
        { headers: response.headers, status: response.status },
      )
    },
  })
  const finishes: boolean[] = []
  const chat = new PlainChat({
    transport: resumable({
      sendMessages: (input) => base.sendMessages(input),
      reconnectToStream: async (input) => {
        const stream = await base.reconnectToStream(input)
        attached.resolve()
        return stream
      },
    }),
    onFinish: ({ isAbort }) => {
      finishes.push(isAbort)
    },
    onMessage: (message) => {
      if (
        message.parts.some(
          (part) =>
            isToolUIPart(part) && part.toolCallId === 'two' && part.state === 'input-streaming',
        )
      )
        streaming.resolve()
    },
  })
  const sending = chat.sendMessage({ text: 'Start' })
  await streaming.promise
  await chat.stop()
  await sending
  expect(finishes).toEqual([true])
  chat.messages = closeInputs(chat.messages)
  const resuming = chat.resumeStream()
  await attached.promise
  release.resolve()
  await resuming
  expect(chat.status).toBe('ready')
  expect(chat.messages.filter((message) => message.role === 'assistant')).toHaveLength(1)
  if (chat.lastMessage === undefined) throw new Error('Expected resumed assistant')
  expect(texts(chat.lastMessage)).toEqual(['S1.', 'S2.', 'Done.'])
  expect(chat.lastMessage.parts.map((part) => part.type)).toEqual([
    'step-start',
    'text',
    'tool-one',
    'step-start',
    'text',
    'tool-two',
    'step-start',
    'text',
  ])
})
