import { Deferred, Effect, Option, Fiber } from 'effect'
import { FixtureFailed } from '../fixtures/harness.ts'
import { consumeReadable } from '../fixtures/reading.ts'
import { runForPi } from '../pi.ts'
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
import { expect, it } from '@effect/vitest'
import { Predicate } from 'effect'
import * as NodeEvents from 'node:events'
import { z } from 'zod'
import { abort, attachRun, history, respond, streamRun, waiting } from '../main.ts'
import { call, context, host, modelText, texts } from './fixtures/host.ts'
import { interrupt } from './fixtures/upstream.ts'
// Pi packages/durable/test/harness-generation.test.ts:206/219/254.
// Preserve the error at the SDK wire boundary rather than asserting Pi's private retry ledger.
// Ports packages/durable/test/harness-generation.test.ts:206 — generation > fails with model_error once retries are exhausted.
it.live.each([
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
])('$name', ({ retry, error, calls }) =>
  Effect.gen(function* () {
    const fixture = yield* host({}, {}, { retry: { ...retry, baseDelayMs: 0 } })
    const opened = yield* fixture.open()
    opened.faux.setResponses([
      fauxAssistantMessage('Discard.', { stopReason: 'error', errorMessage: error }),
      fauxAssistantMessage('Discard again.', { stopReason: 'error', errorMessage: error }),
      fauxAssistantMessage('Never.'),
    ])
    const chunks: UIMessageChunk[] = []
    const stream = yield* Effect.promise(() =>
      opened.transport.sendMessages({
        trigger: 'submit-message',
        chatId: 'failure',
        messageId: undefined,
        messages: [{ id: 'failure', role: 'user', parts: [{ type: 'text', text: 'Try' }] }],
        abortSignal: undefined,
      }),
    )
    {
      const iterator1 = stream[Symbol.asyncIterator]()
      let completed = false
      // Preserve for-await's early-exit cleanup; the host must never close before this reader.
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => {
          if (completed || iterator1.return === undefined) return Promise.resolve()
          return iterator1.return().then(() => {})
        }),
      )
      for (;;) {
        const next1 = yield* Effect.promise(() => iterator1.next())
        if (next1.done) {
          completed = true
          break
        }
        const chunk = next1.value
        chunks.push(chunk)
      }
    }
    expect(chunks.filter((chunk) => chunk.type === 'error')).toEqual([
      { type: 'error', errorText: error },
    ])
    expect(chunks.at(-1)).toMatchObject({ type: 'finish' })
    expect(opened.faux.state.callCount).toBe(calls)
    expect(opened.faux.getPendingResponseCount()).toBe(3 - calls)
  }),
)
// Pi packages/durable/test/harness-generation.test.ts:162, no configured/unknown model.
// Ports packages/durable/test/harness-generation.test.ts:162 — generation > fails with no_model when no model is configured or the model is unknown.
it.live('fails with no_model when no model is configured or the model is unknown', () =>
  Effect.gen(function* () {
    const fixture = yield* host({}, {})
    const opened = yield* fixture.open()
    const unset = yield* Effect.promise(() =>
      opened.harness.createConversation({ ownership: { kind: 'ownerless' } }, context),
    )
    const unsetStream = yield* Effect.promise(() =>
      new DefaultChatTransport<UIMessage>({
        api: 'http://durable.test/chat',
        fetch: (url, init) =>
          runForPi(
            Effect.promise(() =>
              respond(opened.harness, unset.id, new Request(url, init), context),
            ),
            undefined,
          ),
      }).sendMessages({
        trigger: 'submit-message',
        chatId: 'unset',
        messageId: undefined,
        messages: [{ id: 'unset', role: 'user', parts: [{ type: 'text', text: 'Try' }] }],
        abortSignal: undefined,
      }),
    )
    {
      const iterator2 = unsetStream[Symbol.asyncIterator]()
      let completed = false
      // Preserve for-await's early-exit cleanup; the host must never close before this reader.
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => {
          if (completed || iterator2.return === undefined) return Promise.resolve()
          return iterator2.return().then(() => {})
        }),
      )
      for (;;) {
        const next2 = yield* Effect.promise(() => iterator2.next())
        if (next2.done) {
          completed = true
          break
        }
        const chunk = next2.value
        expect(chunk.type).not.toBe('error')
      }
    }
    const unsetReceipt = yield* Effect.promise(() =>
      unset.submit({ type: 'input', content: 'Try', requestId: 'unset' }, context),
    )
    expect(yield* Effect.promise(() => unsetReceipt.status(context))).toMatchObject({
      status: 'unanswered',
      reason: 'no_model',
    })
    expect(yield* Effect.promise(() => waiting(opened.harness, unset.id, context))).toEqual([])
    yield* Effect.promise(() =>
      opened.root.configure({ model: { provider: 'faux', modelId: 'missing' } }, context),
    )
    const chunks: UIMessageChunk[] = []
    {
      const iterator3 = (yield* Effect.promise(() =>
        opened.transport.sendMessages({
          trigger: 'submit-message',
          chatId: 'missing',
          messageId: undefined,
          messages: [{ id: 'missing', role: 'user', parts: [{ type: 'text', text: 'Try' }] }],
          abortSignal: undefined,
        }),
      ))[Symbol.asyncIterator]()
      let completed = false
      // Preserve for-await's early-exit cleanup; the host must never close before this reader.
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => {
          if (completed || iterator3.return === undefined) return Promise.resolve()
          return iterator3.return().then(() => {})
        }),
      )
      for (;;) {
        const next3 = yield* Effect.promise(() => iterator3.next())
        if (next3.done) {
          completed = true
          break
        }
        const chunk = next3.value
        chunks.push(chunk)
      }
    }
    const receipt = yield* Effect.promise(() =>
      opened.root.submit({ type: 'input', content: 'Try', requestId: 'missing' }, context),
    )
    expect(yield* Effect.promise(() => receipt.status(context))).toMatchObject({
      status: 'unanswered',
      reason: 'no_model',
    })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish' })
    expect(opened.faux.state.callCount).toBe(0)
    expect(yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context))).toEqual(
      [],
    )
  }),
)
// Pi packages/durable/test/harness-tools.test.ts:114.
// Ports packages/durable/test/harness-tools.test.ts:114 — tool round > answers calls to tools the request did not offer without a task.
it.live('answers calls to tools the request did not offer without a task', () =>
  Effect.gen(function* () {
    let executions = 0
    let prompt = ''
    const fixture = yield* host(
      {
        echo: tool({
          inputSchema: z.object({}),
          execute: () =>
            runForPi(
              Effect.sync(() => {
                executions++
                return 'Echo.'
              }),
              undefined,
            ),
        }),
      },
      {},
    )
    const opened = yield* fixture.open()
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
    const result = yield* consumeReadable(
      yield* Effect.promise(() =>
        streamRun(
          opened.harness,
          { conversationId: opened.root.id, content: 'Try', requestId: 'ghost' },
          context,
        ),
      ),
      Option.none(),
    )
    expect(prompt).toContain('Tool ghost is not available')
    expect(executions).toBe(1)
    expect(texts(result.message)).toEqual(['Done.'])
    expect(yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context))).toEqual(
      [],
    )
  }),
)
// Pi packages/durable/test/harness-tools.test.ts:390; turns a throw into a tool_error result with the partial output.
// Exercise native progress and SDK execute together: both errors must reach the actual model and SDK.
// Ports packages/ai/src/ui/process-ui-message-stream.test.ts:2655 — processUIMessageStream > server-side tool roundtrip with output-error > should have the correct final message state.
it.live('turns a throw into a tool_error result with the partial output', () =>
  Effect.gen(function* () {
    let prompt = ''
    const fixture = yield* host(
      {
        fail: tool({
          inputSchema: z.object({}),
          execute: (): Promise<string> => Promise.reject(new Error('boom')),
        }),
      },
      {},
    )
    const opened = yield* fixture.open([
      defineExtension({
        name: 'native-progress',
        tools: [
          defineTool({
            name: 'nativeFail',
            description: 'Fail after writing partial output',
            parameters: Type.Object({}),
            executionMode: 'parallel',
            execute: (_args, api) =>
              runForPi(
                Effect.sync(() => {
                  api.output('partial\n')
                  throw new Error('boom')
                }),
                undefined,
              ),
          }),
        ],
      }),
    ])
    opened.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('fail', {}, { id: 'fail' }),
          fauxToolCall('nativeFail', {}, { id: 'native' }),
        ],
        { stopReason: 'toolUse' },
      ),
      (request) => {
        prompt = modelText(request.messages)
        return fauxAssistantMessage('Recovered.')
      },
    ])
    const result = yield* consumeReadable(
      yield* Effect.promise(() =>
        streamRun(
          opened.harness,
          { conversationId: opened.root.id, content: 'Try', requestId: 'throw' },
          context,
        ),
      ),
      Option.none(),
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
  }),
)
// Pi packages/durable/test/harness-tools.test.ts:486.
// Ports packages/durable/test/harness-tools.test.ts:486 — tool results > lets the first beforeTool block win and skips later handlers.
it.live('lets the first beforeTool block win and skips later handlers', () =>
  Effect.gen(function* () {
    const seen: string[] = []
    let executions = 0
    const fixture = yield* host(
      {
        echo: tool({
          inputSchema: z.object({}),
          execute: () =>
            runForPi(
              Effect.sync(() => {
                executions++
                return 'Echo.'
              }),
              undefined,
            ),
        }),
      },
      {},
    )
    const opened = yield* fixture.open([
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
    const result = yield* consumeReadable(
      yield* Effect.promise(() =>
        streamRun(
          opened.harness,
          { conversationId: opened.root.id, content: 'Try', requestId: 'block' },
          context,
        ),
      ),
      Option.none(),
    )
    expect(seen).toEqual(['first'])
    expect(executions).toBe(0)
    expect(result.message.parts.find((part) => 'toolCallId' in part)).toMatchObject({
      state: 'output-error',
      errorText: expect.stringContaining('first says no'),
    })
  }),
)
// Pi packages/durable/test/harness-submissions.test.ts:82.
// Ports packages/durable/test/harness-submissions.test.ts:82 — submissions > deduplicates request IDs per conversation before any write.
it.live('deduplicates request IDs per conversation before any write', () =>
  Effect.gen(function* () {
    const fixture = yield* host({}, {})
    const opened = yield* fixture.open()
    opened.faux.setResponses([fauxAssistantMessage('Root.'), fauxAssistantMessage('Other.')])
    const input = { conversationId: opened.root.id, content: 'Root', requestId: 'same' }
    const first = yield* consumeReadable(
      yield* Effect.promise(() => streamRun(opened.harness, input, context)),
      Option.none(),
    )
    const repeated = yield* Effect.promise(() =>
      opened.root.submit({ type: 'input', content: 'Changed', requestId: 'same' }, context),
    )
    expect(yield* Effect.promise(() => repeated.status(context))).toMatchObject({
      status: 'done',
      requestId: 'same',
    })
    expect(texts(first.message)).toEqual(['Root.'])
    const other = yield* Effect.promise(() =>
      opened.harness.createConversation(
        {
          ownership: { kind: 'ownerless' },
          agent: { model: { provider: 'faux', modelId: 'faux-1' } },
        },
        context,
      ),
    )
    const second = yield* consumeReadable(
      yield* Effect.promise(() =>
        streamRun(
          opened.harness,
          { ...input, conversationId: other.id, content: 'Other' },
          context,
        ),
      ),
      Option.none(),
    )
    expect(texts(second.message)).toEqual(['Other.'])
    expect(opened.faux.state.callCount).toBe(2)
    expect(
      (yield* Effect.promise(() => history(opened.harness, opened.root.id, { limit: 10 }, context)))
        .messages,
    ).toHaveLength(2)
    expect(
      (yield* Effect.promise(() => history(opened.harness, other.id, { limit: 10 }, context)))
        .messages,
    ).toHaveLength(2)
  }),
)
// Pi packages/durable/test/harness-inbox.test.ts:431.
// A clean restart uses no provider timing: park in a durable approval, then preserve a queued input.
// Ports packages/durable/test/harness-inbox.test.ts:431 — inbox > keeps queued submissions across reopen and settles them afterwards.
it.live('keeps queued submissions across reopen and settles them afterwards', () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void, FixtureFailed>()
    const release = yield* Deferred.make<void, FixtureFailed>()
    const fixture = yield* host(
      {
        gate: tool({
          inputSchema: z.object({}),
          execute: () =>
            runForPi(
              Effect.gen(function* () {
                Deferred.doneUnsafe(entered, Effect.void)
                yield* Deferred.await(release)
                return 'Released.'
              }),
              undefined,
            ),
        }),
      },
      { replay: { gate: 'safe' } },
    )
    const opened = yield* fixture.open()
    opened.faux.setResponses([call('gate', {}, 'gate')])
    const first = yield* Effect.promise(() =>
      streamRun(
        opened.harness,
        { conversationId: opened.root.id, content: 'First', requestId: 'first' },
        context,
      ),
    )
    yield* Deferred.await(entered)
    const queued = yield* Effect.promise(() =>
      opened.root.submit(
        { type: 'input', content: 'Queued', requestId: 'queued', whenBusy: 'followUp' },
        context,
      ),
    )
    expect((yield* Effect.promise(() => queued.status(context))).status).toBe('queued')
    // Harness.close joins non-cancellable execute callbacks; release that callback before awaiting it.
    const closing = yield* fixture
      .close(opened.harness)
      .pipe(Effect.forkScoped({ startImmediately: true }))
    Deferred.doneUnsafe(release, Effect.void)
    yield* Fiber.join(closing)
    yield* Effect.promise(() => first.cancel())
    const restarted = yield* fixture.open()
    restarted.faux.setResponses([
      fauxAssistantMessage('First done.'),
      fauxAssistantMessage('Queued done.'),
    ])
    const result = yield* consumeReadable(
      yield* Effect.promise(() =>
        streamRun(
          restarted.harness,
          { conversationId: restarted.root.id, content: 'Queued', requestId: 'queued' },
          context,
        ),
      ),
      Option.none(),
    )
    expect(texts(result.message)).toEqual(['Queued done.'])
    expect(
      (yield* Effect.promise(() =>
        history(restarted.harness, restarted.root.id, { limit: 10 }, context),
      )).messages
        .filter((message) => message.role === 'user')
        .map(texts),
    ).toEqual([['First'], ['Queued']])
  }),
)
// Pi packages/durable/test/harness-generation-recovery.test.ts:270.
// Ports packages/durable/test/harness-submissions.test.ts:178 — submissions > reacquires a submission after reopen and settles it durably.
it.live('runs a print-style turn and reads the durable answer after reopen', () =>
  Effect.gen(function* () {
    const fixture = yield* host({}, {})
    const opened = yield* fixture.open()
    opened.faux.setResponses([fauxAssistantMessage('Durable answer.')])
    const result = yield* consumeReadable(
      yield* Effect.promise(() =>
        streamRun(
          opened.harness,
          { conversationId: opened.root.id, content: 'Answer', requestId: 'answer' },
          context,
        ),
      ),
      Option.none(),
    )
    yield* fixture.close(opened.harness)
    const restarted = yield* fixture.open()
    const saved = yield* Effect.promise(() =>
      history(restarted.harness, restarted.root.id, { limit: 10 }, context),
    )
    const message = saved.messages.at(-1)
    if (message === undefined) throw new Error('Expected stored assistant')
    expect(message.parts).toEqual(result.message.parts)
    expect(restarted.faux.state.callCount).toBe(0)
  }),
)
// Pi packages/durable/test/harness-tools.test.ts:407-450.
// Ports packages/durable/test/harness-tools.test.ts:407 — tool results > validates arguments before and after beforeTool and applies blocks and replacements.
it.live('validates arguments before and after beforeTool and applies blocks and replacements', () =>
  Effect.gen(function* () {
    const seen: string[] = []
    const fixture = yield* host(
      {
        echo: tool({
          inputSchema: z.object({ text: z.string().optional() }),
          execute: (input) =>
            runForPi(
              Effect.sync(() => {
                if (input.text !== undefined) seen.push(input.text)
                return 'Echo.'
              }),
              undefined,
            ),
        }),
      },
      {},
    )
    const opened = yield* fixture.open([
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
    const result = yield* consumeReadable(
      yield* Effect.promise(() =>
        streamRun(
          opened.harness,
          { conversationId: opened.root.id, content: 'Try', requestId: 'validate' },
          context,
        ),
      ),
      Option.none(),
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
  }),
)
// Pi packages/durable/test/harness-tools.test.ts:511-534.
// Ports packages/durable/test/harness-tools.test.ts:511 — tool results > chains afterTool replacements and observes the round with afterTools.
it.live('chains afterTool replacements and observes the round with afterTools', () =>
  Effect.gen(function* () {
    const observed: number[][] = []
    let prompt = ''
    const fixture = yield* host(
      {
        echo: tool({
          inputSchema: z.object({}),
          execute: () => runForPi(Effect.succeed('raw'), undefined),
        }),
      },
      {},
    )
    const opened = yield* fixture.open([
      defineExtension({
        name: 'replace',
        hooks: [
          hook(ToolTask, {
            afterTool: (_call, result) => ({
              ...result,
              content: [{ type: 'text', text: 'first' }],
            }),
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
    const result = yield* consumeReadable(
      yield* Effect.promise(() =>
        streamRun(
          opened.harness,
          { conversationId: opened.root.id, content: 'Try', requestId: 'replace' },
          context,
        ),
      ),
      Option.none(),
    )
    expect(result.message.parts.find((part) => 'toolCallId' in part)).toMatchObject({
      state: 'output-available',
      output: { content: [{ type: 'text', text: 'first' }], details: { replaced: 'first' } },
    })
    expect(observed).toHaveLength(1)
    expect(observed[0]).toHaveLength(1)
    expect(prompt).toContain('first')
    expect(prompt).not.toContain('raw')
  }),
)
// Pi packages/durable/test/harness-tools-recovery.test.ts:136-162.
// The original port covers safe/safe; add both mismatches, which must forbid replay.
// Ports packages/durable/test/harness-tools-recovery.test.ts:136 — tool recovery > reruns a tool only when both the stored and the current replay policy are safe.
it.live.each([
  { stored: 'safe', current: 'unsafe' },
  { stored: 'unsafe', current: 'safe' },
] as const)('does not replay a $stored tool reopened with $current policy', ({ stored, current }) =>
  Effect.gen(function* () {
    let executions = 0
    const fixture = yield* host(
      {
        work: tool({
          inputSchema: z.object({}),
          execute: () =>
            runForPi(
              Effect.sync(() => {
                executions++
                return 'Replayed.'
              }),
              undefined,
            ),
        }),
      },
      { replay: { work: current } },
    )
    yield* interrupt(fixture.file, stored)
    const opened = yield* fixture.open()
    opened.faux.setResponses([fauxAssistantMessage('Interrupted safely.')])
    const attached = yield* Effect.promise(() => attachRun(opened.harness, opened.root.id, context))
    if (attached.status === 'idle') throw new Error('Expected interrupted run')
    opened.harness.resume()
    const result = yield* consumeReadable(attached.stream, Option.none())
    expect(executions).toBe(0)
    expect(result.message.parts.find((part) => 'toolCallId' in part)).toMatchObject({
      state: 'output-error',
      errorText: expect.stringContaining('was interrupted and may have partially run'),
    })
    expect(texts(result.message)).toEqual(['Interrupted safely.'])
  }),
)
// Pi packages/durable/test/harness-inbox.test.ts:145-167.
// Ports packages/durable/test/harness-inbox.test.ts:145 — inbox > places every follow-up in one successor run with followUpMode all.
it.live('places every follow-up in one successor run with followUpMode all', () =>
  Effect.gen(function* () {
    const fixture = yield* host({}, {}, { followUpMode: 'all' })
    const opened = yield* fixture.open()
    const entered = yield* Deferred.make<void, FixtureFailed>()
    const released = yield* Deferred.make<void, FixtureFailed>()
    const queued = yield* Deferred.make<void, FixtureFailed>()
    const observers = yield* Deferred.make<void, FixtureFailed>()
    yield* Effect.addFinalizer(() => Deferred.succeed(released, undefined))
    yield* Effect.addFinalizer(() => Deferred.succeed(observers, undefined))
    const requestIds = new Set<string>()
    const unsubscribe = opened.harness.subscribeCommits((publication) => {
      for (const change of publication.changes)
        if (
          change.type === 'submission' &&
          change.value.status === 'queued' &&
          (change.value.requestId === 'second' || change.value.requestId === 'third')
        )
          requestIds.add(change.value.requestId)
      if (requestIds.size === 2) Deferred.doneUnsafe(queued, Effect.void)
    })
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))
    let prompt = ''
    opened.faux.setResponses([
      () =>
        runForPi(
          Effect.gen(function* () {
            Deferred.doneUnsafe(entered, Effect.void)
            yield* Deferred.await(released)
            return fauxAssistantMessage('First.')
          }),
          undefined,
        ),
      (request) =>
        runForPi(
          Effect.gen(function* () {
            yield* Deferred.await(observers)
            prompt = modelText(request.messages)
            return fauxAssistantMessage('All follow-ups.')
          }),
          undefined,
        ),
    ])
    const first = yield* Effect.promise(() =>
      streamRun(
        opened.harness,
        { conversationId: opened.root.id, content: 'First', requestId: 'first' },
        context,
      ),
    )
    yield* Deferred.await(entered)
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
    yield* Deferred.await(queued)
    Deferred.doneUnsafe(released, Effect.void)
    const attached = yield* Effect.all(
      [Effect.promise(() => second), Effect.promise(() => third)],
      { concurrency: 'unbounded' },
    )
    Deferred.doneUnsafe(observers, Effect.void)
    const results = yield* Effect.all(
      [
        consumeReadable(first, Option.none()),
        ...attached.map((stream) => consumeReadable(stream, Option.none())),
      ],
      { concurrency: 'unbounded' },
    )
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
  }),
)
// Pi packages/durable/test/harness-structured.test.ts:1041/1061:
// aborts a parallel round with every result written; answers unstarted sequential calls in call order.
// The actual SDK execute waits on its supplied cancellation signal, never on a clock.
// Ports packages/durable/test/harness-structured.test.ts:1041 — tool rounds > aborts a parallel round with its generation: tools first, then the generation, with every result written.
it.live.each(['parallel', 'sequential'] as const)(
  'aborts a %s tool round with ordered durable results',
  (execution) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void, FixtureFailed>()
      let executions = 0
      const fixture = yield* host(
        {
          wait: tool({
            inputSchema: z.object({}),
            execute: (_input, options) =>
              runForPi(
                Effect.gen(function* () {
                  const abortSignal = options.abortSignal
                  if (abortSignal === undefined)
                    throw new Error('Expected execution cancellation signal')
                  executions++
                  if (executions === (execution === 'parallel' ? 2 : 1))
                    Deferred.doneUnsafe(started, Effect.void)
                  if (!abortSignal.aborted)
                    yield* Effect.promise(() => NodeEvents.EventEmitter.once(abortSignal, 'abort'))
                  return 'Cancelled.'
                }),
                undefined,
              ),
          }),
        },
        { execution },
        { toolExecution: execution },
      )
      const opened = yield* fixture.open()
      opened.faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('wait', {}, { id: 'c1' }), fauxToolCall('wait', {}, { id: 'c2' })],
          { stopReason: 'toolUse' },
        ),
      ])
      const collecting = yield* consumeReadable(
        yield* Effect.promise(() =>
          streamRun(
            opened.harness,
            { conversationId: opened.root.id, content: 'Wait', requestId: 'abort' },
            context,
          ),
        ),
        Option.none(),
      ).pipe(Effect.forkScoped({ startImmediately: true }))
      yield* Deferred.await(started)
      yield* Effect.promise(() => abort(opened.harness, opened.root.id, context))
      const result = yield* Fiber.join(collecting)
      expect(executions).toBe(execution === 'parallel' ? 2 : 1)
      expect(result.message.parts.filter(isToolUIPart)).toMatchObject([
        { toolCallId: 'c1', state: 'output-error' },
        { toolCallId: 'c2', state: 'output-error' },
      ])
      // Pi's case asserts the submission outcome, not an SDK abort chunk from a model invocation.
      const receipt = yield* Effect.promise(() =>
        opened.root.submit({ type: 'input', content: 'Wait', requestId: 'abort' }, context),
      )
      expect(yield* Effect.promise(() => receipt.status(context))).toMatchObject({
        status: 'unanswered',
        reason: 'aborted',
      })
      expect(result.chunks.at(-1)).toMatchObject({ type: 'finish' })
      const saved = yield* Effect.promise(() =>
        history(opened.harness, opened.root.id, { limit: 10 }, context),
      )
      expect(saved.messages.flatMap((message) => message.parts).filter(isToolUIPart)).toEqual(
        result.message.parts.filter(isToolUIPart),
      )
      expect(yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context))).toEqual(
        [],
      )
      expect(
        yield* Effect.promise(() => attachRun(opened.harness, opened.root.id, context)),
      ).toEqual({ status: 'idle' })
    }),
)
