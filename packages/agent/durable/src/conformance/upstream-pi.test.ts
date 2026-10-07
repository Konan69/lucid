import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { Type } from '@earendil-works/pi-ai'
import {
  defineExtension,
  defineTool,
  GenerationTask,
  hook,
  ToolTask,
} from '@earendil-works/pi-durable'
import { DefaultChatTransport, isToolUIPart, tool, type UIMessage, type UIMessageChunk } from 'ai'
import { expect, it, onTestFinished } from 'vitest'
import { Predicate } from 'effect'
import * as NodeEvents from 'node:events'
import { z } from 'zod'

import { abort, attachRun, history, respond, streamRun, waiting } from '../main.ts'
import { call, consume, context, host, modelText, signal, texts } from './fixtures/host.ts'
import { interrupt } from './fixtures/upstream.ts'

// Pi packages/durable/test/harness-generation.test.ts:206/219/254.
// Preserve the error at the SDK wire boundary rather than asserting Pi's private retry ledger.
// Ports packages/durable/test/harness-generation.test.ts:206 — generation > fails with model_error once retries are exhausted.
it.each([
  {
    name: 'fails with model_error once retries are exhausted',
    retry: { maxRetries: 1 },
    error: '503 Service Unavailable',
    calls: 2,
  },
  {
    name: 'fails a retryable error without retrying when the retry policy is disabled',
    retry: { enabled: false },
    error: '503 Service Unavailable',
    calls: 1,
  },
  {
    name: 'fails a non-retryable error without retrying',
    retry: { maxRetries: 3 },
    error: 'Invalid request',
    calls: 1,
  },
])('$name', async ({ retry, error, calls }) => {
  const fixture = await host({}, {}, { retry: { ...retry, baseDelayMs: 0 } })
  const opened = await fixture.open()
  opened.faux.setResponses([
    fauxAssistantMessage('Discard.', { stopReason: 'error', errorMessage: error }),
    fauxAssistantMessage('Discard again.', { stopReason: 'error', errorMessage: error }),
    fauxAssistantMessage('Never.'),
  ])
  const chunks: UIMessageChunk[] = []
  const stream = await opened.transport.sendMessages({
    trigger: 'submit-message',
    chatId: 'failure',
    messageId: undefined,
    messages: [{ id: 'failure', role: 'user', parts: [{ type: 'text', text: 'Try' }] }],
    abortSignal: undefined,
  })
  // The SDK decoder validates SSE as it does for Chat; readUIMessageStream is covered elsewhere.
  for await (const chunk of stream) chunks.push(chunk)
  expect(chunks.filter((chunk) => chunk.type === 'error')).toEqual([
    { type: 'error', errorText: error },
  ])
  expect(chunks.at(-1)).toMatchObject({ type: 'finish' })
  expect(opened.faux.state.callCount).toBe(calls)
  expect(opened.faux.getPendingResponseCount()).toBe(3 - calls)
})

// Pi packages/durable/test/harness-generation.test.ts:162, no configured/unknown model.
// Ports packages/durable/test/harness-generation.test.ts:162 — generation > fails with no_model when no model is configured or the model is unknown.
it('fails with no_model when no model is configured or the model is unknown', async () => {
  const fixture = await host({}, {})
  const opened = await fixture.open()
  const unset = await opened.harness.createConversation(
    { ownership: { kind: 'ownerless' } },
    context,
  )
  const unsetStream = await new DefaultChatTransport<UIMessage>({
    api: 'http://durable.test/chat',
    fetch: async (url, init) => respond(opened.harness, unset.id, new Request(url, init), context),
  }).sendMessages({
    trigger: 'submit-message',
    chatId: 'unset',
    messageId: undefined,
    messages: [{ id: 'unset', role: 'user', parts: [{ type: 'text', text: 'Try' }] }],
    abortSignal: undefined,
  })
  for await (const chunk of unsetStream) expect(chunk.type).not.toBe('error')
  const unsetReceipt = await unset.submit(
    { type: 'input', content: 'Try', requestId: 'unset' },
    context,
  )
  expect(await unsetReceipt.status(context)).toMatchObject({
    status: 'unanswered',
    reason: 'no_model',
  })
  expect(await waiting(opened.harness, unset.id, context)).toEqual([])
  await opened.root.configure({ model: { provider: 'faux', modelId: 'missing' } }, context)
  const chunks: UIMessageChunk[] = []
  for await (const chunk of await opened.transport.sendMessages({
    trigger: 'submit-message',
    chatId: 'missing',
    messageId: undefined,
    messages: [{ id: 'missing', role: 'user', parts: [{ type: 'text', text: 'Try' }] }],
    abortSignal: undefined,
  }))
    chunks.push(chunk)
  const receipt = await opened.root.submit(
    { type: 'input', content: 'Try', requestId: 'missing' },
    context,
  )
  expect(await receipt.status(context)).toMatchObject({ status: 'unanswered', reason: 'no_model' })
  expect(chunks.at(-1)).toMatchObject({ type: 'finish' })
  expect(opened.faux.state.callCount).toBe(0)
  expect(await waiting(opened.harness, opened.root.id, context)).toEqual([])
})

