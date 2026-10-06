import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { isToolUIPart, lastAssistantMessageIsCompleteWithApprovalResponses } from 'ai'
import { expect, it, onTestFinished } from 'vitest'
import * as NodeChildProcess from 'node:child_process'
import * as NodeEvents from 'node:events'
import * as NodeURL from 'node:url'
import { Holds } from '../holds.ts'
import { Delivery } from '../delivery.ts'
import { Predicate } from 'effect'
import { PlainChat } from '../fixtures/chat.ts'
import { abort, answer, attachRun, decide, history, respond, streamRun, waiting } from '../main.ts'
import { call, consume, context, hold, modelText, shop, signal } from './fixtures/host.ts'

/** First reserve a late question, then park the same run on approval so its answer queues. */
async function parkedQuestion() {
  const fixture = await shop()
  const opened = await fixture.open()
  opened.faux.setResponses([
    call('later', { question: 'Which account?' }, 'x'),
    call('pay', { amount: 100 }, 'pay'),
  ])
  await consume(
    await streamRun(
      opened.harness,
      { conversationId: opened.root.id, content: 'Ask then pay', requestId: 'question' },
      context,
    ),
  )
  const question = await hold(opened.harness, opened.root.id, 'x')
  return { fixture, opened, question }
}

// Opus M9: withdrawal reopens the question; the next answer wins, then queued/placed repeats are idempotent.
it('reopens a withdrawn late answer and delivers it through a fresh attempt', async () => {
  const { opened, question } = await parkedQuestion()
  const first = await answer(
    opened.harness,
    opened.root.id,
    { holdId: question, output: 'savings' },
    context,
  )
  expect(first).toEqual({ kind: 'answered', output: 'savings' })
  expect(
    await answer(
      opened.harness,
      opened.root.id,
      { holdId: question, output: 'different' },
      context,
    ),
  ).toEqual(first)
  expect((await waiting(opened.harness, opened.root.id, context)).map((row) => row.kind)).toEqual([
    'approval',
  ])
  await abort(opened.harness, opened.root.id, context)
  expect(await waiting(opened.harness, opened.root.id, context)).toMatchObject([
    { kind: 'later', holdId: question },
  ])
  let received = ''
  opened.faux.setResponses([
    (request) => {
      received = modelText(request.messages)
      return fauxAssistantMessage('Answered.')
    },
  ])
  expect(
    await answer(opened.harness, opened.root.id, { holdId: question, output: 'checking' }, context),
  ).toEqual({ kind: 'answered', output: 'checking' })
  await opened.root.waitForIdle(context)
  expect(received).not.toContain('[answer to later] savings')
  expect(received).toContain('[answer to later] checking')
  expect(await waiting(opened.harness, opened.root.id, context)).toEqual([])
  expect(
    await answer(opened.harness, opened.root.id, { holdId: question, output: 'third' }, context),
  ).toEqual({ kind: 'answered', output: 'checking' })
  const page = await history(opened.harness, opened.root.id, { limit: 10 }, context)
  expect(page.messages.filter((message) => message.role === 'user')).toHaveLength(2)
})

// Opus J1: reopening loses volatile state, but recorded admission and first-output receipt agree.
it('keeps queued different-output retries idempotent across a host restart', async () => {
  const { fixture, opened, question } = await parkedQuestion()
  const first = await answer(
    opened.harness,
    opened.root.id,
    { holdId: question, output: 'savings' },
    context,
  )
  await fixture.close(opened.harness)
  const restored = await fixture.open()
  expect(
    await answer(
      restored.harness,
      restored.root.id,
      { holdId: question, output: 'checking' },
      context,
    ),
  ).toEqual(first)
  let received = ''
  restored.faux.setResponses([
    fauxAssistantMessage('Paid.'),
    (request) => {
      received = modelText(request.messages)
      return fauxAssistantMessage('Answered.')
    },
  ])
  await decide(
    restored.harness,
    restored.root.id,
    { holdId: await hold(restored.harness, restored.root.id, 'pay'), approved: true },
    context,
  )
  await restored.root.waitForIdle(context)
  expect(received).toContain('[answer to later] savings')
  expect(received).not.toContain('[answer to later] checking')
  expect(
    await answer(
      restored.harness,
      restored.root.id,
      { holdId: question, output: 'third' },
      context,
    ),
  ).toEqual(first)
})

// Opus J2: old assistant message identity makes the entire resume stale across runs.
it('does not replay a client output into a new run reusing its call id', async () => {
  const fixture = await shop()
  const opened = await fixture.open()
  opened.faux.setResponses([
    call('ask', { question: 'Which account?' }, 'x'),
    fauxAssistantMessage('First.'),
    call('ask', { question: 'Delete everything?' }, 'x'),
    fauxAssistantMessage('Second.'),
  ])
  const first = await consume(
    await streamRun(
      opened.harness,
      { conversationId: opened.root.id, content: 'First', requestId: 'first' },
      context,
    ),
  )
  const body = JSON.stringify({
    messages: [
      {
        id: first.message.id,
        role: 'assistant',
        parts: [{ type: 'tool-ask', toolCallId: 'x', state: 'output-available', output: 'yes' }],
      },
    ],
  })
  expect(
    (
      await respond(
        opened.harness,
        opened.root.id,
        new Request('http://durable.test/chat', { method: 'POST', body }),
        context,
      )
    ).status,
  ).toBe(200)
  await opened.root.waitForIdle(context)
  const second = await consume(
    await streamRun(
      opened.harness,
      { conversationId: opened.root.id, content: 'Second', requestId: 'second' },
      context,
    ),
  )
  expect(second.message.id).not.toBe(first.message.id)
  const replayed = await respond(
    opened.harness,
    opened.root.id,
    new Request('http://durable.test/chat', { method: 'POST', body }),
    context,
  )
  expect(replayed.status).toBe(200)
  if (replayed.body === null) throw new Error('Expected resumed observation')
  await replayed.body.cancel()
  expect(await waiting(opened.harness, opened.root.id, context)).toMatchObject([
    { kind: 'answer', callId: 'x', input: { question: 'Delete everything?' } },
  ])
})

