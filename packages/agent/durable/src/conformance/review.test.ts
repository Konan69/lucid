import { HoldId } from '../core.ts'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { tool } from 'ai'
import { expect, it } from 'vitest'
import { z } from 'zod'

import { CallNotWaiting, continueRun, decide, respond, streamRun, waiting } from '../main.ts'
import { hold, call, consume, context, host, modelText, shop, signal } from './fixtures/host.ts'

// Review dup.test.ts: Pi generation.startToolRound accepts duplicate ids but public decisions cannot distinguish them.
it('blocks every duplicate id in a round without requesting approval or paying', async () => {
  const fixture = await shop()
  const opened = await fixture.open()
  let reason = ''
  opened.faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall('pay', { amount: 1 }, { id: 'dup' }),
        fauxToolCall('pay', { amount: 999 }, { id: 'dup' }),
      ],
      { stopReason: 'toolUse' },
    ),
    (request) => {
      reason = modelText(request.messages)
      return fauxAssistantMessage('Blocked.')
    },
  ])
  const result = await consume(
    await streamRun(
      opened.harness,
      {
        conversationId: opened.root.id,
        content: 'Pay',
        requestId: 'duplicate',
      },
      context,
    ),
  )
  expect(result.chunks.filter((chunk) => chunk.type === 'tool-approval-request')).toEqual([])
  expect(await waiting(opened.harness, opened.root.id, context)).toEqual([])
  await expect(
    decide(
      opened.harness,
      opened.root.id,
      { holdId: HoldId.make('hold:99999999'), approved: true },
      context,
    ),
  ).rejects.toBeInstanceOf(CallNotWaiting)
  await opened.root.waitForIdle(context)
  expect(reason).toContain('duplicate tool call id')
  expect(fixture.paid).toEqual([])
})

// Review probe.test.ts E: a completed unrelated task must retain its actual error, not an older denial.
it('does not apply a stale denial to a failing unheld task with the same id', async () => {
  const fixture = await host(
    {
      pay: tool({ inputSchema: z.object({}), execute: async () => 'paid' }),
      boom: tool({
        inputSchema: z.object({}),
        execute: async (): Promise<string> => {
          throw new Error('exploded')
        },
      }),
    },
    { approval: { pay: true } },
  )
  const opened = await fixture.open()
  opened.faux.setResponses([
    call('pay', {}, 'same'),
    fauxAssistantMessage('Denied.'),
    call('boom', {}, 'same'),
    fauxAssistantMessage('Failed.'),
  ])
  await consume(
    await streamRun(
      opened.harness,
      {
        conversationId: opened.root.id,
        content: 'Pay',
        requestId: 'denied',
      },
      context,
    ),
  )
  await decide(
    opened.harness,
    opened.root.id,
    { holdId: await hold(opened.harness, opened.root.id, 'same'), approved: false, reason: 'no' },
    context,
  )
  await opened.root.waitForIdle(context)
  const result = await consume(
    await streamRun(
      opened.harness,
      {
        conversationId: opened.root.id,
        content: 'Fail',
        requestId: 'failed',
      },
      context,
    ),
  )
  expect(result.chunks.filter((chunk) => chunk.type === 'tool-output-denied')).toEqual([])
  expect(result.chunks.find((chunk) => chunk.type === 'tool-output-error')).toMatchObject({
    toolCallId: 'same',
    errorText: expect.stringContaining('exploded'),
  })
  const entries = (await opened.root.context(context)).entries
  const resultEntry = entries.findLast((entry) =>
    (entry.model ?? []).some(
      (message) => message.role === 'toolResult' && message.toolCallId === 'same',
    ),
  )
  const failedTask = resultEntry === undefined ? undefined : resultEntry.byTaskId
  if (failedTask === undefined) throw new Error('Expected failed task provenance')
  await expect(
    decide(
      opened.harness,
      opened.root.id,
      { holdId: HoldId.make(`hold:${failedTask}`), approved: true },
      context,
    ),
  ).rejects.toBeInstanceOf(CallNotWaiting)
})

