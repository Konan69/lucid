import {
  fauxAssistantMessage,
  fauxThinking,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { isToolUIPart, readUIMessageStream, tool, type UIMessage } from 'ai'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { Predicate } from 'effect'

import { PlainChat } from '../fixtures/chat.ts'
import {
  answer,
  CallNotWaiting,
  continueRun,
  decide,
  history,
  streamRun,
  waiting,
} from '../main.ts'
import { call, consume, context, hold, host, modelText, shop, texts } from './fixtures/host.ts'

// Cloudflare packages/think/src/tests/actions-durable-pause.test.ts:185/197.
// Ports packages/think/src/tests/actions-durable-pause.test.ts:185 — durable-pause actions > runs inline (no park) when the approval predicate returns false.
it.each([
  {
    name: 'runs inline (no park) when the approval predicate returns false',
    amount: 10,
    parked: false,
  },
  { name: 'parks when the approval predicate returns true', amount: 100, parked: true },
])('approval predicate: $name', async ({ amount, parked }) => {
  const executed: number[] = []
  const fixture = await host(
    {
      pay: tool({
        inputSchema: z.object({ amount: z.number() }),
        execute: async (input) => {
          executed.push(input.amount)
          return input.amount
        },
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
  const opened = await fixture.open()
  opened.faux.setResponses([call('pay', { amount }, 'pay'), fauxAssistantMessage('Paid.')])
  const result = await consume(
    await streamRun(
      opened.harness,
      { conversationId: opened.root.id, content: 'Pay', requestId: 'predicate' },
      context,
    ),
  )
  expect(executed).toEqual(parked ? [] : [amount])
  expect(await waiting(opened.harness, opened.root.id, context)).toHaveLength(parked ? 1 : 0)
  expect(result.message.parts.find(isToolUIPart)).toMatchObject({
    state: parked ? 'approval-requested' : 'output-available',
  })
})

// Cloudflare packages/think/src/tests/execute-hitl.test.ts:246.
// Ports packages/ai/src/ui/last-assistant-message-is-complete-with-approval-responses.test.ts:324 — lastAssistantMessageIsCompleteWithApprovalResponses > should only consider the last step in a multi-step message.
it('pause-again: the next gated call re-pauses; a second approve completes', async () => {
  const fixture = await shop()
  const opened = await fixture.open()
  opened.faux.setResponses([
    call('pay', { amount: 100 }, 'first'),
    call('pay', { amount: 200 }, 'second'),
    fauxAssistantMessage('Both paid.'),
  ])
  const first = await consume(
    await streamRun(
      opened.harness,
      { conversationId: opened.root.id, content: 'Pay twice', requestId: 'twice' },
      context,
    ),
  )
  await decide(
    opened.harness,
    opened.root.id,
    { holdId: await hold(opened.harness, opened.root.id, 'first'), approved: true },
    context,
  )
  const second = await consume(
    await continueRun(
      opened.harness,
      opened.root.id,
      { messageId: first.message.id, known: new Set(['first']) },
      context,
    ),
    first.message,
  )
  expect(fixture.paid).toEqual([100])
  expect(await waiting(opened.harness, opened.root.id, context)).toMatchObject([
    { callId: 'second', kind: 'approval' },
  ])
  await decide(
    opened.harness,
    opened.root.id,
    { holdId: await hold(opened.harness, opened.root.id, 'second'), approved: true },
    context,
  )
  const result = await consume(
    await continueRun(
      opened.harness,
      opened.root.id,
      { messageId: first.message.id, known: new Set(['first', 'second']) },
      context,
    ),
    second.message,
  )
  expect(result.message.id).toBe(first.message.id)
  expect(fixture.paid).toEqual([100, 200])
  expect(texts(result.message)).toEqual(['Both paid.'])
})

// Cloudflare packages/think/src/tests/actions-durable-pause.test.ts:132/149;
// execute-hitl.test.ts:297/325. Gap: settled decisions return the first durable value rather than an error.
// Ports packages/think/src/tests/execute-hitl.test.ts:297 — Think HITL — approve/reject paused executions > double-approve is graceful: the second returns an error and leaves the transcript alone.
it.fails.each([
  {
    name: 'errors on a second approve and never double-executes (claim-by-delete)',
    first: true,
    second: true,
  },
  { name: 'errors on approve-after-reject', first: false, second: true },
  {
    name: 'reject after approve is graceful: returns an error, never marks the run rejected',
    first: true,
    second: false,
  },
])('settled decision: $name', async ({ first, second }) => {
  const fixture = await shop()
  const opened = await fixture.open()
  opened.faux.setResponses([call('pay', { amount: 100 }, 'pay'), fauxAssistantMessage('Settled.')])
  await consume(
    await streamRun(
      opened.harness,
      { conversationId: opened.root.id, content: 'Pay', requestId: 'repeat' },
      context,
    ),
  )
  const holdId = await hold(opened.harness, opened.root.id, 'pay')
  await decide(opened.harness, opened.root.id, { holdId, approved: first }, context)
  await opened.root.waitForIdle(context)
  const before = await history(opened.harness, opened.root.id, { limit: 10 }, context)
  const repeat = await Promise.allSettled([
    decide(opened.harness, opened.root.id, { holdId, approved: second }, context),
  ])
  expect(await history(opened.harness, opened.root.id, { limit: 10 }, context)).toEqual(before)
  expect(fixture.paid).toEqual(first ? [100] : [])
  expect(repeat).toEqual([{ status: 'rejected', reason: expect.any(CallNotWaiting) }])
})

// Cloudflare packages/think/src/tests/actions-durable-pause.test.ts:624-665.
// Gap: Pi's immutable assistant entry retains post-pause text/reasoning; continuation sees it too.
// Ports packages/think/src/tests/actions-durable-pause.test.ts:624 — resolving a durable pause drops pending-state generation (#2054) > drops text and reasoning written after the paused part on approve.
it.fails.each([
  { name: 'drops text and reasoning written after the paused part on approve', approved: true },
  { name: 'drops text and reasoning written after the paused part on reject', approved: false },
])('post-pause content: $name', async ({ approved }) => {
  const fixture = await shop()
  const opened = await fixture.open()
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
  await consume(
    await streamRun(
      opened.harness,
      { conversationId: opened.root.id, content: 'Pay', requestId: 'pending' },
      context,
    ),
  )
  await decide(
    opened.harness,
    opened.root.id,
    { holdId: await hold(opened.harness, opened.root.id, 'pay'), approved },
    context,
  )
  await opened.root.waitForIdle(context)
  const saved = await history(opened.harness, opened.root.id, { limit: 10 }, context)
  expect(saved.messages.flatMap(texts)).toContain('Checking first.')
  expect(
    saved.messages.flatMap((message) => message.parts).filter((part) => part.type === 'reasoning'),
  ).toEqual([])
  expect(saved.messages.flatMap(texts)).not.toContain('Once approved, it runs.')
  expect(prompt).not.toContain('Once approved, it runs.')
})

// Cloudflare packages/agents/src/harness/pi/tests/harness.test.ts:144;
// packages/ai-chat/src/tests/message-concurrency.test.ts:923, queue policy only.
// Ports packages/agents/src/harness/pi/tests/harness.test.ts:144 — PiHarness on pi-durable > answers every one of many submissions made to one session at once.
it('answers every one of many submissions made to one session at once', async () => {
  const fixture = await host({}, {})
  const opened = await fixture.open()
  const inputs = ['one', 'two', 'three', 'four']
  opened.faux.setResponses(inputs.map((text) => fauxAssistantMessage(text)))
  const streams = []
  for (const content of inputs)
    streams.push(
      await streamRun(
        opened.harness,
        { conversationId: opened.root.id, content, requestId: content },
        context,
      ),
    )
  const results = await Promise.all(streams.map((stream) => consume(stream)))
  expect(results.map((result) => texts(result.message))).toEqual(inputs.map((text) => [text]))
  expect(new Set(results.map((result) => result.message.id)).size).toBe(inputs.length)
  expect(opened.faux.state.callCount).toBe(inputs.length)
  expect(
    (await history(opened.harness, opened.root.id, { limit: 20 }, context)).messages.map(texts),
  ).toEqual(inputs.flatMap((text) => [[text], [text]]))
})

// Cloudflare packages/agents/src/harness/pi/tests/harness.test.ts:196.
// Ports packages/agents/src/harness/pi/tests/harness.test.ts:196 — PiHarness on pi-durable > keeps sessions separate.
it('keeps sessions separate', async () => {
  const fixture = await host({}, {})
  const opened = await fixture.open()
  const other = await opened.harness.createConversation(
    { ownership: { kind: 'ownerless' }, agent: { model: { provider: 'faux', modelId: 'faux-1' } } },
    context,
  )
  opened.faux.setResponses([
    fauxAssistantMessage('Root only.'),
    fauxAssistantMessage('Other only.'),
  ])
  await consume(
    await streamRun(
      opened.harness,
      { conversationId: opened.root.id, content: 'Root', requestId: 'same' },
      context,
    ),
  )
  await consume(
    await streamRun(
      opened.harness,
      { conversationId: other.id, content: 'Other', requestId: 'same' },
      context,
    ),
  )
  expect(
    (await history(opened.harness, opened.root.id, { limit: 10 }, context)).messages.map(texts),
  ).toEqual([['Root'], ['Root only.']])
  expect(
    (await history(opened.harness, other.id, { limit: 10 }, context)).messages.map(texts),
  ).toEqual([['Other'], ['Other only.']])
})

// Cloudflare packages/ai-chat/src/react-tests/use-agent-chat.test.tsx:1821-1911.
// Gap: SDK onToolCall is invoked for server tools; the bridge does not mark them providerExecuted.
// Ports packages/ai-chat/src/react-tests/use-agent-chat.test.tsx:1821 — useAgentChat onToolCall > does not fire onToolCall for a server tool that is still executing (#2195).
it.fails('does not fire onToolCall for a server tool that is still executing (#2195)', async () => {
  const fixture = await host(
    { server: tool({ inputSchema: z.object({}), execute: async () => 'Server result.' }) },
    {},
  )
  const opened = await fixture.open()
  opened.faux.setResponses([call('server', {}, 'server'), fauxAssistantMessage('Done.')])
  const calls: string[] = []
  const chat = new PlainChat({
    transport: opened.transport,
    onToolCall: ({ toolCall }) => {
      calls.push(toolCall.toolCallId)
    },
  })
  await chat.sendMessage({ text: 'Work' })
  const message = chat.lastMessage
  if (message === undefined) throw new Error('Expected assistant')
  expect(texts(message)).toEqual(['Done.'])
  expect(calls).toEqual([])
})

// Cloudflare packages/ai-chat/src/tests/client-tool-duplicate-message.test.ts:480-566;
// client-tools-continuation.test.ts:1799. Durable answers replace WebSocket result frames.
// Ports packages/ai-chat/src/tests/client-tool-duplicate-message.test.ts:480 — Client-side tool duplicate message prevention > waits for ALL parallel client-tool results before continuing (#1649).
it('waits for ALL parallel client-tool results before continuing (#1649)', async () => {
  const fixture = await shop()
  const opened = await fixture.open()
  opened.faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall('ask', { question: 'One?' }, { id: 'one' }),
        fauxToolCall('ask', { question: 'Two?' }, { id: 'two' }),
      ],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('Both answered.'),
  ])
  const parked = await consume(
    await streamRun(
      opened.harness,
      { conversationId: opened.root.id, content: 'Ask twice', requestId: 'parallel' },
      context,
    ),
  )
  await answer(
    opened.harness,
    opened.root.id,
    { holdId: await hold(opened.harness, opened.root.id, 'one'), output: 'First' },
    context,
  )
  expect(await waiting(opened.harness, opened.root.id, context)).toMatchObject([
    { callId: 'two', kind: 'answer' },
  ])
  expect(opened.faux.state.callCount).toBe(1)
  await answer(
    opened.harness,
    opened.root.id,
    { holdId: await hold(opened.harness, opened.root.id, 'two'), output: 'Second' },
    context,
  )
  const result = await consume(
    await continueRun(
      opened.harness,
      opened.root.id,
      { messageId: parked.message.id, known: new Set(['one', 'two']) },
      context,
    ),
    parked.message,
  )
  expect(result.message.parts.filter(isToolUIPart)).toMatchObject([
    { toolCallId: 'one', state: 'output-available', output: 'First' },
    { toolCallId: 'two', state: 'output-available', output: 'Second' },
  ])
  expect(texts(result.message)).toEqual(['Both answered.'])
  expect(opened.faux.state.callCount).toBe(2)
})

// Cloudflare packages/ai-chat/src/tests/client-tools-continuation.test.ts:822/982.
// Ports packages/think/src/tests/actions-durable-pause.test.ts:728 — resolving a durable pause drops pending-state generation (#2054) > keeps text in later steps that answer other tools.
it.each([
  {
    name: 'preserves reasoning-start before reasoning-delta during approval continuation (#1480)',
    kind: 'approval',
  },
  {
    name: 'persists reasoning during tool-result continuation without delayed chunks',
    kind: 'answer',
  },
] as const)('reasoning continuation: $name', async ({ kind }) => {
  const fixture = await shop()
  const opened = await fixture.open()
  const initial =
    kind === 'approval'
      ? fauxToolCall('pay', { amount: 100 }, { id: 'held' })
      : fauxToolCall('ask', { question: 'Which?' }, { id: 'held' })
  opened.faux.setResponses([
    fauxAssistantMessage([fauxThinking('Initial reasoning.'), initial], { stopReason: 'toolUse' }),
    fauxAssistantMessage([
      fauxThinking('Continuation reasoning.'),
      { type: 'text', text: 'Done.' },
    ]),
  ])
  const parked = await consume(
    await streamRun(
      opened.harness,
      { conversationId: opened.root.id, content: 'Think', requestId: 'reasoning' },
      context,
    ),
  )
  const holdId = await hold(opened.harness, opened.root.id, 'held')
  if (kind === 'approval')
    await decide(opened.harness, opened.root.id, { holdId, approved: true }, context)
  else await answer(opened.harness, opened.root.id, { holdId, output: 'Savings' }, context)
  const continued = await consume(
    await continueRun(
      opened.harness,
      opened.root.id,
      { messageId: parked.message.id, known: new Set(['held']) },
      context,
    ),
    parked.message,
  )
  const types = continued.chunks.map((chunk) => chunk.type)
  expect(types.indexOf('reasoning-start')).toBeGreaterThanOrEqual(0)
  expect(types.indexOf('reasoning-delta')).toBeGreaterThan(types.indexOf('reasoning-start'))
  expect(continued.message.parts.filter((part) => part.type === 'reasoning')).toMatchObject([
    { text: 'Initial reasoning.', state: 'done' },
    { text: 'Continuation reasoning.', state: 'done' },
  ])
  const saved = await history(opened.harness, opened.root.id, { limit: 10 }, context)
  const message = saved.messages.at(-1)
  if (message === undefined) throw new Error('Expected stored assistant')
  expect(message.parts.filter((part) => part.type === 'reasoning')).toEqual(
    continued.message.parts.filter((part) => part.type === 'reasoning'),
  )
})

// Cloudflare packages/ai-chat/src/tests/streaming-message-id.test.ts:81-98:
// stamps the persisted assistant id onto a new turn's start chunk when the provider emits none.
// Gap: live messages use run:<task> while settled history uses entry:<number>, so IDs cannot reconcile.
// Ports packages/ai-chat/src/tests/streaming-message-id.test.ts:81 — Streaming assistant message-id alignment > stamps the persisted assistant id onto a new turn's start chunk when the provider emits none.
it.fails('stamps the persisted assistant id onto a new turn start chunk', async () => {
  const fixture = await host({}, {})
  const opened = await fixture.open()
  opened.faux.setResponses([fauxAssistantMessage('Hello.')])
  const result = await consume(
    await streamRun(
      opened.harness,
      { conversationId: opened.root.id, content: 'Hi', requestId: 'identity' },
      context,
    ),
  )
  const start = result.chunks.filter((chunk) => chunk.type === 'start')
  expect(start).toHaveLength(1)
  const saved = (
    await history(opened.harness, opened.root.id, { limit: 10 }, context)
  ).messages.find((message) => message.role === 'assistant')
  if (saved === undefined) throw new Error('Expected persisted assistant')
  expect(start[0]).toMatchObject({ messageId: saved.id })
  expect(result.message.id).toBe(saved.id)
})

// Cloudflare packages/ai-chat/src/tests/row-size-guard.test.ts:209/278:
// splits an oversized tool output losslessly; Unicode is measured in UTF-8 bytes.
// Port fidelity through SDK chunks and SQLite reopen; Cloudflare row splitting is private storage.
// Ports packages/ai-chat/src/tests/row-size-guard.test.ts:209 — Oversized rows and incremental persistence > Oversized rows offload losslessly > splits an oversized tool output across rows and reads it back byte-for-byte.
it.each([
  { name: 'ASCII', output: 'X'.repeat(1_900_000) },
  { name: 'Unicode', output: '一'.repeat(700_000) },
])('restores oversized $name tool output byte-for-byte after reopen', async ({ output }) => {
  const fixture = await host(
    { huge: tool({ inputSchema: z.object({}), execute: async () => output }) },
    {},
  )
  const opened = await fixture.open()
  opened.faux.setResponses([call('huge', {}, 'huge'), fauxAssistantMessage('Stored.')])
  const result = await consume(
    await streamRun(
      opened.harness,
      { conversationId: opened.root.id, content: 'Store', requestId: 'huge' },
      context,
    ),
  )
  expect(result.message.parts.find(isToolUIPart)).toMatchObject({
    state: 'output-available',
    output,
  })
  await fixture.close(opened.harness)
  const restarted = await fixture.open()
  const saved = await history(restarted.harness, restarted.root.id, { limit: 10 }, context)
  expect(saved.messages.flatMap((message) => message.parts).find(isToolUIPart)).toMatchObject({
    state: 'output-available',
    output,
  })
})

// Cloudflare packages/ai-chat/src/tests/message-builder.test.ts:16/31/73/86/111/122/133:
// text/reasoning start creates streaming parts, deltas append, and end marks each part done.
// Capture SDK snapshots, not private applyChunkToParts calls, to prove the producer/consumer boundary.
// Ports packages/ai-chat/src/tests/message-builder.test.ts:16 — applyChunkToParts > text chunks > text-start creates a streaming text part.
it('streams text and reasoning before closing their parts', async () => {
  const fixture = await host({}, {})
  const opened = await fixture.open()
  opened.faux.setResponses([
    fauxAssistantMessage([fauxThinking('Thinking.'), { type: 'text', text: 'Answer.' }]),
  ])
  const stream = await streamRun(
    opened.harness,
    { conversationId: opened.root.id, content: 'Think', requestId: 'progress' },
    context,
  )
  const snapshots: UIMessage[] = []
  for await (const message of readUIMessageStream({ stream }))
    snapshots.push(structuredClone(message))
  for (const type of ['reasoning', 'text']) {
    const parts = snapshots.flatMap((message) => message.parts).filter((part) => part.type === type)
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
})
