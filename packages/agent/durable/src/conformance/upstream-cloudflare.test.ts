import { Effect, Option } from 'effect'
import { consumeReadable, hold } from '../fixtures/reading.ts'
import { runForPi } from '../pi.ts'
import {
  fauxAssistantMessage,
  fauxThinking,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { dynamicTool, isToolUIPart, readUIMessageStream, tool, type UIMessage } from 'ai'
import { expect, it } from '@effect/vitest'
import { z } from 'zod'
import { Predicate } from 'effect'
import { PlainChat } from '../fixtures/chat.ts'
import { answer, continueRun, decide, history, streamRun, waiting } from '../main.ts'
import { call, context, host, modelText, shop, texts } from './fixtures/host.ts'
// Cloudflare packages/think/src/tests/actions-durable-pause.test.ts:185/197.
// Ports packages/think/src/tests/actions-durable-pause.test.ts:185 — durable-pause actions > runs inline (no park) when the approval predicate returns false.
it.live.each([
  {
    name: 'runs inline (no park) when the approval predicate returns false',
    amount: 10,
    parked: false,
  },
  { name: 'parks when the approval predicate returns true', amount: 100, parked: true },
])('approval predicate: $name', ({ amount, parked }) =>
  Effect.gen(function* () {
    const executed: number[] = []
    const fixture = yield* host(
      {
        pay: tool({
          inputSchema: z.object({ amount: z.number() }),
          execute: (input) =>
            runForPi(
              Effect.sync(() => {
                executed.push(input.amount)
                return input.amount
              }),
              undefined,
            ),
        }),
      },
      {
        approval: {
          pay: (input) => {
            return (
              Predicate.hasProperty(input, 'amount') &&
              Predicate.isNumber(input.amount) &&
              input.amount >= 100
            )
          },
        },
      },
    )
    const opened = yield* fixture.open()
    opened.faux.setResponses([call('pay', { amount }, 'pay'), fauxAssistantMessage('Paid.')])
    const result = yield* consumeReadable(
      yield* Effect.promise(() =>
        streamRun(
          opened.harness,
          { conversationId: opened.root.id, content: 'Pay', requestId: 'predicate' },
          context,
        ),
      ),
      Option.none(),
    )
    expect(executed).toEqual(parked ? [] : [amount])
    expect(
      yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context)),
    ).toHaveLength(parked ? 1 : 0)
    expect(result.message.parts.find(isToolUIPart)).toMatchObject({
      state: parked ? 'approval-requested' : 'output-available',
    })
  }),
)
// Cloudflare packages/think/src/tests/execute-hitl.test.ts:246.
// Ports packages/ai/src/ui/last-assistant-message-is-complete-with-approval-responses.test.ts:324 — lastAssistantMessageIsCompleteWithApprovalResponses > should only consider the last step in a multi-step message.
it.live('pause-again: the next gated call re-pauses; a second approve completes', () =>
  Effect.gen(function* () {
    const fixture = yield* shop()
    const opened = yield* fixture.open()
    opened.faux.setResponses([
      call('pay', { amount: 100 }, 'first'),
      call('pay', { amount: 200 }, 'second'),
      fauxAssistantMessage('Both paid.'),
    ])
    const first = yield* consumeReadable(
      yield* Effect.promise(() =>
        streamRun(
          opened.harness,
          { conversationId: opened.root.id, content: 'Pay twice', requestId: 'twice' },
          context,
        ),
      ),
      Option.none(),
    )
    const resolved1 = yield* hold(opened.harness, opened.root.id, 'first', context)
    yield* Effect.promise(() =>
      decide(opened.harness, opened.root.id, { holdId: resolved1, approved: true }, context),
    )
    const second = yield* consumeReadable(
      yield* Effect.promise(() =>
        continueRun(
          opened.harness,
          opened.root.id,
          { messageId: first.message.id, known: new Set(['first']) },
          context,
        ),
      ),
      Option.some(first.message),
    )
    expect(fixture.paid).toEqual([100])
    expect(
      yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context)),
    ).toMatchObject([{ callId: 'second', kind: 'approval' }])
    const resolved2 = yield* hold(opened.harness, opened.root.id, 'second', context)
    yield* Effect.promise(() =>
      decide(opened.harness, opened.root.id, { holdId: resolved2, approved: true }, context),
    )
    const result = yield* consumeReadable(
      yield* Effect.promise(() =>
        continueRun(
          opened.harness,
          opened.root.id,
          { messageId: first.message.id, known: new Set(['first', 'second']) },
          context,
        ),
      ),
      Option.some(second.message),
    )
    expect(result.message.id).toBe(first.message.id)
    expect(fixture.paid).toEqual([100, 200])
    expect(texts(result.message)).toEqual(['Both paid.'])
  }),
)
// Cloudflare packages/think/src/tests/actions-durable-pause.test.ts:132/149;
// execute-hitl.test.ts:297/325. Adaptation: Pi's first settlement wins; repeated callers receive it.
// Upstream packages/think/src/tests/execute-hitl.test.ts:297 — Think HITL — approve/reject paused executions > double-approve is graceful: the second returns an error and leaves the transcript alone.
it.live.each([
  {
    name: 'second approve',
    first: true,
    second: true,
  },
  { name: 'approve after reject', first: false, second: true },
  {
    name: 'reject after approve',
    first: true,
    second: false,
  },
])('returns the first settlement after $name', ({ first, second }) =>
  Effect.gen(function* () {
    const fixture = yield* shop()
    const opened = yield* fixture.open()
    opened.faux.setResponses([
      call('pay', { amount: 100 }, 'pay'),
      fauxAssistantMessage('Settled.'),
    ])
    yield* consumeReadable(
      yield* Effect.promise(() =>
        streamRun(
          opened.harness,
          { conversationId: opened.root.id, content: 'Pay', requestId: 'repeat' },
          context,
        ),
      ),
      Option.none(),
    )
    const holdId = yield* hold(opened.harness, opened.root.id, 'pay', context)
    const settled = yield* Effect.promise(() =>
      decide(
        opened.harness,
        opened.root.id,
        { holdId, approved: first, reason: 'First decision' },
        context,
      ),
    )
    expect(settled).toEqual(
      first ? { kind: 'approved' } : { kind: 'denied', reason: 'First decision' },
    )
    yield* Effect.promise(() => opened.root.waitForIdle(context))
    const before = yield* Effect.promise(() =>
      history(opened.harness, opened.root.id, { limit: 10 }, context),
    )
    const repeat = yield* Effect.promise(() =>
      decide(
        opened.harness,
        opened.root.id,
        { holdId, approved: second, reason: 'Later decision' },
        context,
      ),
    )
    expect(
      yield* Effect.promise(() => history(opened.harness, opened.root.id, { limit: 10 }, context)),
    ).toEqual(before)
    expect(fixture.paid).toEqual(first ? [100] : [])
    expect(repeat).toEqual(settled)
  }),
)
// Cloudflare packages/think/src/tests/actions-durable-pause.test.ts:624-665.
// Adaptation: Pi keeps its recorded response; a decision cannot rewrite post-pause generation.
// Upstream packages/think/src/tests/actions-durable-pause.test.ts:624 — resolving a durable pause drops pending-state generation (#2054) > drops text and reasoning written after the paused part on approve.
// Upstream packages/think/src/tests/actions-durable-pause.test.ts:651 — resolving a durable pause drops pending-state generation (#2054) > drops text and reasoning written after the paused part on reject.
it.live.each([true, false])('retains recorded post-pause content after approval=%s', (approved) =>
  Effect.gen(function* () {
    const fixture = yield* shop()
    const opened = yield* fixture.open()
    let prompt = ''
    opened.faux.setResponses([
      fauxAssistantMessage(
        [
          { type: 'text', text: 'Checking first.' },
          fauxToolCall('pay', { amount: 100 }, { id: 'pay' }),
          fauxThinking('Waiting for approval.'),
          { type: 'text', text: 'Once approved, it runs.' },
        ],
        { stopReason: 'toolUse' },
      ),
      (request) => {
        prompt = modelText(request.messages)
        return fauxAssistantMessage('Settled.')
      },
    ])
    yield* consumeReadable(
      yield* Effect.promise(() =>
        streamRun(
          opened.harness,
          { conversationId: opened.root.id, content: 'Pay', requestId: 'pending' },
          context,
        ),
      ),
      Option.none(),
    )
    const resolved3 = yield* hold(opened.harness, opened.root.id, 'pay', context)
    yield* Effect.promise(() =>
      decide(opened.harness, opened.root.id, { holdId: resolved3, approved }, context),
    )
    yield* Effect.promise(() => opened.root.waitForIdle(context))
    const saved = yield* Effect.promise(() =>
      history(opened.harness, opened.root.id, { limit: 10 }, context),
    )
    expect(saved.messages.flatMap(texts)).toContain('Checking first.')
    expect(
      saved.messages
        .flatMap((message) => message.parts)
        .filter((part) => part.type === 'reasoning'),
    ).toMatchObject([{ text: 'Waiting for approval.', state: 'done' }])
    expect(saved.messages.flatMap(texts)).toContain('Once approved, it runs.')
    expect(prompt).toContain('Once approved, it runs.')
    expect(fixture.paid).toEqual(approved ? [100] : [])
  }),
)
// Cloudflare packages/agents/src/harness/pi/tests/harness.test.ts:144;
// packages/ai-chat/src/tests/message-concurrency.test.ts:923, queue policy only.
// Ports packages/agents/src/harness/pi/tests/harness.test.ts:144 — PiHarness on pi-durable > answers every one of many submissions made to one session at once.
it.live('answers every one of many submissions made to one session at once', () =>
  Effect.gen(function* () {
    const fixture = yield* host({}, {})
    const opened = yield* fixture.open()
    const inputs = ['one', 'two', 'three', 'four']
    opened.faux.setResponses(inputs.map((text) => fauxAssistantMessage(text)))
    const streams = []
    for (const content of inputs)
      streams.push(
        yield* Effect.promise(() =>
          streamRun(
            opened.harness,
            { conversationId: opened.root.id, content, requestId: content },
            context,
          ),
        ),
      )
    const results = yield* Effect.forEach(
      streams,
      (stream) => consumeReadable(stream, Option.none()),
      { concurrency: 'unbounded' },
    )
    expect(results.map((result) => texts(result.message))).toEqual(inputs.map((text) => [text]))
    expect(new Set(results.map((result) => result.message.id)).size).toBe(inputs.length)
    expect(opened.faux.state.callCount).toBe(inputs.length)
    expect(
      (yield* Effect.promise(() =>
        history(opened.harness, opened.root.id, { limit: 20 }, context),
      )).messages.map(texts),
    ).toEqual(inputs.flatMap((text) => [[text], [text]]))
  }),
)
// Cloudflare packages/agents/src/harness/pi/tests/harness.test.ts:196.
// Ports packages/agents/src/harness/pi/tests/harness.test.ts:196 — PiHarness on pi-durable > keeps sessions separate.
it.live('keeps sessions separate', () =>
  Effect.gen(function* () {
    const fixture = yield* host({}, {})
    const opened = yield* fixture.open()
    const other = yield* Effect.promise(() =>
      opened.harness.createConversation(
        {
          ownership: { kind: 'ownerless' },
          agent: { model: { provider: 'faux', modelId: 'faux-1' } },
        },
        context,
      ),
    )
    opened.faux.setResponses([
      fauxAssistantMessage('Root only.'),
      fauxAssistantMessage('Other only.'),
    ])
    yield* consumeReadable(
      yield* Effect.promise(() =>
        streamRun(
          opened.harness,
          { conversationId: opened.root.id, content: 'Root', requestId: 'same' },
          context,
        ),
      ),
      Option.none(),
    )
    yield* consumeReadable(
      yield* Effect.promise(() =>
        streamRun(
          opened.harness,
          { conversationId: other.id, content: 'Other', requestId: 'same' },
          context,
        ),
      ),
      Option.none(),
    )
    expect(
      (yield* Effect.promise(() =>
        history(opened.harness, opened.root.id, { limit: 10 }, context),
      )).messages.map(texts),
    ).toEqual([['Root'], ['Root only.']])
    expect(
      (yield* Effect.promise(() =>
        history(opened.harness, other.id, { limit: 10 }, context),
      )).messages.map(texts),
    ).toEqual([['Other'], ['Other only.']])
  }),
)
// Cloudflare packages/ai-chat/src/react-tests/use-agent-chat.test.tsx:1821-1911.
// Adaptation: stock Chat reports the server call; Cloudflare's hook-specific suppression is absent.
// Upstream packages/ai-chat/src/react-tests/use-agent-chat.test.tsx:1821 — useAgentChat onToolCall > does not fire onToolCall for a server tool that is still executing (#2195).
it.live('stock Chat reports a server tool through onToolCall', () =>
  Effect.gen(function* () {
    const fixture = yield* host(
      {
        server: tool({
          inputSchema: z.object({}),
          execute: () => runForPi(Effect.succeed('Server result.'), undefined),
        }),
      },
      {},
    )
    const opened = yield* fixture.open()
    opened.faux.setResponses([call('server', {}, 'server'), fauxAssistantMessage('Done.')])
    const calls: string[] = []
    const chat = new PlainChat({
      transport: opened.transport,
      onToolCall: ({ toolCall }) => {
        calls.push(toolCall.toolCallId)
      },
    })
    yield* Effect.promise(() => chat.sendMessage({ text: 'Work' }))
    const message = chat.lastMessage
    if (message === undefined) throw new Error('Expected assistant')
    expect(texts(message)).toEqual(['Done.'])
    expect(calls).toEqual(['server'])
    expect(message.parts.find(isToolUIPart)).toMatchObject({
      state: 'output-available',
      output: 'Server result.',
    })
  }),
)
// Cloudflare packages/ai-chat/src/tests/client-tool-duplicate-message.test.ts:480-566;
// client-tools-continuation.test.ts:1799. Durable answers replace WebSocket result frames.
// Ports packages/ai-chat/src/tests/client-tool-duplicate-message.test.ts:480 — Client-side tool duplicate message prevention > waits for ALL parallel client-tool results before continuing (#1649).
// Cloudflare client-tool-duplicate-message.test.ts:568 — holds the barrier when a settled dynamic-tool sits beside a pending tool (#1649).
// Batch completion does not require correct dynamic UI identity; that separate producer gap remains.
it.live.each(['static', 'dynamic'] as const)(
  'waits for ALL parallel results with a %s first tool (#1649)',
  (kind) =>
    Effect.gen(function* () {
      const registration = { inputSchema: z.object({ question: z.string() }) }
      const first = kind === 'dynamic' ? dynamicTool(registration) : tool(registration)
      const fixture = yield* host({ ask: first, other: tool(registration) }, {})
      const opened = yield* fixture.open()
      opened.faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall('ask', { question: 'One?' }, { id: 'one' }),
            fauxToolCall('other', { question: 'Two?' }, { id: 'two' }),
          ],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('Both answered.'),
      ])
      const parked = yield* consumeReadable(
        yield* Effect.promise(() =>
          streamRun(
            opened.harness,
            { conversationId: opened.root.id, content: 'Ask twice', requestId: 'parallel' },
            context,
          ),
        ),
        Option.none(),
      )
      const resolved4 = yield* hold(opened.harness, opened.root.id, 'one', context)
      yield* Effect.promise(() =>
        answer(opened.harness, opened.root.id, { holdId: resolved4, output: 'First' }, context),
      )
      expect(
        yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context)),
      ).toMatchObject([{ callId: 'two', kind: 'answer' }])
      expect(opened.faux.state.callCount).toBe(1)
      const resolved5 = yield* hold(opened.harness, opened.root.id, 'two', context)
      yield* Effect.promise(() =>
        answer(opened.harness, opened.root.id, { holdId: resolved5, output: 'Second' }, context),
      )
      const result = yield* consumeReadable(
        yield* Effect.promise(() =>
          continueRun(
            opened.harness,
            opened.root.id,
            { messageId: parked.message.id, known: new Set(['one', 'two']) },
            context,
          ),
        ),
        Option.some(parked.message),
      )
      expect(result.message.parts.filter(isToolUIPart)).toMatchObject([
        { toolCallId: 'one', state: 'output-available', output: 'First' },
        { toolCallId: 'two', state: 'output-available', output: 'Second' },
      ])
      expect(texts(result.message)).toEqual(['Both answered.'])
      expect(opened.faux.state.callCount).toBe(2)
    }),
)
// Cloudflare packages/ai-chat/src/tests/client-tools-continuation.test.ts:822/982.
// Ports packages/think/src/tests/actions-durable-pause.test.ts:728 — resolving a durable pause drops pending-state generation (#2054) > keeps text in later steps that answer other tools.
it.live.each([
  {
    name: 'preserves reasoning-start before reasoning-delta during approval continuation (#1480)',
    kind: 'approval',
  },
  {
    name: 'persists reasoning during tool-result continuation without delayed chunks',
    kind: 'answer',
  },
] as const)('reasoning continuation: $name', ({ kind }) =>
  Effect.gen(function* () {
    const fixture = yield* shop()
    const opened = yield* fixture.open()
    const initial =
      kind === 'approval'
        ? fauxToolCall('pay', { amount: 100 }, { id: 'held' })
        : fauxToolCall('ask', { question: 'Which?' }, { id: 'held' })
    opened.faux.setResponses([
      fauxAssistantMessage([fauxThinking('Initial reasoning.'), initial], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage([
        fauxThinking('Continuation reasoning.'),
        { type: 'text', text: 'Done.' },
      ]),
    ])
    const parked = yield* consumeReadable(
      yield* Effect.promise(() =>
        streamRun(
          opened.harness,
          { conversationId: opened.root.id, content: 'Think', requestId: 'reasoning' },
          context,
        ),
      ),
      Option.none(),
    )
    const holdId = yield* hold(opened.harness, opened.root.id, 'held', context)
    if (kind === 'approval')
      yield* Effect.promise(() =>
        decide(opened.harness, opened.root.id, { holdId, approved: true }, context),
      )
    else
      yield* Effect.promise(() =>
        answer(opened.harness, opened.root.id, { holdId, output: 'Savings' }, context),
      )
    const continued = yield* consumeReadable(
      yield* Effect.promise(() =>
        continueRun(
          opened.harness,
          opened.root.id,
          { messageId: parked.message.id, known: new Set(['held']) },
          context,
        ),
      ),
      Option.some(parked.message),
    )
    const types = continued.chunks.map((chunk) => chunk.type)
    expect(types.indexOf('reasoning-start')).toBeGreaterThanOrEqual(0)
    expect(types.indexOf('reasoning-delta')).toBeGreaterThan(types.indexOf('reasoning-start'))
    expect(continued.message.parts.filter((part) => part.type === 'reasoning')).toMatchObject([
      { text: 'Initial reasoning.', state: 'done' },
      { text: 'Continuation reasoning.', state: 'done' },
    ])
    const saved = yield* Effect.promise(() =>
      history(opened.harness, opened.root.id, { limit: 10 }, context),
    )
    const message = saved.messages.at(-1)
    if (message === undefined) throw new Error('Expected stored assistant')
    expect(message.parts.filter((part) => part.type === 'reasoning')).toEqual(
      continued.message.parts.filter((part) => part.type === 'reasoning'),
    )
  }),
)
// Cloudflare packages/ai-chat/src/tests/streaming-message-id.test.ts:81-98:
// stamps the persisted assistant id onto a new turn's start chunk when the provider emits none.
// Generation attribution is shared by live, attachment and raw persisted history.
// Ports packages/ai-chat/src/tests/streaming-message-id.test.ts:81 — Streaming assistant message-id alignment > stamps the persisted assistant id onto a new turn's start chunk when the provider emits none.
it.live('stamps the persisted assistant id onto a new turn start chunk', () =>
  Effect.gen(function* () {
    const fixture = yield* host({}, {})
    const opened = yield* fixture.open()
    opened.faux.setResponses([fauxAssistantMessage('Hello.')])
    const result = yield* consumeReadable(
      yield* Effect.promise(() =>
        streamRun(
          opened.harness,
          { conversationId: opened.root.id, content: 'Hi', requestId: 'identity' },
          context,
        ),
      ),
      Option.none(),
    )
    const start = result.chunks.filter((chunk) => chunk.type === 'start')
    expect(start).toHaveLength(1)
    const saved = (yield* Effect.promise(() =>
      history(opened.harness, opened.root.id, { limit: 10 }, context),
    )).messages.find((message) => message.role === 'assistant')
    if (saved === undefined) throw new Error('Expected persisted assistant')
    expect(start[0]).toMatchObject({ messageId: saved.id })
    expect(result.message.id).toBe(saved.id)
  }),
)
// Cloudflare packages/ai-chat/src/tests/row-size-guard.test.ts:209/278:
// splits an oversized tool output losslessly; Unicode is measured in UTF-8 bytes.
// Port fidelity through SDK chunks and SQLite reopen; Cloudflare row splitting is private storage.
// Ports packages/ai-chat/src/tests/row-size-guard.test.ts:209 — Oversized rows and incremental persistence > Oversized rows offload losslessly > splits an oversized tool output across rows and reads it back byte-for-byte.
it.live.each([
  { name: 'ASCII', output: 'X'.repeat(1900000) },
  { name: 'Unicode', output: '一'.repeat(700000) },
])('restores oversized $name tool output byte-for-byte after reopen', ({ output }) =>
  Effect.gen(function* () {
    const fixture = yield* host(
      {
        huge: tool({
          inputSchema: z.object({}),
          execute: () => runForPi(Effect.succeed(output), undefined),
        }),
      },
      {},
    )
    const opened = yield* fixture.open()
    opened.faux.setResponses([call('huge', {}, 'huge'), fauxAssistantMessage('Stored.')])
    const result = yield* consumeReadable(
      yield* Effect.promise(() =>
        streamRun(
          opened.harness,
          { conversationId: opened.root.id, content: 'Store', requestId: 'huge' },
          context,
        ),
      ),
      Option.none(),
    )
    expect(result.message.parts.find(isToolUIPart)).toMatchObject({
      state: 'output-available',
      output,
    })
    yield* fixture.close(opened.harness)
    const restarted = yield* fixture.open()
    const saved = yield* Effect.promise(() =>
      history(restarted.harness, restarted.root.id, { limit: 10 }, context),
    )
    expect(saved.messages.flatMap((message) => message.parts).find(isToolUIPart)).toMatchObject({
      state: 'output-available',
      output,
    })
  }),
)
// Cloudflare packages/ai-chat/src/tests/message-builder.test.ts:16/31/73/86/111/122/133:
// text/reasoning start creates streaming parts, deltas append, and end marks each part done.
// Capture SDK snapshots, not private applyChunkToParts calls, to prove the producer/consumer boundary.
// Ports packages/ai-chat/src/tests/message-builder.test.ts:16 — applyChunkToParts > text chunks > text-start creates a streaming text part.
it.live('streams text and reasoning before closing their parts', () =>
  Effect.gen(function* () {
    const fixture = yield* host({}, {})
    const opened = yield* fixture.open()
    opened.faux.setResponses([
      fauxAssistantMessage([fauxThinking('Thinking.'), { type: 'text', text: 'Answer.' }]),
    ])
    const stream = yield* Effect.promise(() =>
      streamRun(
        opened.harness,
        { conversationId: opened.root.id, content: 'Think', requestId: 'progress' },
        context,
      ),
    )
    const snapshots: UIMessage[] = []
    {
      const iterator1 = readUIMessageStream({ stream })[Symbol.asyncIterator]()
      for (;;) {
        const next1 = yield* Effect.promise(() => iterator1.next())
        if (next1.done) break
        const message = next1.value
        snapshots.push(structuredClone(message))
      }
    }
    for (const type of ['reasoning', 'text']) {
      const parts = snapshots
        .flatMap((message) => message.parts)
        .filter((part) => part.type === type)
      expect(parts).toContainEqual(expect.objectContaining({ state: 'streaming', text: '' }))
      expect(parts).toContainEqual(
        expect.objectContaining({ state: 'streaming', text: expect.stringMatching(/.+/u) }),
      )
    }
    const final = snapshots.at(-1)
    if (final === undefined) throw new Error('Expected finished message')
    expect(final.parts).toHaveLength(3)
    expect(final.parts).toMatchObject([
      { type: 'step-start' },
      { type: 'reasoning', state: 'done', text: 'Thinking.' },
      { type: 'text', state: 'done', text: 'Answer.' },
    ])
  }),
)
