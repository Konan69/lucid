import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from 'vitest'
import { Effect, Option } from 'effect'
import { defineExtension, hook, LiveDoc, ToolTask, type TaskId } from '@earendil-works/pi-durable'
import { tool } from 'ai'
import { z } from 'zod'
import * as Pi from '../pi.ts'

import type { HoldId } from '../main.ts'
import {
  CallNotWaiting,
  attachRun,
  holdId as parseHoldId,
  answer,
  continueRun,
  decide,
  respond,
  streamRun,
  waiting,
} from '../main.ts'
import { call, consume, context, hold, host, modelText, shop, signal } from './fixtures/host.ts'

type Opened = Awaited<ReturnType<Awaited<ReturnType<typeof shop>>['open']>>

/** A finite initial response captures the actual durable approval id before the client decides. */
async function park(opened: Opened, requestId: string) {
  return consume(
    await streamRun(
      opened.harness,
      {
        conversationId: opened.root.id,
        content: 'Act',
        requestId,
      },
      context,
    ),
  )
}

/** Keep exactly the SDK approval wire shape, including its echoed task identity. */
function approvalBody(holdId: HoldId, messageId: string) {
  return JSON.stringify({
    messages: [
      {
        role: 'assistant',
        id: messageId,
        parts: [
          {
            type: 'tool-pay',
            toolCallId: 'reused',
            state: 'approval-responded',
            approval: { id: holdId, approved: true },
          },
        ],
      },
    ],
  })
}

/** A stale HTTP retry must not consume the hold that a successor tool task owns. */
it('replaying the identical approval POST leaves a same-run successor unpaid and waiting', async () => {
  const fixture = await shop()
  const opened = await fixture.open()
  const entered = signal()
  const release = signal()
  opened.faux.setResponses([
    call('pay', { amount: 100 }, 'reused'),
    async () => {
      entered.resolve()
      await release.promise
      return call('pay', { amount: 999 }, 'reused')
    },
    fauxAssistantMessage('Done.'),
  ])
  const first = await park(opened, 'retry')
  const firstHold = await hold(opened.harness, opened.root.id, 'reused')
  expect(first.chunks.find((chunk) => chunk.type === 'tool-approval-request')).toMatchObject({
    approvalId: firstHold,
  })
  const body = approvalBody(firstHold, first.message.id)
  const response = await respond(
    opened.harness,
    opened.root.id,
    new Request('http://durable.test/chat', { method: 'POST', body }),
    context,
  )
  expect(response.status).toBe(200)
  try {
    await entered.promise
    release.resolve()
    expect(await response.text()).toContain('tool-approval-request')
    const secondHold = await hold(opened.harness, opened.root.id, 'reused')
    expect(secondHold).not.toBe(firstHold)
    const repeated = await respond(
      opened.harness,
      opened.root.id,
      new Request('http://durable.test/chat', { method: 'POST', body }),
      context,
    )
    expect(repeated.status).toBe(200)
    if (repeated.body === null) throw new Error('Expected an observation stream')
    await repeated.body.cancel()
    expect(fixture.paid).toEqual([100])
    expect(await waiting(opened.harness, opened.root.id, context)).toMatchObject([
      { holdId: secondHold, callId: 'reused', input: { amount: 999 } },
    ])
    // A second tab changes its old decision; the first task keeps its first settlement.
    expect(
      await decide(
        opened.harness,
        opened.root.id,
        { holdId: firstHold, approved: false, reason: 'old tab' },
        context,
      ),
    ).toEqual({ kind: 'approved' })
    expect(fixture.paid).toEqual([100])
    await decide(opened.harness, opened.root.id, { holdId: secondHold, approved: false }, context)
    const final = await consume(
      await continueRun(
        opened.harness,
        opened.root.id,
        { messageId: first.message.id, known: new Set(['reused']) },
        context,
      ),
      first.message,
    )
    expect(final.chunks.some((chunk) => chunk.type === 'tool-output-denied')).toBe(true)
    expect(fixture.paid).toEqual([100])
  } finally {
    release.resolve()
  }
})

