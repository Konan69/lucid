import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from '@effect/vitest'
import {
  DefaultChatTransport,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
  tool,
  type UIMessage,
} from 'ai'
import { z } from 'zod'
import { PlainChat } from '../fixtures/chat.ts'
import { answer, attachRun, history, respond, streamRun, waiting } from '../main.ts'
import { call, consume, context, hold, host, shop, signal, texts } from './fixtures/host.ts'

// Real generation partials expose the call before the trailing text, without waiting for a tool task.
it('keeps slow parallel content order identical in live Chat, attachment and history', async () => {
  const fixture = await host(
    {
      pay: tool({
        inputSchema: z.object({ amount: z.number() }),
        execute: async ({ amount }) => amount,
      }),
    },
    { approval: { pay: true } },
    { progress: { partialIntervalMs: 0 } },
    { commitFrames: true, tokenSize: { min: 1, max: 1 } },
  )
  const opened = await fixture.open()
  opened.faux.setResponses([
    fauxAssistantMessage(
      [
        fauxText('Before '.repeat(20)),
        fauxToolCall('pay', { amount: 100 }, { id: 'c1' }),
        fauxText('After '.repeat(20)),
      ],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('Done.'),
  ])
  let completion = signal()
  const chat = new PlainChat({
    transport: opened.transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onFinish: () => completion.resolve(),
    onError: (error) => completion.reject(error),
  })
  await chat.sendMessage({ text: 'Pay' })
  if (chat.lastMessage === undefined) throw new Error('Expected assistant')
  expect(chat.lastMessage.parts.map((part) => part.type)).toEqual([
    'step-start',
    'text',
    'tool-pay',
    'text',
  ])
  // The terminal entry must supply any suffix omitted by Pi's throttled last partial commit.
  expect(texts(chat.lastMessage)).toEqual(['Before '.repeat(20), 'After '.repeat(20)])
  const attached = await attachRun(opened.harness, opened.root.id, context)
  if (attached.status !== 'running') throw new Error('Expected parked run')
  expect((await consume(attached.stream)).message.parts).toEqual(chat.lastMessage.parts)
  const part = chat.lastMessage.parts.find(isToolUIPart)
  if (part === undefined || part.state !== 'approval-requested')
    throw new Error('Expected approval')
  completion = signal()
  await chat.addToolApprovalResponse({ id: part.approval.id, approved: true })
  await completion.promise
  await opened.root.waitForIdle(context)
  const page = await history(opened.harness, opened.root.id, { limit: 10 }, context)
  expect(page.messages.map((message) => message.parts)).toEqual(
    chat.messages.map((message) => message.parts),
  )
})

// A stock automatic-send predicate must not re-POST an old call against a successor run with the same id.
it('posts a stale output once and restores its own finished run while the successor waits', async () => {
  const fixture = await shop()
  const opened = await fixture.open()
  opened.faux.setResponses([
    call('ask', { question: 'First?' }, 'x'),
    fauxAssistantMessage('First finished.'),
    call('ask', { question: 'Second?' }, 'x'),
  ])
  let posts = 0
  let completed = signal()
  const tab = new PlainChat({
    transport: new DefaultChatTransport<UIMessage>({
      api: 'http://durable.test/chat',
      fetch: async (url, init) => {
        const request = new Request(url, init)
        if (request.method === 'POST') posts++
        if (posts > 2) throw new Error('Stale resume posted more than once')
        return respond(opened.harness, opened.root.id, request, context)
      },
    }),
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    onFinish: () => completed.resolve(),
    onError: (error) => completed.reject(error),
  })
  await tab.sendMessage({ text: 'First' })
  await answer(
    opened.harness,
    opened.root.id,
    { holdId: await hold(opened.harness, opened.root.id, 'x'), output: 'Elsewhere' },
    context,
  )
  await opened.root.waitForIdle(context)
  await consume(
    await streamRun(
      opened.harness,
      { conversationId: opened.root.id, content: 'Second', requestId: 'second' },
      context,
    ),
  )
  const held = await waiting(opened.harness, opened.root.id, context)
  completed = signal()
  await tab.addToolOutput({ tool: 'ask', toolCallId: 'x', output: 'Stale' })
  await completed.promise
  expect(posts).toBe(2)
  expect(tab.status).toBe('ready')
  if (tab.lastMessage === undefined) throw new Error('Expected finished first run')
  expect(texts(tab.lastMessage)).toEqual(['First finished.'])
  expect(tab.lastMessage.parts.find(isToolUIPart)).toMatchObject({ output: 'Elsewhere' })
  expect(await waiting(opened.harness, opened.root.id, context)).toEqual(held)
})

/** A placed steer extends the located run: the stock predicate must see its still-waiting later call. */
it('continues past a steer without repeatedly posting an already answered call', async () => {
  const fixture = await shop({ steeringMode: 'all' })
  const opened = await fixture.open()
  opened.faux.setResponses([
    call('ask', { question: 'First?' }, 'x'),
    call('ask', { question: 'After steer?' }, 'y'),
    fauxAssistantMessage('Finished after steer.'),
  ])
  let posts = 0
  let allowedPosts = 2
  let completed = signal()
  const tab = new PlainChat({
    transport: new DefaultChatTransport<UIMessage>({
      api: 'http://durable.test/chat',
      fetch: async (url, init) => {
        const request = new Request(url, init)
        if (request.method === 'POST') posts++
        if (posts > allowedPosts) throw new Error('Steer resume posted more than once')
        return respond(opened.harness, opened.root.id, request, context)
      },
    }),
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    onFinish: () => completed.resolve(),
    onError: (error) => completed.reject(error),
  })
  await tab.sendMessage({ text: 'First' })
  await opened.root.submit(
    {
      type: 'input',
      content: 'Steer this same run',
      requestId: 'steer',
      whenBusy: 'steer',
    },
    context,
  )
  await answer(
    opened.harness,
    opened.root.id,
    { holdId: await hold(opened.harness, opened.root.id, 'x'), output: 'Elsewhere' },
    context,
  )
  const attached = await attachRun(opened.harness, opened.root.id, context)
  if (attached.status !== 'running') throw new Error('Expected steer-extended run')
  await consume(attached.stream)
  const held = await waiting(opened.harness, opened.root.id, context)
  expect(held.map((row) => row.callId)).toEqual(['y'])
  completed = signal()
  await tab.addToolOutput({ tool: 'ask', toolCallId: 'x', output: 'Stale' })
  await completed.promise
  expect(posts).toBe(2)
  expect(tab.status).toBe('ready')
  expect(tab.messages.filter((message) => message.role === 'assistant')).toHaveLength(1)
  if (tab.lastMessage === undefined) throw new Error('Expected extended assistant')
  expect(tab.lastMessage.parts.filter(isToolUIPart)).toMatchObject([
    { toolCallId: 'x', state: 'output-available', output: 'Elsewhere' },
    { toolCallId: 'y', state: 'input-available' },
  ])
  expect(await waiting(opened.harness, opened.root.id, context)).toEqual(held)
  allowedPosts = 3
  completed = signal()
  await tab.addToolOutput({ tool: 'ask', toolCallId: 'y', output: 'Now' })
  await completed.promise
  expect(posts).toBe(3)
  expect(tab.status).toBe('ready')
  expect(texts(tab.lastMessage)).toEqual(['Finished after steer.'])
  expect(await waiting(opened.harness, opened.root.id, context)).toEqual([])
})
