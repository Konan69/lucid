import { Deferred, Effect, Option } from 'effect'
import { FixtureFailed } from '../fixtures/harness.ts'
import { consumeReadable, hold } from '../fixtures/reading.ts'

import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { isToolUIPart, lastAssistantMessageIsCompleteWithApprovalResponses } from 'ai'
import { expect, it, onTestFinished } from '@effect/vitest'
import * as NodeChildProcess from 'node:child_process'
import * as NodeEvents from 'node:events'
import * as NodeURL from 'node:url'
import { Holds } from '../holds.ts'
import { Delivery } from '../delivery.ts'
import { Predicate } from 'effect'
import { PlainChat } from '../fixtures/chat.ts'
import { abort, answer, attachRun, decide, history, respond, streamRun, waiting } from '../main.ts'
import { call, context, modelText, shop } from './fixtures/host.ts'
const parkedQuestion = Effect.fn('Test.parkedQuestion')(function* () {
  const fixture = yield* shop()
  const opened = yield* fixture.open()
  opened.faux.setResponses([
    call('later', { question: 'Which account?' }, 'x'),
    call('pay', { amount: 100 }, 'pay'),
  ])
  yield* consumeReadable(
    yield* Effect.promise(() =>
      streamRun(
        opened.harness,
        { conversationId: opened.root.id, content: 'Ask then pay', requestId: 'question' },
        context,
      ),
    ),
    Option.none(),
  )
  const question = yield* hold(opened.harness, opened.root.id, 'x', context)
  return { fixture, opened, question }
})
// Opus M9: withdrawal reopens the question; the next answer wins, then queued/placed repeats are idempotent.
it.live('reopens a withdrawn late answer and delivers it through a fresh attempt', () =>
  Effect.gen(function* () {
    const { opened, question } = yield* parkedQuestion()
    const first = yield* Effect.promise(() =>
      answer(opened.harness, opened.root.id, { holdId: question, output: 'savings' }, context),
    )
    expect(first).toEqual({ kind: 'answered', output: 'savings' })
    expect(
      yield* Effect.promise(() =>
        answer(opened.harness, opened.root.id, { holdId: question, output: 'different' }, context),
      ),
    ).toEqual(first)
    expect(
      (yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context))).map(
        (row) => row.kind,
      ),
    ).toEqual(['approval'])
    yield* Effect.promise(() => abort(opened.harness, opened.root.id, context))
    expect(
      yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context)),
    ).toMatchObject([{ kind: 'later', holdId: question }])
    let received = ''
    opened.faux.setResponses([
      (request) => {
        received = modelText(request.messages)
        return fauxAssistantMessage('Answered.')
      },
    ])
    expect(
      yield* Effect.promise(() =>
        answer(opened.harness, opened.root.id, { holdId: question, output: 'checking' }, context),
      ),
    ).toEqual({ kind: 'answered', output: 'checking' })
    yield* Effect.promise(() => opened.root.waitForIdle(context))
    expect(received).not.toContain('[answer to later] savings')
    expect(received).toContain('[answer to later] checking')
    expect(yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context))).toEqual(
      [],
    )
    expect(
      yield* Effect.promise(() =>
        answer(opened.harness, opened.root.id, { holdId: question, output: 'third' }, context),
      ),
    ).toEqual({ kind: 'answered', output: 'checking' })
    const page = yield* Effect.promise(() =>
      history(opened.harness, opened.root.id, { limit: 10 }, context),
    )
    expect(page.messages.filter((message) => message.role === 'user')).toHaveLength(2)
  }),
)
// Opus J1: reopening loses volatile state, but recorded admission and first-output receipt agree.
it.live('keeps queued different-output retries idempotent across a host restart', () =>
  Effect.gen(function* () {
    const { fixture, opened, question } = yield* parkedQuestion()
    const first = yield* Effect.promise(() =>
      answer(opened.harness, opened.root.id, { holdId: question, output: 'savings' }, context),
    )
    yield* fixture.close(opened.harness)
    const restored = yield* fixture.open()
    expect(
      yield* Effect.promise(() =>
        answer(
          restored.harness,
          restored.root.id,
          { holdId: question, output: 'checking' },
          context,
        ),
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
    const resolved1 = yield* hold(restored.harness, restored.root.id, 'pay', context)
    yield* Effect.promise(() =>
      decide(restored.harness, restored.root.id, { holdId: resolved1, approved: true }, context),
    )
    yield* Effect.promise(() => restored.root.waitForIdle(context))
    expect(received).toContain('[answer to later] savings')
    expect(received).not.toContain('[answer to later] checking')
    expect(
      yield* Effect.promise(() =>
        answer(restored.harness, restored.root.id, { holdId: question, output: 'third' }, context),
      ),
    ).toEqual(first)
  }),
)
// Opus J2: old assistant message identity makes the entire resume stale across runs.
it.live('does not replay a client output into a new run reusing its call id', () =>
  Effect.gen(function* () {
    const fixture = yield* shop()
    const opened = yield* fixture.open()
    opened.faux.setResponses([
      call('ask', { question: 'Which account?' }, 'x'),
      fauxAssistantMessage('First.'),
      call('ask', { question: 'Delete everything?' }, 'x'),
      fauxAssistantMessage('Second.'),
    ])
    const first = yield* consumeReadable(
      yield* Effect.promise(() =>
        streamRun(
          opened.harness,
          { conversationId: opened.root.id, content: 'First', requestId: 'first' },
          context,
        ),
      ),
      Option.none(),
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
      (yield* Effect.promise(() =>
        respond(
          opened.harness,
          opened.root.id,
          new Request('http://durable.test/chat', { method: 'POST', body }),
          context,
        ),
      )).status,
    ).toBe(200)
    yield* Effect.promise(() => opened.root.waitForIdle(context))
    const second = yield* consumeReadable(
      yield* Effect.promise(() =>
        streamRun(
          opened.harness,
          { conversationId: opened.root.id, content: 'Second', requestId: 'second' },
          context,
        ),
      ),
      Option.none(),
    )
    expect(second.message.id).not.toBe(first.message.id)
    const replayed = yield* Effect.promise(() =>
      respond(
        opened.harness,
        opened.root.id,
        new Request('http://durable.test/chat', { method: 'POST', body }),
        context,
      ),
    )
    expect(replayed.status).toBe(200)
    const replayBody = replayed.body
    if (replayBody === null) throw new Error('Expected resumed observation')
    yield* Effect.promise(() => replayBody.cancel())
    expect(
      yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context)),
    ).toMatchObject([{ kind: 'answer', callId: 'x', input: { question: 'Delete everything?' } }])
  }),
)
// Pi events.js compares first inputs: a steer must not change the approval message's identity.
it.live('keeps the run message id stable after a steer adds an input', () =>
  Effect.gen(function* () {
    const fixture = yield* shop()
    const opened = yield* fixture.open()
    opened.faux.setResponses([
      call('pay', { amount: 100 }, 'c1'),
      call('pay', { amount: 200 }, 'c2'),
      fauxAssistantMessage('Done.'),
    ])
    let completion = yield* Deferred.make<void, FixtureFailed>()
    const chat = new PlainChat({
      transport: opened.transport,
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
      onFinish: () => Deferred.doneUnsafe(completion, Effect.void),
      onError: (error) =>
        Deferred.doneUnsafe(completion, Effect.fail(new FixtureFailed({ cause: error }))),
    })
    yield* Effect.promise(() => chat.sendMessage({ text: 'Pay' }))
    if (chat.lastMessage === undefined) throw new Error('Expected assistant')
    const messageId = chat.lastMessage.id
    const part = chat.lastMessage.parts.find(isToolUIPart)
    if (part === undefined || part.state !== 'approval-requested')
      throw new Error('Expected first approval')
    yield* Effect.promise(() =>
      opened.root.submit(
        { type: 'input', content: 'Also another payment', requestId: 'steer', whenBusy: 'steer' },
        context,
      ),
    )
    completion = yield* Deferred.make<void, FixtureFailed>()
    yield* Effect.promise(() =>
      Promise.resolve(chat.addToolApprovalResponse({ id: part.approval.id, approved: true })),
    )
    yield* Deferred.await(completion)
    expect(chat.lastMessage.id).toBe(messageId)
    const attached = yield* Effect.promise(() => attachRun(opened.harness, opened.root.id, context))
    if (attached.status !== 'running') throw new Error('Expected c2 run')
    expect((yield* consumeReadable(attached.stream, Option.none())).message.id).toBe(messageId)
    const second = chat.lastMessage.parts.find(
      (candidate) => isToolUIPart(candidate) && candidate.toolCallId === 'c2',
    )
    if (second === undefined || !isToolUIPart(second) || second.state !== 'approval-requested')
      throw new Error('Expected second approval')
    completion = yield* Deferred.make<void, FixtureFailed>()
    yield* Effect.promise(() =>
      Promise.resolve(chat.addToolApprovalResponse({ id: second.approval.id, approved: true })),
    )
    yield* Deferred.await(completion)
    expect(fixture.paid).toEqual([100, 200])
  }),
)
/** Pi publishes the committed submission before resolving admission; kill exactly at that boundary. */
it.live(
  'retries a crash after admission using the first reserved output and the same submission',
  () =>
    Effect.gen(function* () {
      const fixture = yield* shop()
      const child = NodeChildProcess.spawn(
        process.execPath,
        [NodeURL.fileURLToPath(new URL('../fixtures/answer.ts', import.meta.url)), fixture.file],
        { stdio: ['ignore', 'ignore', 'inherit'] },
      )
      onTestFinished(() => {
        child.kill('SIGKILL')
      })
      const [code, death] = yield* Effect.promise(() => NodeEvents.EventEmitter.once(child, 'exit'))
      expect(code).toBeNull()
      expect(death).toBe('SIGKILL')
      const restored = yield* fixture.open()
      const rows = yield* Effect.promise(() => waiting(restored.harness, restored.root.id, context))
      const question = rows.find((row) => row.kind === 'later')
      if (question === undefined) throw new Error('Expected reserved question after crash')
      const document = yield* Effect.promise(() =>
        restored.harness.snapshot(Holds, restored.root.id, context),
      )
      if (document === undefined) throw new Error('Expected reserved holds')
      expect(document.asked[question.holdId]).toMatchObject({
        delivery: Delivery.cases.Reserved.make({ output: 'savings', attempt: 0 }),
      })
      expect(
        yield* Effect.promise(() =>
          answer(
            restored.harness,
            restored.root.id,
            { holdId: question.holdId, output: 'checking' },
            context,
          ),
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
      const resolved2 = yield* hold(restored.harness, restored.root.id, 'pay', context)
      yield* Effect.promise(() =>
        decide(restored.harness, restored.root.id, { holdId: resolved2, approved: true }, context),
      )
      yield* Effect.promise(() => restored.root.waitForIdle(context))
      expect(received).toContain('[answer to later] savings')
      expect(received).not.toContain('[answer to later] checking')
      expect(
        yield* Effect.promise(() =>
          answer(
            restored.harness,
            restored.root.id,
            { holdId: question.holdId, output: 'third' },
            context,
          ),
        ),
      ).toEqual({ kind: 'answered', output: 'savings' })
      const entries = yield* Effect.promise(() =>
        restored.root.entries({}, 100, undefined, context),
      )
      expect(entries.items.filter((entry) => entry.kind === 'pi.user')).toHaveLength(2)
    }),
  30000,
)
/** Concurrent different outputs return one detached settlement and admit one user message. */
it.live('returns the first late-answer settlement to concurrent different-output callers', () =>
  Effect.gen(function* () {
    const fixture = yield* shop()
    const opened = yield* fixture.open()
    const received: string[] = []
    opened.faux.setResponses([
      call('later', { question: 'Which?' }, 'x'),
      fauxAssistantMessage('Asked.'),
      (request) => {
        received.push(modelText(request.messages))
        return fauxAssistantMessage('Delivered.')
      },
    ])
    yield* consumeReadable(
      yield* Effect.promise(() =>
        streamRun(
          opened.harness,
          { conversationId: opened.root.id, content: 'Ask', requestId: 'concurrent-question' },
          context,
        ),
      ),
      Option.none(),
    )
    const question = yield* hold(opened.harness, opened.root.id, 'x', context)
    const settlements = yield* Effect.forEach(
      ['savings', 'checking'],
      (output) =>
        Effect.promise(() =>
          answer(opened.harness, opened.root.id, { holdId: question, output }, context),
        ),
      { concurrency: 'unbounded' },
    )
    expect(settlements[0]).toEqual(settlements[1])
    const first = settlements[0]
    if (first === undefined || first.kind !== 'answered' || !Predicate.isString(first.output))
      throw new Error('Expected answered settlement')
    yield* Effect.promise(() => opened.root.waitForIdle(context))
    expect(received).toHaveLength(1)
    expect(received[0]).toContain(`[answer to later] ${first.output}`)
  }),
)
