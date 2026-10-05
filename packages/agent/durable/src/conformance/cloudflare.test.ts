import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from 'vitest'

import { answer, continueRun, decide, streamRun, waiting } from '../main.ts'
import { call, consume, context, modelText, shop, signal, texts } from './fixtures/host.ts'

/** Run through the public stream until a complete tool round parks for a person. */
async function park(opened: Awaited<ReturnType<Awaited<ReturnType<typeof shop>>['open']>>) {
  return consume(
    await streamRun(
      opened.harness,
      { conversationId: opened.root.id, content: 'Pay', requestId: 'pay' },
      context,
    ),
  )
}

// Cloudflare packages/think/src/tests/actions-durable-pause.test.ts: runs the action exactly once on approve and clears the pending row.
it('approval runs the tool once and clears its hold', async () => {
  const fixture = await shop()
  const opened = await fixture.open()
  opened.faux.setResponses([call('pay', { amount: 500 }, 'pay'), fauxAssistantMessage('Paid.')])
  const parked = await park(opened)
  expect(fixture.paid).toEqual([])
  expect(await waiting(opened.harness, opened.root.id, context)).toEqual([
    { kind: 'approval', callId: 'pay', toolName: 'pay', input: { amount: 500 } },
  ])
  await decide(opened.harness, opened.root.id, { callId: 'pay', approved: true }, context)
  const stream = await continueRun(opened.harness, opened.root.id, new Set(['pay']), context)
  if (stream === undefined) throw new Error('Expected the held run')
  const result = await consume(stream, parked.message)
  expect(fixture.paid).toEqual([500])
  expect(result.message.parts.find((part) => part.type === 'tool-pay')).toMatchObject({
    state: 'output-available',
    output: { receipt: 500 },
  })
  expect(texts(result.message)).toEqual(['Paid.'])
  expect(await waiting(opened.harness, opened.root.id, context)).toEqual([])
})

// Cloudflare packages/think/src/tests/actions-durable-pause.test.ts: rejects without running the action and clears the pending row.
// Cloudflare packages/think/src/tests/execute-hitl.test.ts: reject applies a rejected output with the reason and continues.
it('denial never executes and gives the model the reason', async () => {
  const fixture = await shop()
  const opened = await fixture.open()
  let prompt = ''
  opened.faux.setResponses([
    call('pay', { amount: 500 }, 'pay'),
    (request) => {
      prompt = modelText(request.messages)
      return fauxAssistantMessage('Denied.')
    },
  ])
  const parked = await park(opened)
  await decide(
    opened.harness,
    opened.root.id,
    { callId: 'pay', approved: false, reason: 'Budget exceeded' },
    context,
  )
  const stream = await continueRun(opened.harness, opened.root.id, new Set(['pay']), context)
  if (stream === undefined) throw new Error('Expected the held run')
  const result = await consume(stream, parked.message)
  expect(fixture.paid).toEqual([])
  expect(prompt).toContain('Budget exceeded')
  expect(result.message.parts.find((part) => part.type === 'tool-pay')).toMatchObject({
    state: 'output-denied',
  })
  expect(await waiting(opened.harness, opened.root.id, context)).toEqual([])
})

// Cloudflare packages/think/src/tests/actions-durable-pause.test.ts: attaches the descriptor to the paused part and continues with no open connection on approve.
it('a decision with no client attached completes the durable run', async () => {
  const fixture = await shop()
  const opened = await fixture.open()
  opened.faux.setResponses([
    call('pay', { amount: 500 }, 'pay'),
    fauxAssistantMessage('Detached completion.'),
  ])
  await park(opened)
  // The stream has ended; deciding must drive the run without continueRun or another HTTP request.
  await decide(opened.harness, opened.root.id, { callId: 'pay', approved: true }, context)
  await opened.root.waitForIdle(context)
  expect(fixture.paid).toEqual([500])
  expect(
    modelText(
      (await opened.root.context(context)).entries.flatMap((entry) =>
        entry.model === undefined ? [] : entry.model,
      ),
    ),
  ).toContain('Detached completion.')
  expect(await waiting(opened.harness, opened.root.id, context)).toEqual([])
})