// Pi packages/durable/test/harness-tools.test.ts:114.
// Ports packages/durable/test/harness-tools.test.ts:114 — tool round > answers calls to tools the request did not offer without a task.
it('answers calls to tools the request did not offer without a task', async () => {
  let executions = 0
  let prompt = ''
  const fixture = await host(
    {
      echo: tool({
        inputSchema: z.object({}),
        execute: async () => {
          executions++
          return 'Echo.'
        },
      }),
    },
    {},
  )
  const opened = await fixture.open()
  opened.faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall('ghost', {}, { id: 'ghost' }), fauxToolCall('echo', {}, { id: 'echo' })],
      { stopReason: 'toolUse' },
    ),
    (request) => {
      prompt = modelText(request.messages)
      return fauxAssistantMessage('Done.')
    },
  ])
  const result = await consume(
    await streamRun(
      opened.harness,
      { conversationId: opened.root.id, content: 'Try', requestId: 'ghost' },
      context,
    ),
  )
  expect(prompt).toContain('Tool ghost is not available')
  expect(executions).toBe(1)
  expect(texts(result.message)).toEqual(['Done.'])
  expect(await waiting(opened.harness, opened.root.id, context)).toEqual([])
})

// Pi packages/durable/test/harness-tools.test.ts:390; turns a throw into a tool_error result with the partial output.
// Exercise native progress and SDK execute together: both errors must reach the actual model and SDK.
// Ports packages/ai/src/ui/process-ui-message-stream.test.ts:2655 — processUIMessageStream > server-side tool roundtrip with output-error > should have the correct final message state.
it('turns a throw into a tool_error result with the partial output', async () => {
  let prompt = ''
  const fixture = await host(
    {
      fail: tool({
        inputSchema: z.object({}),
        execute: async (): Promise<string> => {
          throw new Error('boom')
        },
      }),
    },
    {},
  )
  const opened = await fixture.open([
    defineExtension({
      name: 'native-progress',
      tools: [
        defineTool({
          name: 'nativeFail',
          description: 'Fail after writing partial output',
          parameters: Type.Object({}),
          executionMode: 'parallel',
          execute: async (_args, api) => {
            api.output('partial\n')
            throw new Error('boom')
          },
        }),
      ],
    }),
  ])
  opened.faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall('fail', {}, { id: 'fail' }), fauxToolCall('nativeFail', {}, { id: 'native' })],
      { stopReason: 'toolUse' },
    ),
    (request) => {
      prompt = modelText(request.messages)
      return fauxAssistantMessage('Recovered.')
    },
  ])
  const result = await consume(
    await streamRun(
      opened.harness,
      { conversationId: opened.root.id, content: 'Try', requestId: 'throw' },
      context,
    ),
  )
  expect(
    result.message.parts.find((part) => 'toolCallId' in part && part.toolCallId === 'fail'),
  ).toMatchObject({ state: 'output-error', errorText: expect.stringContaining('boom') })
  expect(
    result.message.parts.find((part) => 'toolCallId' in part && part.toolCallId === 'native'),
  ).toMatchObject({ state: 'output-error', errorText: expect.stringContaining('partial\n') })
  expect(prompt).toContain('partial\n')
  expect(prompt).toContain('boom')
  expect(texts(result.message)).toEqual(['Recovered.'])
})