/** J6: a hook can leave a plain task pending, but possessing its task id never creates a hold. */
it('rejects a pending plain tool task used as a hold id', async () => {
  const entered = signal()
  const release = signal()
  let task = Option.none<TaskId>()
  const fixture = await host(
    { plain: tool({ inputSchema: z.object({}), execute: async () => 'done' }) },
    {},
  )
  const opened = await fixture.open([
    defineExtension({
      name: 'observe-plain',
      hooks: [
        hook(ToolTask, {
          beforeTool: (_call, api, callbackContext) =>
            Pi.runForPi(
              Effect.sync(() => {
                task = Option.some(api.taskId)
                entered.resolve()
              }).pipe(Effect.andThen(Effect.promise(() => release.promise)), Effect.as(undefined)),
              callbackContext.abortSignal,
            ),
        }),
      ],
    }),
  ])
  opened.faux.setResponses([call('plain', {}, 'plain'), fauxAssistantMessage('Done.')])
  const observing = consume(
    await streamRun(
      opened.harness,
      { conversationId: opened.root.id, content: 'Act', requestId: 'plain-task' },
      context,
    ),
  )
  try {
    await entered.promise
    const id = Option.getOrThrow(task)
    const live = await opened.harness.snapshot(LiveDoc, opened.root.id, context)
    if (live === undefined) throw new Error('Expected pending live task')
    expect(live.tools).toMatchObject([{ taskId: id, status: 'pending' }])
    expect(await waiting(opened.harness, opened.root.id, context)).toEqual([])
    await expect(
      decide(
        opened.harness,
        opened.root.id,
        { holdId: parseHoldId(`hold:${id}`), approved: true },
        context,
      ),
    ).rejects.toBeInstanceOf(CallNotWaiting)
    await expect(
      answer(
        opened.harness,
        opened.root.id,
        { holdId: parseHoldId(`hold:${id}`), output: 'wrong' },
        context,
      ),
    ).rejects.toBeInstanceOf(CallNotWaiting)
  } finally {
    release.resolve()
    await observing
  }
})

/** J6: snapshot presentation retains each generation's own result-task provenance for reused ids. */
it('replays reused call generations with their own approval ids', async () => {
  const fixture = await shop()
  const started = signal()
  let rounds = 0
  const opened = await fixture.open([
    defineExtension({
      name: 'observe-reused',
      hooks: [
        hook(ToolTask, {
          beforeTool: (_call, _api, callbackContext) =>
            Pi.runForPi(
              Effect.sync(() => {
                rounds++
                if (rounds === 2) started.resolve()
                return undefined
              }),
              callbackContext.abortSignal,
            ),
        }),
      ],
    }),
  ])
  opened.faux.setResponses([
    call('pay', { amount: 100 }, 'same'),
    call('pay', { amount: 999 }, 'same'),
    fauxAssistantMessage('Done.'),
  ])
  await park(opened, 'replay-generations')
  const first = await hold(opened.harness, opened.root.id, 'same')
  await decide(opened.harness, opened.root.id, { holdId: first, approved: false }, context)
  await started.promise
  const second = await hold(opened.harness, opened.root.id, 'same')
  expect(second).not.toBe(first)
  const attached = await attachRun(opened.harness, opened.root.id, context)
  if (attached.status !== 'running') throw new Error('Expected waiting second generation')
  const replayed = await consume(attached.stream)
  expect(replayed.chunks.filter((chunk) => chunk.type === 'tool-approval-request')).toEqual([
    { type: 'tool-approval-request', toolCallId: 'same', approvalId: first },
    { type: 'tool-approval-request', toolCallId: 'same', approvalId: second },
  ])
  expect(replayed.chunks.filter((chunk) => chunk.type === 'tool-approval-response')).toEqual([
    { type: 'tool-approval-response', approvalId: first, approved: false },
  ])
  expect(replayed.chunks.filter((chunk) => chunk.type === 'tool-output-denied')).toHaveLength(1)
  expect(fixture.paid).toEqual([])
})

