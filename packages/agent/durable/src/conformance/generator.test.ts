import { runForPi } from '../pi.ts'
import { consumeReadable } from '../fixtures/reading.ts'
import type { Message } from '@earendil-works/pi-ai'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import {
  tool,
  dynamicTool,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
} from 'ai'
import { expect, it } from '@effect/vitest'
import { Effect, Deferred, Fiber, Option } from 'effect'
import { FixtureFailed } from '../fixtures/harness.ts'

import { z } from 'zod'
import { PlainChat } from '../fixtures/chat.ts'
import { abort, attachRun, history, streamRun } from '../main.ts'
import { call, context, host, texts } from './fixtures/host.ts'

/** SDK provider-utils/types/execute-tool.ts:44–50 chooses the last yield, not the generator return. */
it.live('stores and streams only the last yielded result', () =>
  Effect.gen(function* () {
    let model: readonly Message[] = []
    const fixture = yield* host(
      {
        generate: tool({
          inputSchema: z.object({}),
          // @effect-diagnostics-next-line asyncFunction:off -- subject: the SDK takes the last async-generator yield and ignores its return value
          async *execute() {
            yield { phase: 'preliminary' }
            yield { phase: 'final' }
            return { phase: 'return value is ignored' }
          },
        }),
      },
      {},
    )
    const opened = yield* fixture.open()
    opened.faux.setResponses([
      call('generate', {}, 'generator'),
      (request) => {
        model = request.messages
        return fauxAssistantMessage('Done.')
      },
    ])
    const result = yield* consumeReadable(
      yield* Effect.promise(() =>
        Promise.resolve(
          streamRun(
            opened.harness,
            { conversationId: opened.root.id, content: 'Generate', requestId: 'final' },
            context,
          ),
        ),
      ),
      Option.none(),
    )
    expect(result.chunks.filter((chunk) => chunk.type === 'tool-output-available')).toEqual([
      { type: 'tool-output-available', toolCallId: 'generator', output: { phase: 'final' } },
    ])
    expect(result.message.parts.find((part) => part.type === 'tool-generate')).toMatchObject({
      output: { phase: 'final' },
    })
    expect(model.at(-1)).toMatchObject({ content: [{ type: 'text', text: '{"phase":"final"}' }] })
    const stored = yield* Effect.promise(() =>
      Promise.resolve(history(opened.harness, opened.root.id, { limit: 20 }, context)),
    )
    expect(
      stored.messages
        .flatMap((message) => message.parts)
        .find((part) => part.type === 'tool-generate'),
    ).toMatchObject({ output: { phase: 'final' } })
  }),
)

/** A preliminary yield cannot hide a subsequent generator rejection. */
it.live('reports a throw after a yield as a tool error and continues', () =>
  Effect.gen(function* () {
    const fixture = yield* host(
      {
        generate: tool({
          inputSchema: z.object({}),
          // @effect-diagnostics-next-line asyncFunction:off -- subject: an async generator throws after its preliminary yield
          async *execute() {
            yield 'preliminary'
            throw new Error('generation failed after yield')
          },
        }),
      },
      {},
    )
    const opened = yield* fixture.open()
    opened.faux.setResponses([
      call('generate', {}, 'generator'),
      fauxAssistantMessage('Recovered.'),
    ])
    const result = yield* consumeReadable(
      yield* Effect.promise(() =>
        Promise.resolve(
          streamRun(
            opened.harness,
            { conversationId: opened.root.id, content: 'Generate', requestId: 'throw' },
            context,
          ),
        ),
      ),
      Option.none(),
    )
    expect(result.message.parts.find((part) => part.type === 'tool-generate')).toMatchObject({
      state: 'output-error',
      errorText: expect.stringContaining('generation failed after yield'),
    })
    expect(texts(result.message)).toEqual(['Recovered.'])
  }),
)