// Pi packages/durable/test/harness-tools.test.ts:486.
// Ports packages/durable/test/harness-tools.test.ts:486 — tool results > lets the first beforeTool block win and skips later handlers.
it('lets the first beforeTool block win and skips later handlers', async () => {
  const seen: string[] = []
  let executions = 0
  const fixture = await host(
    {
      echo: tool({
        inputSchema: z.object({}),
        execute: async () => {
          executions++
          return 'Echo.'
        },
      }),
    },
    {},
  )
  const opened = await fixture.open([
    defineExtension({
      name: 'first',
      hooks: [
        hook(ToolTask, {
          beforeTool: () => {
            seen.push('first')
            return { block: 'first says no' }
          },
        }),
      ],
    }),
    defineExtension({
      name: 'second',
      hooks: [
        hook(ToolTask, {
          beforeTool: () => {
            seen.push('second')
            return { block: 'second says no' }
          },
        }),
      ],
    }),
  ])
  opened.faux.setResponses([call('echo', {}, 'echo'), fauxAssistantMessage('Blocked.')])
  const result = await consume(
    await streamRun(
      opened.harness,
      { conversationId: opened.root.id, content: 'Try', requestId: 'block' },
      context,
    ),
  )
  expect(seen).toEqual(['first'])
  expect(executions).toBe(0)
  expect(result.message.parts.find((part) => 'toolCallId' in part)).toMatchObject({
    state: 'output-error',
    errorText: expect.stringContaining('first says no'),
  })
})

// Pi packages/durable/test/harness-submissions.test.ts:82.
// Ports packages/durable/test/harness-submissions.test.ts:82 — submissions > deduplicates request IDs per conversation before any write.
it('deduplicates request IDs per conversation before any write', async () => {
  const fixture = await host({}, {})
  const opened = await fixture.open()
  opened.faux.setResponses([fauxAssistantMessage('Root.'), fauxAssistantMessage('Other.')])
  const input = { conversationId: opened.root.id, content: 'Root', requestId: 'same' }
  const first = await consume(await streamRun(opened.harness, input, context))
  const repeated = await opened.root.submit(
    { type: 'input', content: 'Changed', requestId: 'same' },
    context,
  )
  expect(await repeated.status(context)).toMatchObject({ status: 'done', requestId: 'same' })
  expect(texts(first.message)).toEqual(['Root.'])
  const other = await opened.harness.createConversation(
    { ownership: { kind: 'ownerless' }, agent: { model: { provider: 'faux', modelId: 'faux-1' } } },
    context,
  )
  const second = await consume(
    await streamRun(
      opened.harness,
      { ...input, conversationId: other.id, content: 'Other' },
      context,
    ),
  )
  expect(texts(second.message)).toEqual(['Other.'])
  expect(opened.faux.state.callCount).toBe(2)
  expect(
    (await history(opened.harness, opened.root.id, { limit: 10 }, context)).messages,
  ).toHaveLength(2)
  expect((await history(opened.harness, other.id, { limit: 10 }, context)).messages).toHaveLength(2)
})

// Pi packages/durable/test/harness-inbox.test.ts:431.
// A clean restart uses no provider timing: park in a durable approval, then preserve a queued input.
// Ports packages/durable/test/harness-inbox.test.ts:431 — inbox > keeps queued submissions across reopen and settles them afterwards.
it('keeps queued submissions across reopen and settles them afterwards', async () => {
  const entered = signal()
  const release = signal()
  const fixture = await host(
    {
      gate: tool({
        inputSchema: z.object({}),
        execute: async () => {
          entered.resolve()
          await release.promise
          return 'Released.'
        },
      }),
    },
    { replay: { gate: 'safe' } },
  )
  const opened = await fixture.open()
  opened.faux.setResponses([call('gate', {}, 'gate')])
  const first = await streamRun(
    opened.harness,
    { conversationId: opened.root.id, content: 'First', requestId: 'first' },
    context,
  )
  await entered.promise
  const queued = await opened.root.submit(
    { type: 'input', content: 'Queued', requestId: 'queued', whenBusy: 'followUp' },
    context,
  )
  expect((await queued.status(context)).status).toBe('queued')
  // Harness.close joins non-cancellable execute callbacks; release that callback before awaiting it.
  const closing = fixture.close(opened.harness)
  release.resolve()
  await closing
  await first.cancel()
  const restarted = await fixture.open()
  restarted.faux.setResponses([
    fauxAssistantMessage('First done.'),
    fauxAssistantMessage('Queued done.'),
  ])
  const result = await consume(
    await streamRun(
      restarted.harness,
      { conversationId: restarted.root.id, content: 'Queued', requestId: 'queued' },
      context,
    ),
  )
  expect(texts(result.message)).toEqual(['Queued done.'])
  expect(
    (await history(restarted.harness, restarted.root.id, { limit: 10 }, context)).messages
      .filter((message) => message.role === 'user')
      .map(texts),
  ).toEqual([['First'], ['Queued']])
})