// Pi events.js compares first inputs: a steer must not change the approval message's identity.
it('keeps the run message id stable after a steer adds an input', async () => {
  const fixture = await shop()
  const opened = await fixture.open()
  opened.faux.setResponses([
    call('pay', { amount: 100 }, 'c1'),
    call('pay', { amount: 200 }, 'c2'),
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
  const messageId = chat.lastMessage.id
  const part = chat.lastMessage.parts.find(isToolUIPart)
  if (part === undefined || part.state !== 'approval-requested')
    throw new Error('Expected first approval')
  await opened.root.submit(
    { type: 'input', content: 'Also another payment', requestId: 'steer', whenBusy: 'steer' },
    context,
  )
  completion = signal()
  await chat.addToolApprovalResponse({ id: part.approval.id, approved: true })
  await completion.promise
  expect(chat.lastMessage.id).toBe(messageId)
  const attached = await attachRun(opened.harness, opened.root.id, context)
  if (attached.status !== 'running') throw new Error('Expected c2 run')
  expect((await consume(attached.stream)).message.id).toBe(messageId)
  const second = chat.lastMessage.parts.find(
    (candidate) => isToolUIPart(candidate) && candidate.toolCallId === 'c2',
  )
  if (second === undefined || !isToolUIPart(second) || second.state !== 'approval-requested')
    throw new Error('Expected second approval')
  completion = signal()
  await chat.addToolApprovalResponse({ id: second.approval.id, approved: true })
  await completion.promise
  expect(fixture.paid).toEqual([100, 200])
})

/** Pi publishes the committed submission before resolving admission; kill exactly at that boundary. */
it('retries a crash after admission using the first reserved output and the same submission', async () => {
  const fixture = await shop()
  const child = NodeChildProcess.spawn(
    process.execPath,
    [NodeURL.fileURLToPath(new URL('../fixtures/answer.ts', import.meta.url)), fixture.file],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
  onTestFinished(() => {
    child.kill('SIGKILL')
  })
  const [code, death] = await NodeEvents.EventEmitter.once(child, 'exit')
  expect(code).toBeNull()
  expect(death).toBe('SIGKILL')
  const restored = await fixture.open()
  const rows = await waiting(restored.harness, restored.root.id, context)
  const question = rows.find((row) => row.kind === 'later')
  if (question === undefined) throw new Error('Expected reserved question after crash')
  const document = await restored.harness.snapshot(Holds, restored.root.id, context)
  if (document === undefined) throw new Error('Expected reserved holds')
  expect(document.asked[question.holdId]).toMatchObject({
    delivery: Delivery.cases.Reserved.make({ output: 'savings', attempt: 0 }),
  })
  expect(
    await answer(
      restored.harness,
      restored.root.id,
      { holdId: question.holdId, output: 'checking' },
      context,
    ),
  ).toEqual({ kind: 'answered', output: 'savings' })
  let received = ''
  restored.faux.setResponses([
    fauxAssistantMessage('Paid.'),
    (request) => {
      received = modelText(request.messages)
      return fauxAssistantMessage('Delivered.')
    },
  ])
  await decide(
    restored.harness,
    restored.root.id,
    { holdId: await hold(restored.harness, restored.root.id, 'pay'), approved: true },
    context,
  )
  await restored.root.waitForIdle(context)
  expect(received).toContain('[answer to later] savings')
  expect(received).not.toContain('[answer to later] checking')
  expect(
    await answer(
      restored.harness,
      restored.root.id,
      { holdId: question.holdId, output: 'third' },
      context,
    ),
  ).toEqual({ kind: 'answered', output: 'savings' })
  const entries = await restored.root.entries({}, 100, undefined, context)
  expect(entries.items.filter((entry) => entry.kind === 'pi.user')).toHaveLength(2)
}, 30_000)

/** Concurrent different outputs return one detached settlement and admit one user message. */
it('returns the first late-answer settlement to concurrent different-output callers', async () => {
  const fixture = await shop()
  const opened = await fixture.open()
  const received: string[] = []
  opened.faux.setResponses([
    call('later', { question: 'Which?' }, 'x'),
    fauxAssistantMessage('Asked.'),
    (request) => {
      received.push(modelText(request.messages))
      return fauxAssistantMessage('Delivered.')
    },
  ])
  await consume(
    await streamRun(
      opened.harness,
      { conversationId: opened.root.id, content: 'Ask', requestId: 'concurrent-question' },
      context,
    ),
  )
  const question = await hold(opened.harness, opened.root.id, 'x')
  const settlements = await Promise.all(
    ['savings', 'checking'].map((output) =>
      answer(opened.harness, opened.root.id, { holdId: question, output }, context),
    ),
  )
  expect(settlements[0]).toEqual(settlements[1])
  const first = settlements[0]
  if (first === undefined || first.kind !== 'answered' || !Predicate.isString(first.output))
    throw new Error('Expected answered settlement')
  await opened.root.waitForIdle(context)
  expect(received).toHaveLength(1)
  expect(received[0]).toContain(`[answer to later] ${first.output}`)
})
