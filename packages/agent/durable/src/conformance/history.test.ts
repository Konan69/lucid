import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import {
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
} from 'ai'
import { expect, it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import * as Core from '../core.ts'
import { PlainChat } from '../fixtures/chat.ts'
import { answer, history, streamRun } from '../main.ts'
import { call, consume, context, hold, shop, signal, texts } from './fixtures/host.ts'

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

// The first input's placement separates settled history from a multi-entry run still waiting.
it('loads settled messages then GET resumes the busy run without duplicating history', async () => {
  const fixture = await shop()
  const opened = await fixture.open()
  opened.faux.setResponses([fauxAssistantMessage('Old.')])
  const chat = new PlainChat({ transport: opened.transport })
  await chat.sendMessage({ text: 'Old' })
  opened.faux.setResponses([call('pay', { amount: 100 }, 'held')])
  await chat.sendMessage({ text: 'New' })
  const page = await history(opened.harness, opened.root.id, { limit: 10 }, context)
  expect(page.messages.map((message) => message.parts)).toEqual(
    chat.messages.slice(0, 2).map((message) => message.parts),
  )
  const fresh = new PlainChat({ transport: opened.transport })
  fresh.messages = page.messages
  await fresh.resumeStream()
  expect(fresh.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'assistant'])
  expect(
    Option.getOrThrow(Option.fromNullishOr(fresh.messages[2])).parts.find(isToolUIPart),
  ).toMatchObject({
    toolCallId: 'held',
    state: 'approval-requested',
  })
  expect(texts(Option.getOrThrow(Option.fromNullishOr(fresh.messages[1])))).toEqual(['Old.'])
})

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