// Pi packages/durable/test/harness-generation-recovery.test.ts:270.
// Ports packages/durable/test/harness-submissions.test.ts:178 — submissions > reacquires a submission after reopen and settles it durably.
it('runs a print-style turn and reads the durable answer after reopen', async () => {
  const fixture = await host({}, {})
  const opened = await fixture.open()
  opened.faux.setResponses([fauxAssistantMessage('Durable answer.')])
  const result = await consume(
    await streamRun(
      opened.harness,
      { conversationId: opened.root.id, content: 'Answer', requestId: 'answer' },
      context,
    ),
  )
  await fixture.close(opened.harness)
  const restarted = await fixture.open()
  const saved = await history(restarted.harness, restarted.root.id, { limit: 10 }, context)
  const message = saved.messages.at(-1)
  if (message === undefined) throw new Error('Expected stored assistant')
  expect(message.parts).toEqual(result.message.parts)
  expect(restarted.faux.state.callCount).toBe(0)
})

// Pi packages/durable/test/harness-tools.test.ts:407-450.
// Ports packages/durable/test/harness-tools.test.ts:407 — tool results > validates arguments before and after beforeTool and applies blocks and replacements.
it('validates arguments before and after beforeTool and applies blocks and replacements', async () => {
  const seen: string[] = []
  const fixture = await host(
    {
      echo: tool({
        inputSchema: z.object({ text: z.string().optional() }),
        execute: async (input) => {
          if (input.text !== undefined) seen.push(input.text)
          return 'Echo.'
        },
      }),
    },
    {},
  )
  const opened = await fixture.open([
    defineExtension({
      name: 'validation',
      hooks: [
        hook(ToolTask, {
          beforeTool: (given) => {
            if (given.id === 'block') return { block: 'not today' }
            if (given.id === 'throw') throw new Error('hook failed')
            if (given.id === 'bad') return { arguments: { text: { invalid: true } } }
            const text = given.arguments.text
            if (!Predicate.isString(text)) throw new Error('Expected validated text')
            return { arguments: { text: text + '!' } }
          },
        }),
      ],
    }),
  ])
  opened.faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall('echo', { text: 1 }, { id: 'coerced' }),
        fauxToolCall('echo', { text: { invalid: true } }, { id: 'invalid' }),
        fauxToolCall('echo', {}, { id: 'block' }),
        fauxToolCall('echo', {}, { id: 'throw' }),
        fauxToolCall('echo', { text: 'x' }, { id: 'bad' }),
        fauxToolCall('echo', { text: 'x' }, { id: 'ok' }),
      ],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('Done.'),
  ])
  const result = await consume(
    await streamRun(
      opened.harness,
      { conversationId: opened.root.id, content: 'Try', requestId: 'validate' },
      context,
    ),
  )
  expect(seen.toSorted()).toEqual(['1!', 'x!'])
  const failed = result.message.parts.filter(
    (part) => 'state' in part && part.state === 'output-error',
  )
  expect(failed).toHaveLength(4)
  expect(failed).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        toolCallId: 'block',
        errorText: expect.stringContaining('not today'),
      }),
      expect.objectContaining({
        toolCallId: 'throw',
        errorText: expect.stringContaining('hook failed'),
      }),
      expect.objectContaining({
        toolCallId: 'bad',
        errorText: expect.stringContaining('Validation failed'),
      }),
      expect.objectContaining({
        toolCallId: 'invalid',
        errorText: expect.stringContaining('Validation failed'),
      }),
    ]),
  )
})