/** Abort releases an in-flight next; the iterator return closes finally without another pull. */
it.live('calls iterator return and resolves generator finally on run cancellation', () =>
  Effect.gen(function* () {
    const entered = Deferred.makeUnsafe<void>()
    const finished = Deferred.makeUnsafe<void, FixtureFailed>()
    let returned = 0
    let pulls = 0
    const fixture = yield* host(
      {
        generate: tool({
          inputSchema: z.object({}),
          execute(_input, options) {
            const generator =
              // @effect-diagnostics-next-line asyncFunction:off -- subject: abort must call iterator return and resolve native generator finally
              (async function* () {
                try {
                  yield 'preliminary'
                  Deferred.doneUnsafe(entered, Effect.void)
                  const abortSignal = options.abortSignal
                  if (abortSignal === undefined) throw new Error('Expected tool abort signal')
                  if (!abortSignal.aborted) {
                    const cancelled = Deferred.makeUnsafe<void>()
                    abortSignal.addEventListener(
                      'abort',
                      () => Deferred.doneUnsafe(cancelled, Effect.void),
                      { once: true },
                    )
                    await runForPi(Deferred.await(cancelled), undefined)
                  }
                  yield 'cancelled in-flight value'
                } finally {
                  Deferred.doneUnsafe(finished, Effect.void)
                }
              })()
            return {
              [Symbol.asyncIterator]() {
                return this
              },
              next() {
                pulls++
                return generator.next()
              },
              return() {
                returned++
                return generator.return(undefined)
              },
            }
          },
        }),
      },
      {},
    )
    const opened = yield* fixture.open()
    opened.faux.setResponses([call('generate', {}, 'generator'), fauxAssistantMessage('Done.')])
    const stream = yield* Effect.promise(() =>
      Promise.resolve(
        streamRun(
          opened.harness,
          { conversationId: opened.root.id, content: 'Generate', requestId: 'abort' },
          context,
        ),
      ),
    )
    const reading = yield* Effect.forkScoped(consumeReadable(stream, Option.none()))
    // Race the join, not the consumer fiber: observing entry must keep the reader alive.
    yield* Effect.raceFirst(
      Deferred.await(entered),
      Fiber.join(reading).pipe(
        Effect.andThen(new FixtureFailed({ cause: new Error('Tool settled without iterating') })),
      ),
    )
    yield* Effect.promise(() => Promise.resolve(abort(opened.harness, opened.root.id, context)))
    yield* Deferred.await(finished)
    const result = yield* Fiber.join(reading)
    expect(returned).toBe(1)
    expect(pulls).toBe(2)
    expect(result.chunks.filter((chunk) => chunk.type === 'tool-output-available')).toEqual([])
  }),
)

/** A pending native generator await queues return; cancellation must release Pi without waiting for it. */
it.live('aborts a suspended generator and runs the next turn before generator cleanup', () =>
  Effect.gen(function* () {
    const entered = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    const finished = Deferred.makeUnsafe<void, FixtureFailed>()
    let closed = false
    const fixture = yield* host(
      {
        generate: tool({
          inputSchema: z.object({}),
          // @effect-diagnostics-next-line asyncFunction:off -- subject: a native pending generator await queues return without blocking Pi abort
          async *execute() {
            try {
              yield 'preliminary'
              Deferred.doneUnsafe(entered, Effect.void)
              await runForPi(Deferred.await(release), undefined)
              yield 'too late'
            } finally {
              closed = true
              Deferred.doneUnsafe(finished, Effect.void)
            }
          },
        }),
      },
      {},
    )
    const opened = yield* fixture.open()
    // A queued generator return must not delay Pi abort; release it only during outer cleanup.
    yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
    opened.faux.setResponses([call('generate', {}, 'stuck')])
    const reading = yield* Effect.forkScoped(
      consumeReadable(
        yield* Effect.promise(() =>
          Promise.resolve(
            streamRun(
              opened.harness,
              { conversationId: opened.root.id, content: 'Generate', requestId: 'suspended' },
              context,
            ),
          ),
        ),
        Option.none(),
      ),
    )
    yield* Deferred.await(entered)
    yield* Effect.promise(() => Promise.resolve(abort(opened.harness, opened.root.id, context)))
    const first = yield* Fiber.join(reading)
    expect(first.message.parts.find((part) => part.type === 'tool-generate')).toMatchObject({
      state: 'output-error',
    })
    expect(
      (yield* Effect.promise(() =>
        Promise.resolve(attachRun(opened.harness, opened.root.id, context)),
      )).status,
    ).toBe('idle')
    opened.faux.setResponses([fauxAssistantMessage('Next turn.')])
    const next = yield* consumeReadable(
      yield* Effect.promise(() =>
        Promise.resolve(
          streamRun(
            opened.harness,
            { conversationId: opened.root.id, content: 'Continue', requestId: 'next' },
            context,
          ),
        ),
      ),
      Option.none(),
    )
    expect(texts(next.message)).toEqual(['Next turn.'])
    expect(closed).toBe(false)
    Deferred.doneUnsafe(release, Effect.void)
    yield* Deferred.await(finished)
  }),
)

/** SDK for-await does not invoke return on normal exhaustion. */
it.live('does not call iterator return after normal exhaustion', () =>
  Effect.gen(function* () {
    let returned = 0
    let pulls = 0
    const fixture = yield* host(
      {
        generate: tool({
          inputSchema: z.object({}),
          execute: () => ({
            [Symbol.asyncIterator]() {
              return this
            },
            // @effect-diagnostics-next-line asyncFunction:off -- subject: a native async iterator reaches normal exhaustion
            async next() {
              pulls++
              return pulls === 1
                ? { done: false as const, value: 'final' }
                : { done: true as const, value: undefined }
            },
            // @effect-diagnostics-next-line asyncFunction:off -- subject: normal exhaustion must not call native async iterator return
            async return() {
              returned++
              return { done: true as const, value: undefined }
            },
          }),
        }),
      },
      {},
    )
    const opened = yield* fixture.open()
    opened.faux.setResponses([call('generate', {}, 'exhaustion'), fauxAssistantMessage('Done.')])
    const result = yield* consumeReadable(
      yield* Effect.promise(() =>
        Promise.resolve(
          streamRun(
            opened.harness,
            { conversationId: opened.root.id, content: 'Generate', requestId: 'exhaustion' },
            context,
          ),
        ),
      ),
      Option.none(),
    )
    expect(result.message.parts.find((part) => part.type === 'tool-generate')).toMatchObject({
      output: 'final',
    })
    expect(returned).toBe(0)
  }),
)

