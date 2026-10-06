import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from '@effect/vitest'
import {
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  tool,
  type UIMessage,
} from 'ai'
import { Effect } from 'effect'
import { LiveDoc } from '@earendil-works/pi-durable'
import { z } from 'zod'

import { PlainChat } from '../fixtures/chat.ts'
import { history, streamRun } from '../main.ts'
import { consume, context, host, signal } from './fixtures/host.ts'

/** Compare provider blocks rather than step markers or transport-specific message identities. */
function order(message: UIMessage) {
  return message.parts.flatMap((part) => {
    if (part.type === 'text') return [`text:${part.text}`]
    if (isToolUIPart(part)) return [`call:${part.toolCallId}`]
    return []
  })
}

/** Use the part's approval id, exactly as an application using the stock SDK does. */
function approval(chat: PlainChat) {
  if (chat.lastMessage === undefined) throw new Error('Expected assistant message')
  const part = chat.lastMessage.parts.find(
    (candidate) => isToolUIPart(candidate) && candidate.state === 'approval-requested',
  )

  if (part === undefined || !isToolUIPart(part) || part.state !== 'approval-requested')
    throw new Error('Expected approval')
  return part.approval.id
}

/**
 * Pi 1.0.4 generation.js startToolRound persists provider content order, while finishToolRound
 * deletes live.tools. Neither the assistant entry nor tool results retain when a reader saw a
 * withheld input. An early attachment follows live admission order; settled history cannot
 * reproduce that observer order. Preserve this documented difference instead of claiming parity.
 */
for (const path of ['live', 'attach'] as const)
  it.live(`records the sequential ${path} versus settled-history ordering limit`, () =>
    Effect.promise(async () => {
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
        { execution: 'sequential', approval: { pay: true } },
        { toolExecution: 'sequential' },
      )
      const opened = await fixture.open()
      opened.faux.setResponses([
        fauxAssistantMessage(
          [
            fauxText('Before.'),
            fauxToolCall('pay', { amount: 1 }, { id: 'c1' }),
            fauxToolCall('pay', { amount: 2 }, { id: 'c2' }),
            fauxText('After.'),
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
      if (path === 'live') await chat.sendMessage({ text: 'Pay' })
      else {
        await consume(
          await streamRun(
            opened.harness,
            { conversationId: opened.root.id, content: 'Pay', requestId: 'order' },
            context,
          ),
        )
        await chat.resumeStream()
      }
      if (chat.lastMessage === undefined) throw new Error('Expected assistant message')
      expect(order(chat.lastMessage)).toEqual(['text:Before.', 'call:c1', 'text:After.'])
      for (const amount of [1, 2]) {
        completion = signal()
        await chat.addToolApprovalResponse({ id: approval(chat), approved: true })
        await completion.promise
        expect(paid).toEqual(amount === 1 ? [1] : [1, 2])
      }
      expect(chat.status).toBe('ready')
      expect(chat.messages.filter((message) => message.role === 'assistant')).toHaveLength(1)
      expect(order(chat.lastMessage)).toEqual([
        'text:Before.',
        'call:c1',
        'text:After.',
        'call:c2',
        'text:Done.',
      ])
      const page = await history(opened.harness, opened.root.id, { limit: 10 }, context)
      const assistant = page.messages.find((message) => message.role === 'assistant')
      if (assistant === undefined) throw new Error('Expected historical assistant')
      expect(order(assistant)).toEqual([
        'text:Before.',
        'call:c1',
        'call:c2',
        'text:After.',
        'text:Done.',
      ])
    }),
  )

/** An unused sequential registration conservatively withholds c2 even though Pi executes this round in parallel. */
it.live('records the ordering limit for a parallel round of a sequential-capable agent', () =>
  Effect.promise(async () => {
    const paid: number[] = []
    const payment = tool({
      inputSchema: z.object({ amount: z.number() }),
      execute: async ({ amount }) => {
        paid.push(amount)
        return amount
      },
    })
    const fixture = await host(
      { pay: payment, slow: payment },
      { execution: 'parallel', sequential: ['slow'], approval: { pay: true } },
      { toolExecution: 'parallel', progress: { partialIntervalMs: 1 } },
      { tokensPerSecond: 1500, tokenSize: { min: 1, max: 1 } },
    )
    const opened = await fixture.open()
    const before = 'Before '.repeat(20)
    const after = 'After '.repeat(20)
    opened.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxText(before),
          fauxToolCall('pay', { amount: 1 }, { id: 'c1' }),
          fauxToolCall('pay', { amount: 2 }, { id: 'c2' }),
          fauxText(after),
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
    expect(order(chat.lastMessage)).toEqual([
      `text:${before}`,
      'call:c1',
      `text:${after}`,
      'call:c2',
    ])
    const live = await opened.harness.snapshot(LiveDoc, opened.root.id, context)
    if (live === undefined || live.tools === undefined) throw new Error('Expected tool round')
    expect(live.tools).toHaveLength(2)
    expect(live.tools.every((slot) => slot.taskId !== undefined)).toBe(true)
    completion = signal()
    await chat.addToolApprovalResponse({ id: approval(chat), approved: true })
    await chat.addToolApprovalResponse({ id: approval(chat), approved: true })
    await completion.promise
    expect(paid.toSorted((left, right) => left - right)).toEqual([1, 2])
    expect(order(chat.lastMessage)).toEqual([
      `text:${before}`,
      'call:c1',
      `text:${after}`,
      'call:c2',
      'text:Done.',
    ])
    const page = await history(opened.harness, opened.root.id, { limit: 10 }, context)
    const assistant = page.messages.find((message) => message.role === 'assistant')
    if (assistant === undefined) throw new Error('Expected historical assistant')
    expect(order(assistant)).toEqual([
      `text:${before}`,
      'call:c1',
      'call:c2',
      `text:${after}`,
      'text:Done.',
    ])
  }),
)
