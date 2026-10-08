import { Effect, Option } from 'effect'
import { consumeReadable, hold } from '../fixtures/reading.ts'
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from '@effect/vitest'
import {
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
  tool,
} from 'ai'
import { z } from 'zod'
import { client, Decision } from '../fixtures/chat.ts'
import { answer, attachRun, history, respond, streamRun, waiting } from '../main.ts'
import { call, context, host, shop, texts } from './fixtures/host.ts'

// Real generation partials expose the call before the trailing text, without waiting for a tool task.
it.live('keeps slow parallel content order identical in live Chat, attachment and history', () =>
  Effect.gen(function* () {
    const fixture = yield* host(
      {
        pay: tool({
          inputSchema: z.object({ amount: z.number() }),
          execute: ({ amount }) => {
            return Promise.resolve(amount)
          },
        }),
      },
      { approval: { pay: true } },
      { progress: { partialIntervalMs: 0 } },
      { commitFrames: true, tokenSize: { min: 1, max: 1 } },
    )
    const opened = yield* fixture.open()
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
    const { chat, next } = client({
      transport: opened.transport,
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    })
    let completion = next()
    yield* Effect.promise(() => Promise.resolve(chat.sendMessage({ text: 'Pay' })))
    expect(yield* completion).toEqual(Decision.cases.Settled.make({}))
    if (chat.lastMessage === undefined) throw new Error('Expected assistant')
    expect(chat.lastMessage.parts.map((part) => part.type)).toEqual([
      'step-start',
      'text',
      'tool-pay',
      'text',
    ])
    // The terminal entry must supply any suffix omitted by Pi's throttled last partial commit.
    expect(texts(chat.lastMessage)).toEqual(['Before '.repeat(20), 'After '.repeat(20)])
    const attached = yield* Effect.promise(() =>
      Promise.resolve(attachRun(opened.harness, opened.root.id, context)),
    )
    if (attached.status !== 'running') throw new Error('Expected parked run')
    expect((yield* consumeReadable(attached.stream, Option.none())).message.parts).toEqual(
      chat.lastMessage.parts,
    )
    const part = chat.lastMessage.parts.find(isToolUIPart)
    if (part === undefined || part.state !== 'approval-requested')
      throw new Error('Expected approval')
    completion = next()
    yield* Effect.promise(() =>
      Promise.resolve(chat.addToolApprovalResponse({ id: part.approval.id, approved: true })),
    )
    expect(yield* completion).toEqual(Decision.cases.Settled.make({}))
    yield* Effect.promise(() => Promise.resolve(opened.root.waitForIdle(context)))
    const page = yield* Effect.promise(() =>
      Promise.resolve(history(opened.harness, opened.root.id, { limit: 10 }, context)),
    )
    expect(page.messages.map((message) => message.parts)).toEqual(
      chat.messages.map((message) => message.parts),
    )
  }),
)

// A stock automatic-send predicate must not re-POST an old call against a successor run with the same id.
it.live(
  'posts a stale output once and restores its own finished run while the successor waits',
  () =>
    Effect.gen(function* () {
      const fixture = yield* shop()
      const opened = yield* fixture.open()
      opened.faux.setResponses([
        call('ask', { question: 'First?' }, 'x'),
        fauxAssistantMessage('First finished.'),
        call('ask', { question: 'Second?' }, 'x'),
      ])
      const observed = client({
        fetch: (url, init) => {
          const request = new Request(url, init)
          return Promise.resolve(respond(opened.harness, opened.root.id, request, context))
        },
        sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
      })
      const { chat: tab, next } = observed
      let completed = next()
      yield* Effect.promise(() => Promise.resolve(tab.sendMessage({ text: 'First' })))
      expect(yield* completed).toEqual(Decision.cases.Settled.make({}))
      yield* Effect.gen(function* () {
        const awaited1 = yield* hold(opened.harness, opened.root.id, 'x', context)
        return yield* Effect.promise(() =>
          Promise.resolve(
            answer(
              opened.harness,
              opened.root.id,
              { holdId: awaited1, output: 'Elsewhere' },
              context,
            ),
          ),
        )
      })
      yield* Effect.promise(() => Promise.resolve(opened.root.waitForIdle(context)))
      yield* consumeReadable(
        yield* Effect.promise(() =>
          Promise.resolve(
            streamRun(
              opened.harness,
              { conversationId: opened.root.id, content: 'Second', requestId: 'second' },
              context,
            ),
          ),
        ),
        Option.none(),
      )
      const held = yield* Effect.promise(() =>
        Promise.resolve(waiting(opened.harness, opened.root.id, context)),
      )
      completed = next()
      yield* Effect.promise(() =>
        Promise.resolve(tab.addToolOutput({ tool: 'ask', toolCallId: 'x', output: 'Stale' })),
      )
      expect(yield* completed).toEqual(Decision.cases.Settled.make({}))
      expect(observed.posts).toBe(2)
      expect(tab.status).toBe('ready')
      if (tab.lastMessage === undefined) throw new Error('Expected finished first run')
      expect(texts(tab.lastMessage)).toEqual(['First finished.'])
      expect(tab.lastMessage.parts.find(isToolUIPart)).toMatchObject({ output: 'Elsewhere' })
      expect(
        yield* Effect.promise(() =>
          Promise.resolve(waiting(opened.harness, opened.root.id, context)),
        ),
      ).toEqual(held)
    }),
)