/** Rejected return promises are observed without blocking cancellation or causing an unhandled rejection. */
it.live('observes a rejecting iterator return during abort', () =>
  Effect.gen(function* () {
    const entered = Deferred.makeUnsafe<void>()
    const suspended = Deferred.makeUnsafe<void>()
    let returned = 0
    const fixture = yield* host(
      {
        generate: tool({
          inputSchema: z.object({}),
          execute: () => ({
            [Symbol.asyncIterator]() {
              return this
            },
            next() {
              Deferred.doneUnsafe(entered, Effect.void)
              return runForPi(Deferred.await(suspended), undefined).then(() => ({
                done: true as const,
                value: undefined,
              }))
            },
            // @effect-diagnostics-next-line asyncFunction:off -- subject: abort must observe a native async iterator return rejection
            async return(): Promise<IteratorResult<string>> {
              returned++
              throw new Error('cleanup rejection')
            },
          }),
        }),
      },
      {},
    )
    const opened = yield* fixture.open()
    opened.faux.setResponses([call('generate', {}, 'rejection')])
    const reading = yield* Effect.forkScoped(
      consumeReadable(
        yield* Effect.promise(() =>
          Promise.resolve(
            streamRun(
              opened.harness,
              { conversationId: opened.root.id, content: 'Generate', requestId: 'rejection' },
              context,
            ),
          ),
        ),
        Option.none(),
      ),
    )
    yield* Deferred.await(entered)
    yield* Effect.promise(() => Promise.resolve(abort(opened.harness, opened.root.id, context)))
    yield* Fiber.join(reading)
    expect(returned).toBe(1)
  }),
)

// AI SDK process-ui-message-stream.test.ts:7521/9422; upstream-aisdk.test.ts on the suites branch
// requests all four static/dynamic and approval/no-approval final-result combinations.
it.live.each([
  { dynamic: false, approval: false },
  { dynamic: false, approval: true },
  { dynamic: true, approval: false },
  { dynamic: true, approval: true },
])('keeps the final SDK generator value with dynamic=$dynamic and approval=$approval', (sample) =>
  Effect.gen(function* () {
    let executions = 0
    const registration = {
      inputSchema: z.object({}),
      // @effect-diagnostics-next-line asyncFunction:off -- subject: static and dynamic approved generators keep their last native yield
      execute: async function* () {
        executions++
        yield { status: 'loading' }
        yield { status: 'success' }
      },
    }
    const progress = sample.dynamic ? dynamicTool(registration) : tool(registration)
    const fixture = yield* host({ progress }, { approval: { progress: sample.approval } })
    const opened = yield* fixture.open()
    opened.faux.setResponses([
      call('progress', {}, 'progress'),
      (request) => {
        expect(request.messages.at(-1)).toMatchObject({
          role: 'toolResult',
          content: [{ type: 'text', text: '{"status":"success"}' }],
        })
        return fauxAssistantMessage('Done.')
      },
    ])
    let finished = Deferred.makeUnsafe<void, FixtureFailed>()
    const chat = new PlainChat({
      transport: opened.transport,
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
      onFinish: () => Deferred.doneUnsafe(finished, Effect.void),
      onError: (error) =>
        Deferred.doneUnsafe(finished, Effect.fail(new FixtureFailed({ cause: error }))),
    })
    yield* Effect.promise(() => Promise.resolve(chat.sendMessage({ text: 'Run' })))
    if (chat.lastMessage === undefined) throw new Error('Expected assistant')
    if (sample.approval) {
      expect(executions).toBe(0)
      const part = chat.lastMessage.parts.find(isToolUIPart)
      if (part === undefined || part.state !== 'approval-requested')
        throw new Error('Expected approval')
      finished = Deferred.makeUnsafe<void, FixtureFailed>()
      yield* Effect.promise(() =>
        Promise.resolve(chat.addToolApprovalResponse({ id: part.approval.id, approved: true })),
      )
      yield* Deferred.await(finished)
    }
    expect(executions).toBe(1)
    expect(chat.lastMessage.parts.find(isToolUIPart)).toMatchObject({
      type: sample.dynamic ? 'dynamic-tool' : 'tool-progress',
      state: 'output-available',
      output: { status: 'success' },
    })
    expect(chat.lastMessage.parts.find(isToolUIPart)).not.toMatchObject({ preliminary: true })
    expect(texts(chat.lastMessage)).toEqual(['Done.'])
    yield* Effect.promise(() => Promise.resolve(opened.root.waitForIdle(context)))
    const saved = yield* Effect.promise(() =>
      Promise.resolve(history(opened.harness, opened.root.id, { limit: 10 }, context)),
    )
    const stored = saved.messages.at(-1)
    if (stored === undefined) throw new Error('Expected stored assistant')
    expect(stored.parts.find(isToolUIPart)).toEqual(chat.lastMessage.parts.find(isToolUIPart))
  }),
)