// Cloudflare packages/think/src/tests/actions-durable-pause.test.ts: does not double-execute across a duplicate approve when idempotency-keyed.
// Gap: a repeated decision returns an overlay proxy that has already been settled by Pi.
it.fails('repeated decisions return the first settlement and execute once', async () => {
  const fixture = await shop()
  const opened = await fixture.open()
  opened.faux.setResponses([call('pay', { amount: 500 }, 'pay'), fauxAssistantMessage('Once.')])
  await park(opened)
  const decision = { callId: 'pay', approved: true }
  expect(await decide(opened.harness, opened.root.id, decision, context)).toEqual({
    kind: 'approved',
  })
  const repeated = await decide(opened.harness, opened.root.id, decision, context)
  const conflicting = await decide(
    opened.harness,
    opened.root.id,
    { callId: 'pay', approved: false, reason: 'Late denial' },
    context,
  )
  await opened.root.waitForIdle(context)
  expect(fixture.paid).toEqual([500])
  expect(repeated).toEqual({ kind: 'approved' })
  expect(conflicting).toEqual({ kind: 'approved' })
})

// Cloudflare packages/think/src/tests/actions-durable-pause.test.ts: picks a single winner under concurrent approves.
// Gap: the losing concurrent decision returns an unusable settled overlay instead of a detached value.
it.fails('concurrent decisions return usable settlements and execute once', async () => {
  const fixture = await shop()
  const opened = await fixture.open()
  opened.faux.setResponses([call('pay', { amount: 500 }, 'pay'), fauxAssistantMessage('Once.')])
  await park(opened)
  const decision = { callId: 'pay', approved: true }
  const results = await Promise.all([
    decide(opened.harness, opened.root.id, decision, context),
    decide(opened.harness, opened.root.id, decision, context),
  ])
  await opened.root.waitForIdle(context)
  expect(fixture.paid).toEqual([500])
  expect(results).toEqual([{ kind: 'approved' }, { kind: 'approved' }])
})

// Cloudflare packages/think/src/tests/execute-hitl.test.ts: approveExecution works after the in-memory handle is lost (DO restart path).
it('a decision after restart settles the original hold', async () => {
  const fixture = await shop()
  const before = await fixture.open()
  before.faux.setResponses([call('pay', { amount: 500 }, 'pay')])
  await park(before)
  await fixture.close(before.harness)
  const after = await fixture.open()
  after.faux.setResponses([fauxAssistantMessage('Restarted completion.')])
  expect(await waiting(after.harness, after.root.id, context)).toMatchObject([
    { callId: 'pay', kind: 'approval' },
  ])
  await decide(after.harness, after.root.id, { callId: 'pay', approved: true }, context)
  await after.root.waitForIdle(context)
  expect(fixture.paid).toEqual([500])
  expect(await waiting(after.harness, after.root.id, context)).toEqual([])
  expect(
    modelText(
      (await after.root.context(context)).entries.flatMap((entry) =>
        entry.model === undefined ? [] : entry.model,
      ),
    ),
  ).toContain('Restarted completion.')
})

// Cloudflare packages/think/src/tests/execute-hitl.test.ts: supports concurrent paused executions — one approval card per part.
it('two holds in one round settle independently', async () => {
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
    fauxAssistantMessage('Both resolved.'),
  ])
  const parked = await park(opened)
  expect(await waiting(opened.harness, opened.root.id, context)).toHaveLength(2)
  expect(parked.message.parts.filter((part) => part.type === 'tool-pay')).toHaveLength(2)
  await decide(opened.harness, opened.root.id, { callId: 'one', approved: true }, context)
  expect(await waiting(opened.harness, opened.root.id, context)).toMatchObject([
    { callId: 'two', kind: 'approval' },
  ])
  await decide(
    opened.harness,
    opened.root.id,
    { callId: 'two', approved: false, reason: 'Only one' },
    context,
  )
  const stream = await continueRun(opened.harness, opened.root.id, new Set(['one', 'two']), context)
  if (stream === undefined) throw new Error('Expected the held run')
  const result = await consume(stream, parked.message)
  expect(fixture.paid).toEqual([100])
  expect(
    result.message.parts.find((part) => 'toolCallId' in part && part.toolCallId === 'one'),
  ).toMatchObject({ state: 'output-available' })
  expect(
    result.message.parts.find((part) => 'toolCallId' in part && part.toolCallId === 'two'),
  ).toMatchObject({ state: 'output-denied' })
  expect(texts(result.message)).toEqual(['Both resolved.'])
})

