import { Deferred, Effect, Fiber, Option, Stream } from 'effect'
import { consumeReadable, ReadFailed } from '../fixtures/reading.ts'
import {
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from '@effect/vitest'
import { isToolUIPart, lastAssistantMessageIsCompleteWithApprovalResponses, tool } from 'ai'
import { z } from 'zod'
import { waitForFrame } from '../fixtures/provider.ts'
import { client, Decision } from '../fixtures/chat.ts'
import { abort, attachRun, history, streamRun } from '../main.ts'
import { context, host, texts } from './fixtures/host.ts'
/** openai-completions.js customInput stores a growing grammar string, not JSON argument scratch. */
it.live('approves customInput without exposing its partial grammar input', () =>
  Effect.gen(function* () {
    const input = 'a payment instruction '.repeat(30)
    const paid: string[] = []
    const fixture = yield* host(
      {
        pay: tool({
          inputSchema: z.object({ input: z.string() }),
          execute: (args) => {
            paid.push(args.input)
            return Promise.resolve(args.input)
          },
        }),
      },
      { approval: { pay: true } },
      { progress: { partialIntervalMs: 0 } },
      { partialFamily: 'custom', commitFrames: true, tokenSize: { min: 1, max: 1 } },
    )
    const opened = yield* fixture.open()
    opened.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('pay', { input }, { id: 'custom' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('Done.'),
    ])
    const { chat, next } = client({
      transport: opened.transport,
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    })
    let done = next()
    yield* Effect.promise(() => chat.sendMessage({ text: 'Pay' }))
    expect(yield* done).toEqual(Decision.cases.Settled.make({}))
    if (chat.lastMessage === undefined) throw new Error('Expected assistant')
    const part = chat.lastMessage.parts.find(isToolUIPart)
    if (part === undefined || part.state !== 'approval-requested')
      throw new Error('Expected approval')
    expect(part.input).toEqual({ input })
    expect(paid).toEqual([])
    done = next()
    yield* Effect.promise(() =>
      Promise.resolve(chat.addToolApprovalResponse({ id: part.approval.id, approved: true })),
    )
    expect(yield* done).toEqual(Decision.cases.Settled.make({}))
    expect(paid).toEqual([input])
    expect(chat.status).toBe('ready')
  }),
)
/** Responses streams a trailing summary separator then replaces it with its shorter authoritative join. */
it.live('reconciles a committed shorter Responses replacement in live, attach and history', () =>
  Effect.gen(function* () {
    const releaseTail = yield* Deferred.make<void>()
    const releaseReplacement = yield* Deferred.make<void>()
    const fixture = yield* host(
      {},
      {},
      { progress: { partialIntervalMs: 0 } },
      {
        partialFamily: 'responses',
        tokenSize: { min: 1, max: 1 },
        onFrame: (event, abortSignal) => {
          if (event.type === 'thinking_delta' && event.delta.endsWith('\n\n'))
            return waitForFrame(Deferred.await(releaseTail), abortSignal)
          if (event.type === 'thinking_end')
            return waitForFrame(Deferred.await(releaseReplacement), abortSignal)
          return Effect.void
        },
      },
    )
    const opened = yield* fixture.open()
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        Deferred.doneUnsafe(releaseTail, Effect.void)
        Deferred.doneUnsafe(releaseReplacement, Effect.void)
      }),
    )
    const reasoning = 'Reasoning '.repeat(30)
    const text = 'Answer '.repeat(30)
    opened.faux.setResponses([fauxAssistantMessage([fauxThinking(reasoning), fauxText(text)])])
    const stream = yield* Effect.promise(() =>
      streamRun(
        opened.harness,
        { conversationId: opened.root.id, content: 'Explain', requestId: 'responses' },
        context,
      ),
    )
    const [raw, folded] = stream.tee()
    const tailed = yield* Deferred.make<void>()
    const replaced = yield* Deferred.make<void>()
    const resultPromise = yield* Effect.forkScoped(consumeReadable(folded, Option.none()))
    const drain = yield* Effect.forkScoped(
      Stream.runForEach(
        Stream.fromAsyncIterable(raw, (cause) => new ReadFailed({ cause })),
        (chunk) =>
          Effect.sync(() => {
            if (chunk.type === 'reasoning-delta' && chunk.delta.endsWith('\n\n'))
              Deferred.doneUnsafe(tailed, Effect.void)
            if (chunk.type === 'reset-step') Deferred.doneUnsafe(replaced, Effect.void)
          }),
      ),
    )
    yield* Deferred.await(tailed)
    const attachedTail = yield* Effect.promise(() =>
      attachRun(opened.harness, opened.root.id, context),
    )
    if (attachedTail.status !== 'running') throw new Error('Expected separator attachment')
    const replayedTail = yield* Effect.forkScoped(
      consumeReadable(attachedTail.stream, Option.none()),
    )
    Deferred.doneUnsafe(releaseTail, Effect.void)
    yield* Deferred.await(replaced)
    const attachedReplacement = yield* Effect.promise(() =>
      attachRun(opened.harness, opened.root.id, context),
    )
    if (attachedReplacement.status !== 'running') throw new Error('Expected replacement attachment')
    const replayedReplacement = yield* Effect.forkScoped(
      consumeReadable(attachedReplacement.stream, Option.none()),
    )
    Deferred.doneUnsafe(releaseReplacement, Effect.void)
    yield* Fiber.join(drain)
    const result = yield* Fiber.join(resultPromise)
    expect(texts(result.message)).toEqual([text])
    expect(result.message.parts.filter((part) => part.type === 'reasoning')).toMatchObject([
      { type: 'reasoning', text: reasoning, state: 'done' },
    ])
    expect(result.chunks.filter((chunk) => chunk.type === 'reset-step')).toHaveLength(1)
    expect(result.chunks.filter((chunk) => chunk.type === 'reasoning-start')).toHaveLength(2)
    expect(result.chunks.filter((chunk) => chunk.type === 'text-start')).toHaveLength(1)
    expect((yield* Fiber.join(replayedTail)).message.parts).toEqual(result.message.parts)
    expect((yield* Fiber.join(replayedReplacement)).message.parts).toEqual(result.message.parts)
    const page = yield* Effect.promise(() =>
      history(opened.harness, opened.root.id, { limit: 10 }, context),
    )
    const assistant = page.messages.find((message) => message.role === 'assistant')
    if (assistant === undefined) throw new Error('Expected history')
    expect(assistant.parts).toEqual(result.message.parts)
  }),
)
/** anthropic-messages.js abort strips scratch but retains truncated parsed arguments: never admit them. */
it.live(
  'aborts a parsed partial tool input without making it available or requesting approval',
  () =>
    Effect.gen(function* () {
      const input = { account: 'savings', amount: 12345 }
      const release = yield* Deferred.make<void>()
      let held = false
      const fixture = yield* host(
        {
          pay: tool({
            inputSchema: z.object({ account: z.string(), amount: z.number() }),
            execute: (args) => Promise.resolve(args),
          }),
        },
        { approval: { pay: true } },
        { progress: { partialIntervalMs: 0 } },
        {
          partialFamily: 'anthropic',
          tokenSize: { min: 1, max: 1 },
          onFrame: (event, abortSignal) => {
            if (event.type !== 'toolcall_delta' || held) return Effect.void
            held = true
            return waitForFrame(Deferred.await(release), abortSignal)
          },
        },
      )
      const opened = yield* fixture.open()
      yield* Effect.addFinalizer(() => Effect.sync(() => Deferred.doneUnsafe(release, Effect.void)))
      opened.faux.setResponses([
        fauxAssistantMessage([fauxToolCall('pay', input, { id: 'partial' })], {
          stopReason: 'toolUse',
        }),
      ])
      const stream = yield* Effect.promise(() =>
        streamRun(
          opened.harness,
          { conversationId: opened.root.id, content: 'Pay', requestId: 'abort-partial' },
          context,
        ),
      )
      const [raw, folded] = stream.tee()
      const result = yield* Effect.forkScoped(consumeReadable(folded, Option.none()))
      const started = yield* Deferred.make<void>()
      const drain = yield* Effect.forkScoped(
        Stream.runForEach(
          Stream.fromAsyncIterable(raw, (cause) => new ReadFailed({ cause })),
          (chunk) =>
            Effect.sync(() => {
              if (chunk.type === 'tool-input-start') Deferred.doneUnsafe(started, Effect.void)
            }),
        ),
      )
      yield* Deferred.await(started)
      const attached = yield* Effect.promise(() =>
        attachRun(opened.harness, opened.root.id, context),
      )
      if (attached.status !== 'running') throw new Error('Expected partial replay')
      const replayed = yield* Effect.forkScoped(consumeReadable(attached.stream, Option.none()))
      yield* Effect.promise(() => abort(opened.harness, opened.root.id, context))
      Deferred.doneUnsafe(release, Effect.void)
      yield* Fiber.join(drain)
      const finished = yield* Fiber.join(result)
      expect((yield* Fiber.join(replayed)).message.parts).toEqual(finished.message.parts)
      const types = finished.chunks.map((chunk) => chunk.type)
      expect(types).toContain('tool-input-start')
      expect(types).toContain('abort')
      expect(types).not.toContain('tool-input-available')
      expect(types).not.toContain('tool-approval-request')
      expect(types.indexOf('tool-input-error')).toBeGreaterThan(types.indexOf('tool-input-start'))
      expect(types.indexOf('abort')).toBeGreaterThan(types.indexOf('tool-input-error'))
      const part = finished.message.parts.find(isToolUIPart)
      expect(part).toMatchObject({
        type: 'tool-pay',
        toolCallId: 'partial',
        state: 'output-error',
        errorText: 'Tool input was interrupted before it completed',
      })
      const page = yield* Effect.promise(() =>
        history(opened.harness, opened.root.id, { limit: 10 }, context),
      )
      const assistant = page.messages.find((message) => message.role === 'assistant')
      if (assistant === undefined) throw new Error('Expected aborted history')
      expect(assistant.parts).toEqual(finished.message.parts)
      const view = yield* Effect.promise(() => opened.root.context(context))
      const recorded = view.entries
        .flatMap((entry) => entry.model ?? [])
        .flatMap((message) => (message.role === 'assistant' ? message.content : []))
        .find((block) => block.type === 'toolCall')
      expect(recorded).toMatchObject({ type: 'toolCall', id: 'partial', name: 'pay' })
      if (recorded === undefined || recorded.type !== 'toolCall')
        throw new Error('Expected partial call')
      expect(recorded.arguments).not.toEqual(input)
    }),
)