// Review probe.test.ts B: streamed input exists before its new tool task; historical approvals never apply.
it('requests a fresh approval for a reused id in a later run with streamed partial input', async () => {
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
    {},
    { tokensPerSecond: 60 },
  )
  const opened = await fixture.open()
  opened.faux.setResponses([
    call('pay', { amount: 100 }, 'reused'),
    fauxAssistantMessage('First paid.'),
    fauxAssistantMessage(
      [
        fauxToolCall('pay', { amount: 200 }, { id: 'reused' }),
        { type: 'text', text: 'word '.repeat(60) },
      ],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('Second denied.'),
  ])
  await consume(
    await streamRun(
      opened.harness,
      {
        conversationId: opened.root.id,
        content: 'Pay',
        requestId: 'first',
      },
      context,
    ),
  )
  await decide(
    opened.harness,
    opened.root.id,
    { holdId: await hold(opened.harness, opened.root.id, 'reused'), approved: true },
    context,
  )
  await opened.root.waitForIdle(context)
  const result = await consume(
    await streamRun(
      opened.harness,
      {
        conversationId: opened.root.id,
        content: 'Again',
        requestId: 'second',
      },
      context,
    ),
  )
  expect(result.chunks.filter((chunk) => chunk.type === 'tool-approval-response')).toEqual([])
  expect(result.chunks.filter((chunk) => chunk.type === 'tool-approval-request')).toHaveLength(1)
  expect(await waiting(opened.harness, opened.root.id, context)).toMatchObject([
    { callId: 'reused', input: { amount: 200 } },
  ])
  expect(paid).toEqual([100])
  await decide(
    opened.harness,
    opened.root.id,
    { holdId: await hold(opened.harness, opened.root.id, 'reused'), approved: false },
    context,
  )
  await opened.root.waitForIdle(context)
  expect(paid).toEqual([100])
})

// Review probe.test.ts F: the next round of one run has its own task even when its call id is reused.
it('requires a fresh decision when a later round of the same run reuses an id', async () => {
  const fixture = await shop()
  const opened = await fixture.open()
  const entered = signal()
  const release = signal()
  opened.faux.setResponses([
    call('pay', { amount: 100 }, 'reused'),
    async () => {
      entered.resolve()
      await release.promise
      return call('pay', { amount: 200 }, 'reused')
    },
    fauxAssistantMessage('Resolved.'),
  ])
  const first = await consume(
    await streamRun(
      opened.harness,
      {
        conversationId: opened.root.id,
        content: 'Pay',
        requestId: 'rounds',
      },
      context,
    ),
  )
  await decide(
    opened.harness,
    opened.root.id,
    { holdId: await hold(opened.harness, opened.root.id, 'reused'), approved: true },
    context,
  )
  try {
    await entered.promise
    const stream = await continueRun(opened.harness, opened.root.id, new Set(['reused']), context)
    release.resolve()
    const result = await consume(stream, first.message)
    expect(result.chunks.filter((chunk) => chunk.type === 'tool-approval-request')).toMatchObject([
      { toolCallId: 'reused' },
    ])
    expect(await waiting(opened.harness, opened.root.id, context)).toMatchObject([
      { callId: 'reused', input: { amount: 200 } },
    ])
    expect(fixture.paid).toEqual([100])
    await decide(
      opened.harness,
      opened.root.id,
      { holdId: await hold(opened.harness, opened.root.id, 'reused'), approved: false },
      context,
    )
    await opened.root.waitForIdle(context)
    expect(fixture.paid).toEqual([100])
  } finally {
    release.resolve()
  }
})

// Review probe.test.ts A: an unstarted sequential slot is not approvable even if the POST names it.
// This explicitly driven HTTP test does not claim the stock automatic predicate can initiate the POST.
it('ignores an unstarted sequential decision instead of rejecting the resume', async () => {
  const paid: number[] = []
  const executed = signal()
  const fixture = await host(
    {
      pay: tool({
        inputSchema: z.object({ amount: z.number() }),
        execute: async ({ amount }) => {
          paid.push(amount)
          executed.resolve()
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
  const first = await consume(
    await streamRun(
      opened.harness,
      {
        conversationId: opened.root.id,
        content: 'Pay',
        requestId: 'sequential',
      },
      context,
    ),
  )
  expect(first.chunks.filter((chunk) => chunk.type === 'tool-approval-request')).toMatchObject([
    { toolCallId: 'c1' },
  ])
  expect(await waiting(opened.harness, opened.root.id, context)).toMatchObject([{ callId: 'c1' }])
  const firstHold = await hold(opened.harness, opened.root.id, 'c1')
  const body = {
    messages: [
      {
        role: 'assistant',
        parts: ['c1', 'c2'].map((id) => ({
          type: 'tool-pay',
          toolCallId: id,
          state: 'approval-responded',
          approval: { id: id === 'c1' ? firstHold : HoldId.make('hold:99999999'), approved: true },
        })),
      },
    ],
  }
  const response = await respond(
    opened.harness,
    opened.root.id,
    new Request('http://durable.test/chat', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    context,
  )
  expect(response.status).toBe(200)
  if (response.body === null) throw new Error('Expected the second approval response')
  // B stops at Pi's source-proven missing task-admission event. Detach the response instead of claiming
  // a second automatic round trip; Pi keeps c2 held until cleanup cancels the isolated harness.
  await response.body.cancel()
  await executed.promise
  expect(paid).toEqual([1])
})