/** Separate tasks with a reused call id must each admit their own late-answer submission. */
it('delivers the second late answer when a later run reuses the call id', async () => {
  const fixture = await shop()
  const opened = await fixture.open()
  const received: string[] = []
  opened.faux.setResponses([
    call('later', { question: 'First?' }, 'x'),
    fauxAssistantMessage('Asked first.'),
    (request) => {
      received.push(modelText(request.messages))
      return fauxAssistantMessage('First answered.')
    },
    call('later', { question: 'Second?' }, 'x'),
    fauxAssistantMessage('Asked second.'),
    (request) => {
      received.push(modelText(request.messages))
      return fauxAssistantMessage('Second answered.')
    },
  ])
  await park(opened, 'first-question')
  await opened.root.waitForIdle(context)
  const firstHold = await hold(opened.harness, opened.root.id, 'x')
  await answer(opened.harness, opened.root.id, { holdId: firstHold, output: 'savings' }, context)
  await opened.root.waitForIdle(context)
  await park(opened, 'second-question')
  await opened.root.waitForIdle(context)
  const secondHold = await hold(opened.harness, opened.root.id, 'x')
  expect(secondHold).not.toBe(firstHold)
  await answer(opened.harness, opened.root.id, { holdId: secondHold, output: 'checking' }, context)
  await opened.root.waitForIdle(context)
  expect(received).toHaveLength(2)
  expect(received[1]).toContain('[answer to later] checking')
  expect(await waiting(opened.harness, opened.root.id, context)).toEqual([])
  expect(
    (await opened.root.context(context)).entries.filter((entry) => entry.kind === 'pi.user'),
  ).toHaveLength(4)
})

/** An unanswered question is owned by its task, even while a payment reuses the same provider id. */
it('keeps a late question answerable after approving another task with the same call id', async () => {
  const fixture = await shop()
  const opened = await fixture.open()
  let delivered = ''
  opened.faux.setResponses([
    call('later', { question: 'Account?' }, 'x'),
    fauxAssistantMessage('Asked.'),
    call('pay', { amount: 100 }, 'x'),
    fauxAssistantMessage('Paid.'),
    (request) => {
      delivered = modelText(request.messages)
      return fauxAssistantMessage('Answered.')
    },
  ])
  await park(opened, 'question')
  await opened.root.waitForIdle(context)
  const question = await hold(opened.harness, opened.root.id, 'x')
  await park(opened, 'payment')
  const rows = await waiting(opened.harness, opened.root.id, context)
  const payment = rows.find((row) => row.kind === 'approval')
  if (payment === undefined) throw new Error('Expected payment hold')
  expect(rows).toHaveLength(2)
  await decide(opened.harness, opened.root.id, { holdId: payment.holdId, approved: true }, context)
  await opened.root.waitForIdle(context)
  expect(await waiting(opened.harness, opened.root.id, context)).toMatchObject([
    { holdId: question, kind: 'later' },
  ])
  await answer(opened.harness, opened.root.id, { holdId: question, output: 'savings' }, context)
  await opened.root.waitForIdle(context)
  expect(delivered).toContain('[answer to later] savings')
  expect(fixture.paid).toEqual([100])
})

/** Both unsettled and settled tasks reject the wrong interaction kind. */
it('never returns another hold kind settlement', async () => {
  const fixture = await shop()
  const opened = await fixture.open()
  opened.faux.setResponses([
    call('pay', { amount: 100 }, 'pay'),
    fauxAssistantMessage('Paid.'),
    call('ask', { question: 'Account?' }, 'ask'),
    fauxAssistantMessage('Answered.'),
  ])
  await park(opened, 'pay')
  const payment = await hold(opened.harness, opened.root.id, 'pay')
  await expect(
    answer(opened.harness, opened.root.id, { holdId: payment, output: 'wrong' }, context),
  ).rejects.toBeInstanceOf(CallNotWaiting)
  await decide(opened.harness, opened.root.id, { holdId: payment, approved: true }, context)
  await opened.root.waitForIdle(context)
  await expect(
    answer(opened.harness, opened.root.id, { holdId: payment, output: 'wrong' }, context),
  ).rejects.toBeInstanceOf(CallNotWaiting)
  await park(opened, 'ask')
  const question = await hold(opened.harness, opened.root.id, 'ask')
  await expect(
    decide(opened.harness, opened.root.id, { holdId: question, approved: true }, context),
  ).rejects.toBeInstanceOf(CallNotWaiting)
  await answer(opened.harness, opened.root.id, { holdId: question, output: 'savings' }, context)
  await opened.root.waitForIdle(context)
  await expect(
    decide(opened.harness, opened.root.id, { holdId: question, approved: true }, context),
  ).rejects.toBeInstanceOf(CallNotWaiting)
})

