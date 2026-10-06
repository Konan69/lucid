import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import {
  DefaultChatTransport,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
  tool,
  type UIMessage,
} from 'ai'
import { expect, it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import { z } from 'zod'
import * as Core from '../core.ts'
import { PlainChat } from '../fixtures/chat.ts'
import { answer, attachRun, decide, history, respond, streamRun } from '../main.ts'
import { call, consume, context, hold, host, shop, signal, texts } from './fixtures/host.ts'

/** Read approval identity exactly as a stock client does. */
function approval(chat: PlainChat) {
  if (chat.lastMessage === undefined) throw new Error('Expected assistant message')
  const part = chat.lastMessage.parts.find(isToolUIPart)
  if (part === undefined || part.state !== 'approval-requested')
    throw new Error('Expected approval')
  return part.approval.id
}

// Conversation.entries is raw and fork-aware; the SDK reader provides the same settled parts as Chat.
it.each(['text', 'approved', 'denied', 'answer', 'retry'] as const)(
  'history matches streamed %s parts',
  async (kind) => {
    const fixture = await shop()
    const opened = await fixture.open()
    switch (kind) {
      case 'text':
        opened.faux.setResponses([fauxAssistantMessage('Done.')])
        break
      case 'retry':
        opened.faux.setResponses([
          fauxAssistantMessage('Discard.', {
            stopReason: 'error',
            errorMessage: '503 Service Unavailable',
          }),
          fauxAssistantMessage('Done.'),
        ])
        break
      case 'answer':
        opened.faux.setResponses([
          call('ask', { question: 'Which?' }, 'held'),
          fauxAssistantMessage('Done.'),
        ])
        break
      case 'approved':
      case 'denied':
        opened.faux.setResponses([
          call('pay', { amount: 100 }, 'held'),
          fauxAssistantMessage('Done.'),
        ])
        break
    }
    let completion = signal()
    const chat = new PlainChat({
      transport: opened.transport,
      sendAutomaticallyWhen:
        kind === 'answer'
          ? lastAssistantMessageIsCompleteWithToolCalls
          : lastAssistantMessageIsCompleteWithApprovalResponses,
      onFinish: () => completion.resolve(),
      onError: (error) => completion.reject(error),
    })
    await chat.sendMessage({ text: 'Go' })
    if (kind === 'approved' || kind === 'denied' || kind === 'answer') {
      completion = signal()
      if (kind === 'answer')
        await chat.addToolOutput({ tool: 'ask', toolCallId: 'held', output: 'savings' })
      else await chat.addToolApprovalResponse({ id: approval(chat), approved: kind === 'approved' })
      await completion.promise
    }
    const page = await history(opened.harness, opened.root.id, { limit: 10 }, context)
    expect(page.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(page.messages.map((message) => message.parts)).toEqual(
      chat.messages.map((message) => message.parts),
    )
    expect(page.messages.every((message) => /^entry:[1-9][0-9]*$/u.test(message.id))).toBe(true)
    expect(await history(opened.harness, opened.root.id, { limit: 10 }, context)).toEqual(page)
    expect(page.next).toBeUndefined()
  },
)

// Entry-page size is 100: a 105-step assistant forces continuation before the message boundary.
it('pages on message boundaries across more than one raw entry page', async () => {
  const fixture = await shop()
  const opened = await fixture.open()
  opened.faux.setResponses([fauxAssistantMessage('First.')])
  await consume(
    await streamRun(
      opened.harness,
      { conversationId: opened.root.id, content: 'First', requestId: 'first' },
      context,
    ),
  )
  for (let index = 0; index < 105; index++)
    await opened.root.commit(
      (tx) =>
        tx.appendEntry(opened.root.id, {
          kind: 'pi.assistant',
          model: [fauxAssistantMessage(`Step ${index}`)],
        }),
      context,
    )
  const first = await history(opened.harness, opened.root.id, { limit: 1 }, context)
  expect(first.messages).toHaveLength(1)
  expect(texts(Option.getOrThrow(Option.fromNullishOr(first.messages[0])))).toHaveLength(106)
  if (first.next === undefined) throw new Error('Expected older user cursor')
  const second = await history(
    opened.harness,
    opened.root.id,
    { limit: 1, before: first.next },
    context,
  )
  expect(second.messages).toMatchObject([
    { role: 'user', parts: [{ type: 'text', text: 'First' }] },
  ])
  expect(second.next).toBeUndefined()
})

// Reload replaces partial SDK state; history owns users and GET owns the active assistant.
it('reloads a running tool through history and GET in message order without duplicates', async () => {
  const entered = signal()
  const release = signal()
  const attached = signal()
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
    { conversationId: opened.root.id, content: 'Build', requestId: 'reload' },
    context,
  )
  await entered.promise
  await original.cancel()
  const page = await history(opened.harness, opened.root.id, { limit: 10 }, context)
  expect(page.messages).toMatchObject([{ role: 'user', parts: [{ type: 'text', text: 'Build' }] }])
  expect(page.messages).toHaveLength(1)
  const fresh = new PlainChat({
    transport: new DefaultChatTransport<UIMessage>({
      api: 'http://durable.test/chat',
      fetch: async (url, init) => {
        const request = new Request(url, init)
        const response = await respond(opened.harness, opened.root.id, request, context)
        if (request.method === 'GET') attached.resolve()
        return response
      },
    }),
  })
  fresh.messages = page.messages
  const resumed = fresh.resumeStream()
  await attached.promise
  release.resolve()
  await resumed
  expect(fresh.status).toBe('ready')
  expect(fresh.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
  expect(fresh.messages[0]).toEqual(page.messages[0])
  const assistant = Option.getOrThrow(Option.fromNullishOr(fresh.lastMessage))
  expect(texts(assistant)).toEqual(['Starting.', 'Finished.'])
  expect(assistant.parts.filter(isToolUIPart)).toMatchObject([
    { toolCallId: 'work', state: 'output-available', output: '12 pages' },
  ])
  const settled = await history(opened.harness, opened.root.id, { limit: 10 }, context)
  expect(settled.messages.map((message) => message.parts)).toEqual(
    fresh.messages.map((message) => message.parts),
  )
})

// Even before a first assistant entry exists, the placed user input survives a reload.
it('includes the active input while the model has not produced an assistant entry', async () => {
  const fixture = await shop()
  const opened = await fixture.open()
  const entered = signal()
  const release = signal()
  opened.faux.setResponses([
    async () => {
      entered.resolve()
      await release.promise
      return fauxAssistantMessage('Done.')
    },
  ])
  const original = await streamRun(
    opened.harness,
    { conversationId: opened.root.id, content: 'New', requestId: 'generation' },
    context,
  )
  await entered.promise
  const page = await history(opened.harness, opened.root.id, { limit: 1 }, context)
  expect(page.messages).toMatchObject([{ role: 'user', parts: [{ type: 'text', text: 'New' }] }])
  expect(page.messages).toHaveLength(1)
  expect(page.next).toBeUndefined()
  // A raw user entry before the assistant also belongs in history, even without a run-input receipt.
  await opened.root.commit(
    (tx) =>
      tx.appendEntry(opened.root.id, {
        kind: 'pi.user',
        model: [{ role: 'user', content: 'One more input', timestamp: 0 }],
      }),
    context,
  )
  const newest = await history(opened.harness, opened.root.id, { limit: 1 }, context)
  expect(newest.messages).toMatchObject([
    { role: 'user', parts: [{ type: 'text', text: 'One more input' }] },
  ])
  expect(newest.messages).toHaveLength(1)
  if (newest.next === undefined) throw new Error('Expected the original input cursor')
  expect(
    await history(opened.harness, opened.root.id, { limit: 1, before: newest.next }, context),
  ).toEqual(page)
  release.resolve()
  await consume(original)
})

// A parked approval reconnect adds only the assistant; its user is already in the hydrated list.
it('reloads settled messages and the active user before GET resumes a parked approval', async () => {
  const fixture = await shop()
  const opened = await fixture.open()
  opened.faux.setResponses([fauxAssistantMessage('Old.')])
  const chat = new PlainChat({ transport: opened.transport })
  await chat.sendMessage({ text: 'Old' })
  opened.faux.setResponses([call('pay', { amount: 100 }, 'held')])
  await chat.sendMessage({ text: 'New' })
  const page = await history(opened.harness, opened.root.id, { limit: 10 }, context)
  expect(page.messages.map((message) => message.parts)).toEqual(
    chat.messages.slice(0, 3).map((message) => message.parts),
  )
  const fresh = new PlainChat({ transport: opened.transport })
  fresh.messages = page.messages
  await fresh.resumeStream()
  expect(fresh.messages.map((message) => message.role)).toEqual([
    'user',
    'assistant',
    'user',
    'assistant',
  ])
  expect(fresh.messages.map((message) => message.parts)).toEqual(
    chat.messages.map((message) => message.parts),
  )
  expect(
    Option.getOrThrow(Option.fromNullishOr(fresh.messages[3])).parts.find(isToolUIPart),
  ).toMatchObject({
    toolCallId: 'held',
    state: 'approval-requested',
  })
  expect(texts(Option.getOrThrow(Option.fromNullishOr(fresh.messages[1])))).toEqual(['Old.'])
  const newest = await history(opened.harness, opened.root.id, { limit: 1 }, context)
  expect(newest.messages).toEqual([page.messages[2]])
  if (newest.next === undefined) throw new Error('Expected previous message cursor')
  const previous = await history(
    opened.harness,
    opened.root.id,
    { limit: 1, before: newest.next },
    context,
  )
  expect(previous.messages).toEqual([page.messages[1]])
})

// Active prefixes spanning Pi's 100-entry pages must not leak steers before finding the first assistant.
it.each([1, 105])(
  'withholds %i placed steers until settlement and keeps the first input',
  async (count) => {
    const fixture = await shop({ steeringMode: 'all' })
    const opened = await fixture.open()
    opened.faux.setResponses([
      call('pay', { amount: 100 }, 'c1'),
      call('pay', { amount: 200 }, 'c2'),
      fauxAssistantMessage('Done.'),
    ])
    await consume(
      await streamRun(
        opened.harness,
        { conversationId: opened.root.id, content: 'Pay', requestId: 'first' },
        context,
      ),
    )
    for (let index = 0; index < count; index++)
      await opened.root.submit(
        {
          type: 'input',
          content: 'Also another payment',
          requestId: `steer:${index}`,
          whenBusy: 'steer',
        },
        context,
      )
    await decide(
      opened.harness,
      opened.root.id,
      { holdId: await hold(opened.harness, opened.root.id, 'c1'), approved: true },
      context,
    )
    const attached = await attachRun(opened.harness, opened.root.id, context)
    if (attached.status !== 'running') throw new Error('Expected the second approval run')
    await consume(attached.stream)
    const entries = await opened.root.entries({}, 100, undefined, context)
    expect(
      entries.items.some(
        (entry) =>
          entry.kind === 'pi.user' &&
          (entry.model ?? []).some(
            (message) => message.role === 'user' && message.content === 'Also another payment',
          ),
      ),
    ).toBe(true)
    const busy = await history(opened.harness, opened.root.id, { limit: 1 }, context)
    expect(busy.messages).toMatchObject([{ role: 'user', parts: [{ type: 'text', text: 'Pay' }] }])
    expect(busy.messages).toHaveLength(1)
    expect(busy.next).toBeUndefined()
    await decide(
      opened.harness,
      opened.root.id,
      { holdId: await hold(opened.harness, opened.root.id, 'c2'), approved: true },
      context,
    )
    await opened.root.waitForIdle(context)
    const settled = await history(opened.harness, opened.root.id, { limit: count + 3 }, context)
    expect(settled.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      ...Array.from({ length: count }, () => 'user'),
      'assistant',
    ])
    expect(settled.messages[2]).toMatchObject({
      parts: [{ type: 'text', text: 'Also another payment' }],
    })
    expect(fixture.paid).toEqual([100, 200])
  },
)

// Pi forks copy the raw prefix, while history cursors remain entry bounds independent of storage cursors.
it('reads a forked prefix and ignores control and application entries', async () => {
  const fixture = await shop()
  const opened = await fixture.open()
  opened.faux.setResponses([fauxAssistantMessage('Prefix.')])
  await consume(
    await streamRun(
      opened.harness,
      { conversationId: opened.root.id, content: 'Fork', requestId: 'fork' },
      context,
    ),
  )
  const entries = await opened.root.entries({}, 100, undefined, context)
  const assistant = entries.items.find((entry) => entry.kind === 'pi.assistant')
  if (assistant === undefined) throw new Error('Expected fork point')
  const fork = await opened.root.fork(assistant.id, { ownership: { kind: 'ownerless' } }, context)
  await fork.commit((tx) => tx.appendEntry(fork.id, { kind: 'application.note' }), context)
  const parent = await history(opened.harness, opened.root.id, { limit: 10 }, context)
  expect(await history(opened.harness, fork.id, { limit: 10 }, context)).toEqual(parent)
})

// Late-answer delivery is intentionally an ordinary user entry until a separate metadata contract exists.
it('keeps a late answer as an ordinary user message', async () => {
  const fixture = await shop()
  const opened = await fixture.open()
  opened.faux.setResponses([
    call('later', { question: 'Which?' }, 'x'),
    fauxAssistantMessage('Waiting.'),
    fauxAssistantMessage('Savings.'),
  ])
  await consume(
    await streamRun(
      opened.harness,
      { conversationId: opened.root.id, content: 'Ask', requestId: 'late' },
      context,
    ),
  )
  await answer(
    opened.harness,
    opened.root.id,
    { holdId: await hold(opened.harness, opened.root.id, 'x'), output: 'savings' },
    context,
  )
  await opened.root.waitForIdle(context)
  const page = await history(opened.harness, opened.root.id, { limit: 10 }, context)
  expect(page.messages.map((message) => message.role)).toEqual([
    'user',
    'assistant',
    'user',
    'assistant',
  ])
  expect(page.messages[2]).toMatchObject({
    parts: [{ type: 'text', text: '[answer to later] savings' }],
  })
  expect(Option.getOrThrow(Option.fromNullishOr(page.messages[2])).metadata).toBeUndefined()
})

/** The core pages the same real SQLite transcript using its branded cursor and Option contract. */
it.live('core pages the same settled messages as the Promise entry', () =>
  Effect.gen(function* () {
    const fixture = yield* Effect.promise(() => shop())
    const opened = yield* Effect.promise(() => fixture.open())
    opened.faux.setResponses([fauxAssistantMessage('Core.')])
    const stream = yield* Effect.promise(() =>
      streamRun(
        opened.harness,
        { conversationId: opened.root.id, content: 'Core', requestId: 'core-history' },
        context,
      ),
    )
    yield* Effect.promise(() => consume(stream))
    const first = yield* Core.history(
      opened.harness,
      opened.root.id,
      { limit: 1, before: Option.none() },
      context,
    )
    expect(first.messages).toMatchObject([
      { role: 'assistant', parts: [{ type: 'step-start' }, { type: 'text', text: 'Core.' }] },
    ])
    expect(Option.isSome(first.next)).toBe(true)
    const second = yield* Core.history(
      opened.harness,
      opened.root.id,
      { limit: 1, before: first.next },
      context,
    )
    expect(second.messages).toMatchObject([
      { role: 'user', parts: [{ type: 'text', text: 'Core' }] },
    ])
    expect(Option.isNone(second.next)).toBe(true)
  }),
)