// Pi packages/durable/test/harness-tools.test.ts:511-534.
// Ports packages/durable/test/harness-tools.test.ts:511 — tool results > chains afterTool replacements and observes the round with afterTools.
it('chains afterTool replacements and observes the round with afterTools', async () => {
  const observed: number[][] = []
  let prompt = ''
  const fixture = await host(
    { echo: tool({ inputSchema: z.object({}), execute: async () => 'raw' }) },
    {},
  )
  const opened = await fixture.open([
    defineExtension({
      name: 'replace',
      hooks: [
        hook(ToolTask, {
          afterTool: (_call, result) => ({ ...result, content: [{ type: 'text', text: 'first' }] }),
        }),
      ],
    }),
    defineExtension({
      name: 'details',
      hooks: [
        hook(ToolTask, {
          afterTool: (_call, result) => {
            const content = result.content
            if (content === undefined) throw new Error('Expected replaced content')
            return {
              ...result,
              details: {
                replaced: content
                  .flatMap((part) => (part.type === 'text' ? [part.text] : []))
                  .join(''),
              },
            }
          },
        }),
      ],
    }),
    defineExtension({
      name: 'round',
      hooks: [
        hook(GenerationTask, {
          afterTools: (_assistant, entries) => {
            observed.push([...entries])
          },
        }),
      ],
    }),
  ])
  opened.faux.setResponses([
    call('echo', {}, 'echo'),
    (request) => {
      prompt = modelText(request.messages)
      return fauxAssistantMessage('Done.')
    },
  ])
  const result = await consume(
    await streamRun(
      opened.harness,
      { conversationId: opened.root.id, content: 'Try', requestId: 'replace' },
      context,
    ),
  )
  expect(result.message.parts.find((part) => 'toolCallId' in part)).toMatchObject({
    state: 'output-available',
    output: { content: [{ type: 'text', text: 'first' }], details: { replaced: 'first' } },
  })
  expect(observed).toHaveLength(1)
  expect(observed[0]).toHaveLength(1)
  expect(prompt).toContain('first')
  expect(prompt).not.toContain('raw')
})

// Pi packages/durable/test/harness-tools-recovery.test.ts:136-162.
// The original port covers safe/safe; add both mismatches, which must forbid replay.
// Ports packages/durable/test/harness-tools-recovery.test.ts:136 — tool recovery > reruns a tool only when both the stored and the current replay policy are safe.
it.each([
  { stored: 'safe', current: 'unsafe' },
  { stored: 'unsafe', current: 'safe' },
] as const)(
  'does not replay a $stored tool reopened with $current policy',
  async ({ stored, current }) => {
    let executions = 0
    const fixture = await host(
      {
        work: tool({
          inputSchema: z.object({}),
          execute: async () => {
            executions++
            return 'Replayed.'
          },
        }),
      },
      { replay: { work: current } },
    )
    await interrupt(fixture.file, stored)
    const opened = await fixture.open()
    opened.faux.setResponses([fauxAssistantMessage('Interrupted safely.')])
    const attached = await attachRun(opened.harness, opened.root.id, context)
    if (attached.status === 'idle') throw new Error('Expected interrupted run')
    opened.harness.resume()
    const result = await consume(attached.stream)
    expect(executions).toBe(0)
    expect(result.message.parts.find((part) => 'toolCallId' in part)).toMatchObject({
      state: 'output-error',
      errorText: expect.stringContaining('was interrupted and may have partially run'),
    })
    expect(texts(result.message)).toEqual(['Interrupted safely.'])
  },
)