// Cloudflare packages/think/src/tests/execute-hitl.test.ts: double-approve is graceful: the second returns an error and leaves the transcript alone.
// Adapt stale/non-pending interaction validation to the package's person-answered tool API.
// Gap: answer accepts a call that is not waiting and persists an unsolicited settlement.
it.fails('rejects an answer for a call that is not waiting', async () => {
  const fixture = await shop()
  const opened = await fixture.open()
  expect(await waiting(opened.harness, opened.root.id, context)).toEqual([])
  await expect(
    answer(
      opened.harness,
      opened.root.id,
      { callId: 'never-called', output: 'unsolicited' },
      context,
    ),
  ).rejects.toThrow()
})

// Cloudflare packages/think/src/tests/actions-durable-pause.test.ts: does not resolve a later paused call that reuses the toolCallId (#1992).
// Gap: settlement keys have only the call id, so a later run inherits an earlier run's approval.
it.fails('a reused call id in a new run needs its own approval', async () => {
  const fixture = await shop()
  const opened = await fixture.open()
  opened.faux.setResponses([
    call('pay', { amount: 100 }, 'reused'),
    fauxAssistantMessage('First paid.'),
    call('pay', { amount: 200 }, 'reused'),
    fauxAssistantMessage('Second paid.'),
  ])
  await park(opened)
  await decide(opened.harness, opened.root.id, { callId: 'reused', approved: true }, context)
  await opened.root.waitForIdle(context)
  expect(fixture.paid).toEqual([100])
  await consume(
    await streamRun(
      opened.harness,
      { conversationId: opened.root.id, content: 'Pay again', requestId: 'again' },
      context,
    ),
  )
  expect(fixture.paid).toEqual([100])
  expect(await waiting(opened.harness, opened.root.id, context)).toMatchObject([
    { kind: 'approval', callId: 'reused', input: { amount: 200 } },
  ])
})

// Cloudflare packages/think/src/tests/submissions.test.ts: detached notify submits a follow-up turn that drains to a model response;
// detached milestone notify submits once and is idempotent across re-delivery.
it('a detached late answer creates one follow-up model turn across redelivery', async () => {
  const fixture = await shop()
  const opened = await fixture.open()
  const prompts: string[] = []
  opened.faux.setResponses([
    call('later', { question: 'Account?' }, 'later'),
    fauxAssistantMessage('Continuing.'),
    (request) => {
      prompts.push(modelText(request.messages))
      return fauxAssistantMessage('Using savings.')
    },
  ])
  await consume(
    await streamRun(
      opened.harness,
      { conversationId: opened.root.id, content: 'Ask', requestId: 'ask' },
      context,
    ),
  )
  await opened.root.waitForIdle(context)
  await answer(opened.harness, opened.root.id, { callId: 'later', output: 'savings' }, context)
  await answer(opened.harness, opened.root.id, { callId: 'later', output: 'savings' }, context)
  await opened.root.waitForIdle(context)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('[answer to later] savings')
  expect(
    (await opened.root.context(context)).entries.filter((entry) => entry.kind === 'pi.user'),
  ).toHaveLength(2)
  expect(await waiting(opened.harness, opened.root.id, context)).toEqual([])
})

// Cloudflare packages/think/src/tests/submissions.test.ts: detached notify created during an active turn drains after that turn.
it('a detached late answer waits behind the active run', async () => {
  const fixture = await shop()
  const opened = await fixture.open()
  const entered = signal()
  const release = signal()
  const order: string[] = []
  opened.faux.setResponses([
    call('later', { question: 'Account?' }, 'later'),
    async () => {
      entered.resolve()
      await release.promise
      order.push('current')
      return fauxAssistantMessage('Current finished.')
    },
    (request) => {
      expect(modelText(request.messages)).toContain('[answer to later] savings')
      order.push('delivery')
      return fauxAssistantMessage('Late finished.')
    },
  ])
  const stream = await streamRun(
    opened.harness,
    { conversationId: opened.root.id, content: 'Ask', requestId: 'ask' },
    context,
  )
  await entered.promise
  await answer(opened.harness, opened.root.id, { callId: 'later', output: 'savings' }, context)
  expect(order).toEqual([])
  release.resolve()
  const result = await consume(stream)
  await opened.root.waitForIdle(context)
  expect(texts(result.message)).toEqual(['Current finished.'])
  expect(order).toEqual(['current', 'delivery'])
})