/** An old tab's changed decision and the new tab's decision refer to distinct durable invocations. */
it('two tabs cannot cross-settle generations of the same call id', async () => {
  const fixture = await shop()
  const opened = await fixture.open()
  opened.faux.setResponses([
    call('pay', { amount: 100 }, 'reused'),
    fauxAssistantMessage('First.'),
    call('pay', { amount: 999 }, 'reused'),
    fauxAssistantMessage('Second.'),
  ])
  await park(opened, 'tab-one')
  const oldHold = await hold(opened.harness, opened.root.id, 'reused')
  await decide(opened.harness, opened.root.id, { holdId: oldHold, approved: true }, context)
  await opened.root.waitForIdle(context)
  await park(opened, 'tab-two')
  const newHold = await hold(opened.harness, opened.root.id, 'reused')
  expect(
    await decide(opened.harness, opened.root.id, { holdId: oldHold, approved: false }, context),
  ).toEqual({ kind: 'approved' })
  expect(await waiting(opened.harness, opened.root.id, context)).toMatchObject([
    { holdId: newHold },
  ])
  expect(fixture.paid).toEqual([100])
  await decide(
    opened.harness,
    opened.root.id,
    { holdId: newHold, approved: false, reason: 'new tab' },
    context,
  )
  await opened.root.waitForIdle(context)
  expect(
    await decide(opened.harness, opened.root.id, { holdId: newHold, approved: true }, context),
  ).toEqual({ kind: 'denied', reason: 'new tab' })
  expect(fixture.paid).toEqual([100])
})

/** Missing or mismatched approval ids are skipped without invalidating the assistant turn. */
it.each(['missing', 'wrong-call', 'unknown-task'])('skips a %s approval identity', async (kind) => {
  const fixture = await shop()
  const opened = await fixture.open()
  // Separate rounds keep this focused on ownership, independent of Pi's duplicate-id guard.
  opened.faux.setResponses([call('pay', { amount: 100 }, 'reused')])
  const first = await park(opened, 'bad-identity')
  const holdId = await hold(opened.harness, opened.root.id, 'reused')
  const approval =
    kind === 'missing'
      ? { approved: true }
      : { id: kind === 'unknown-task' ? 'hold:99999999' : holdId, approved: true }
  const response = await respond(
    opened.harness,
    opened.root.id,
    new Request('http://durable.test/chat', {
      method: 'POST',
      body: JSON.stringify({
        messages: [
          {
            role: 'assistant',
            id: first.message.id,
            parts: [
              {
                type: 'tool-pay',
                toolCallId: kind === 'wrong-call' ? 'other' : 'reused',
                state: 'approval-responded',
                approval,
              },
              { type: 'tool-pay', toolCallId: 'reused' },
            ],
          },
        ],
      }),
    }),
    context,
  )
  expect(response.status).toBe(200)
  if (response.body === null) throw new Error('Expected observation stream')
  await response.body.cancel()
  expect(fixture.paid).toEqual([])
  expect(await waiting(opened.harness, opened.root.id, context)).toMatchObject([{ holdId }])
})

/** Compaction removes model-visible task provenance; the durable receipt still answers repeats. */
it('keeps the first decision after compaction removes the original call', async () => {
  const fixture = await shop({
    compaction: {
      enabled: false,
      reserveTokens: 1000,
      keepRecentTokens: 1,
      backgroundTokens: 0,
    },
  })
  const opened = await fixture.open()
  opened.faux.setResponses([
    call('pay', { amount: 100 }, 'old'),
    fauxAssistantMessage('Denied.'),
    fauxAssistantMessage('A long unrelated answer. '.repeat(30)),
    fauxAssistantMessage('Summary.'),
  ])
  await park(opened, 'original')
  const holdId = await hold(opened.harness, opened.root.id, 'old')
  await decide(
    opened.harness,
    opened.root.id,
    { holdId, approved: false, reason: 'original denial' },
    context,
  )
  await opened.root.waitForIdle(context)
  await park(opened, 'unrelated')
  await opened.root.waitForIdle(context)
  const task = await opened.root.compact(undefined, context)
  const result = await opened.harness.waitForTask(task, context)
  expect(result.state.outcome.status).toBe('completed')
  const entries = (await opened.root.context(context)).entries
  expect(
    entries.some((entry) =>
      (entry.model ?? []).some(
        (message) =>
          message.role === 'assistant' &&
          message.content.some((part) => part.type === 'toolCall' && part.id === 'old'),
      ),
    ),
  ).toBe(false)
  expect(await decide(opened.harness, opened.root.id, { holdId, approved: true }, context)).toEqual(
    {
      kind: 'denied',
      reason: 'original denial',
    },
  )
  expect(fixture.paid).toEqual([])
})