/** A placed steer extends the located run: the stock predicate must see its still-waiting later call. */
it.live('continues past a steer without repeatedly posting an already answered call', () =>
  Effect.gen(function* () {
    const fixture = yield* shop({ steeringMode: 'all' })
    const opened = yield* fixture.open()
    opened.faux.setResponses([
      call('ask', { question: 'First?' }, 'x'),
      call('ask', { question: 'After steer?' }, 'y'),
      fauxAssistantMessage('Finished after steer.'),
    ])
    const observed = client({
      fetch: (url, init) => {
        const request = new Request(url, init)
        return Promise.resolve(respond(opened.harness, opened.root.id, request, context))
      },
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    })
    const { chat: tab, next } = observed
    let completed = next()
    yield* Effect.promise(() => Promise.resolve(tab.sendMessage({ text: 'First' })))
    expect(yield* completed).toEqual(Decision.cases.Settled.make({}))
    yield* Effect.promise(() =>
      Promise.resolve(
        opened.root.submit(
          {
            type: 'input',
            content: 'Steer this same run',
            requestId: 'steer',
            whenBusy: 'steer',
          },
          context,
        ),
      ),
    )
    yield* Effect.gen(function* () {
      const awaited2 = yield* hold(opened.harness, opened.root.id, 'x', context)
      return yield* Effect.promise(() =>
        Promise.resolve(
          answer(
            opened.harness,
            opened.root.id,
            { holdId: awaited2, output: 'Elsewhere' },
            context,
          ),
        ),
      )
    })
    const attached = yield* Effect.promise(() =>
      Promise.resolve(attachRun(opened.harness, opened.root.id, context)),
    )
    if (attached.status !== 'running') throw new Error('Expected steer-extended run')
    yield* consumeReadable(attached.stream, Option.none())
    const held = yield* Effect.promise(() =>
      Promise.resolve(waiting(opened.harness, opened.root.id, context)),
    )
    expect(held.map((row) => row.callId)).toEqual(['y'])
    completed = next()
    yield* Effect.promise(() =>
      Promise.resolve(tab.addToolOutput({ tool: 'ask', toolCallId: 'x', output: 'Stale' })),
    )
    expect(yield* completed).toEqual(Decision.cases.Settled.make({}))
    expect(observed.posts).toBe(2)
    expect(tab.status).toBe('ready')
    expect(tab.messages.filter((message) => message.role === 'assistant')).toHaveLength(1)
    if (tab.lastMessage === undefined) throw new Error('Expected extended assistant')
    expect(tab.lastMessage.parts.filter(isToolUIPart)).toMatchObject([
      { toolCallId: 'x', state: 'output-available', output: 'Elsewhere' },
      { toolCallId: 'y', state: 'input-available' },
    ])
    expect(
      yield* Effect.promise(() =>
        Promise.resolve(waiting(opened.harness, opened.root.id, context)),
      ),
    ).toEqual(held)
    completed = next()
    yield* Effect.promise(() =>
      Promise.resolve(tab.addToolOutput({ tool: 'ask', toolCallId: 'y', output: 'Now' })),
    )
    expect(yield* completed).toEqual(Decision.cases.Settled.make({}))
    expect(observed.posts).toBe(3)
    expect(tab.status).toBe('ready')
    expect(texts(tab.lastMessage)).toEqual(['Finished after steer.'])
    expect(
      yield* Effect.promise(() =>
        Promise.resolve(waiting(opened.harness, opened.root.id, context)),
      ),
    ).toEqual([])
  }),
)