// Pi packages/durable/test/harness-inbox.test.ts:145-167.
// Ports packages/durable/test/harness-inbox.test.ts:145 — inbox > places every follow-up in one successor run with followUpMode all.
it('places every follow-up in one successor run with followUpMode all', async () => {
  const fixture = await host({}, {}, { followUpMode: 'all' })
  const opened = await fixture.open()
  const entered = signal()
  const released = signal()
  const queued = signal()
  const observers = signal()
  onTestFinished(() => released.resolve())
  onTestFinished(() => observers.resolve())
  const requestIds = new Set<string>()
  const unsubscribe = opened.harness.subscribeCommits((publication) => {
    for (const change of publication.changes)
      if (
        change.type === 'submission' &&
        change.value.status === 'queued' &&
        (change.value.requestId === 'second' || change.value.requestId === 'third')
      )
        requestIds.add(change.value.requestId)
    if (requestIds.size === 2) queued.resolve()
  })
  onTestFinished(unsubscribe)
  let prompt = ''
  opened.faux.setResponses([
    async () => {
      entered.resolve()
      await released.promise
      return fauxAssistantMessage('First.')
    },
    async (request) => {
      await observers.promise
      prompt = modelText(request.messages)
      return fauxAssistantMessage('All follow-ups.')
    },
  ])
  const first = await streamRun(
    opened.harness,
    { conversationId: opened.root.id, content: 'First', requestId: 'first' },
    context,
  )
  await entered.promise
  const second = streamRun(
    opened.harness,
    { conversationId: opened.root.id, content: 'Second', requestId: 'second' },
    context,
  )
  const third = streamRun(
    opened.harness,
    { conversationId: opened.root.id, content: 'Third', requestId: 'third' },
    context,
  )
  // Admission now waits for each queued receipt; start both requests before releasing the boundary.
  await queued.promise
  released.resolve()
  const attached = await Promise.all([second, third])
  observers.resolve()
  const results = await Promise.all([consume(first), ...attached.map((stream) => consume(stream))])
  expect(results.map((result) => texts(result.message))).toEqual([
    ['First.'],
    ['All follow-ups.'],
    ['All follow-ups.'],
  ])
  const [, secondResult, thirdResult] = results
  if (secondResult === undefined || thirdResult === undefined)
    throw new Error('Expected follow-up streams')
  expect(secondResult.message.id).toBe(thirdResult.message.id)
  expect(opened.faux.state.callCount).toBe(2)
  expect(prompt).toContain('Second')
  expect(prompt).toContain('Third')
})

// Pi packages/durable/test/harness-structured.test.ts:1041/1061:
// aborts a parallel round with every result written; answers unstarted sequential calls in call order.
// The actual SDK execute waits on its supplied cancellation signal, never on a clock.
// Ports packages/durable/test/harness-structured.test.ts:1041 — tool rounds > aborts a parallel round with its generation: tools first, then the generation, with every result written.
it.each(['parallel', 'sequential'] as const)(
  'aborts a %s tool round with ordered durable results',
  async (execution) => {
    const started = signal()
    let executions = 0
    const fixture = await host(
      {
        wait: tool({
          inputSchema: z.object({}),
          execute: async (_input, options) => {
            const abortSignal = options.abortSignal
            if (abortSignal === undefined) throw new Error('Expected execution cancellation signal')
            executions++
            if (executions === (execution === 'parallel' ? 2 : 1)) started.resolve()
            if (!abortSignal.aborted) await NodeEvents.EventEmitter.once(abortSignal, 'abort')
            return 'Cancelled.'
          },
        }),
      },
      { execution },
      { toolExecution: execution },
    )
    const opened = await fixture.open()
    opened.faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('wait', {}, { id: 'c1' }), fauxToolCall('wait', {}, { id: 'c2' })],
        { stopReason: 'toolUse' },
      ),
    ])
    const collecting = consume(
      await streamRun(
        opened.harness,
        { conversationId: opened.root.id, content: 'Wait', requestId: 'abort' },
        context,
      ),
    )
    await started.promise
    await abort(opened.harness, opened.root.id, context)
    const result = await collecting
    expect(executions).toBe(execution === 'parallel' ? 2 : 1)
    expect(result.message.parts.filter(isToolUIPart)).toMatchObject([
      { toolCallId: 'c1', state: 'output-error' },
      { toolCallId: 'c2', state: 'output-error' },
    ])
    // Pi's case asserts the submission outcome, not an SDK abort chunk from a model invocation.
    const receipt = await opened.root.submit(
      { type: 'input', content: 'Wait', requestId: 'abort' },
      context,
    )
    expect(await receipt.status(context)).toMatchObject({ status: 'unanswered', reason: 'aborted' })
    expect(result.chunks.at(-1)).toMatchObject({ type: 'finish' })
    const saved = await history(opened.harness, opened.root.id, { limit: 10 }, context)
    expect(saved.messages.flatMap((message) => message.parts).filter(isToolUIPart)).toEqual(
      result.message.parts.filter(isToolUIPart),
    )
    expect(await waiting(opened.harness, opened.root.id, context)).toEqual([])
    expect(await attachRun(opened.harness, opened.root.id, context)).toEqual({ status: 'idle' })
  },
)
