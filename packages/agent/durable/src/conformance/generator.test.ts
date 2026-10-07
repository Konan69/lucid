import type { Message } from '@earendil-works/pi-ai'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import {
  tool,
  dynamicTool,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
} from 'ai'
import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { onTestFinished } from 'vitest'
import { z } from 'zod'
import { PlainChat } from '../fixtures/chat.ts'
import { abort, attachRun, history, streamRun } from '../main.ts'
import { call, consume, context, host, signal, texts } from './fixtures/host.ts'

/** SDK provider-utils/types/execute-tool.ts:44–50 chooses the last yield, not the generator return. */
it.live('stores and streams only the last yielded result', () =>
  Effect.promise(async () => {
    let model: readonly Message[] = []
    const fixture = await host(
      {
        generate: tool({
          inputSchema: z.object({}),
          async *execute() {
            yield { phase: 'preliminary' }
            yield { phase: 'final' }
            return { phase: 'return value is ignored' }
          },
        }),
      },
      {},
    )
    const opened = await fixture.open()
    opened.faux.setResponses([
      call('generate', {}, 'generator'),
      (request) => {
        model = request.messages
        return fauxAssistantMessage('Done.')
      },
    ])
    const result = await consume(
      await streamRun(
        opened.harness,
        { conversationId: opened.root.id, content: 'Generate', requestId: 'final' },
        context,
      ),
    )
    expect(result.chunks.filter((chunk) => chunk.type === 'tool-output-available')).toEqual([
      { type: 'tool-output-available', toolCallId: 'generator', output: { phase: 'final' } },
    ])
    expect(result.message.parts.find((part) => part.type === 'tool-generate')).toMatchObject({
      output: { phase: 'final' },
    })
    expect(model.at(-1)).toMatchObject({ content: [{ type: 'text', text: '{"phase":"final"}' }] })
    const stored = await history(opened.harness, opened.root.id, { limit: 20 }, context)
    expect(
      stored.messages
        .flatMap((message) => message.parts)
        .find((part) => part.type === 'tool-generate'),
    ).toMatchObject({ output: { phase: 'final' } })
  }),
)

/** A preliminary yield cannot hide a subsequent generator rejection. */
it.live('reports a throw after a yield as a tool error and continues', () =>
  Effect.promise(async () => {
    const fixture = await host(
      {
        generate: tool({
          inputSchema: z.object({}),
          async *execute() {
            yield 'preliminary'
            throw new Error('generation failed after yield')
          },
        }),
      },
      {},
    )
    const opened = await fixture.open()
    opened.faux.setResponses([
      call('generate', {}, 'generator'),
      fauxAssistantMessage('Recovered.'),
    ])
    const result = await consume(
      await streamRun(
        opened.harness,
        { conversationId: opened.root.id, content: 'Generate', requestId: 'throw' },
        context,
      ),
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
  Effect.promise(async () => {
    const entered = signal()
    const finished = signal()
    let returned = 0
    let pulls = 0
    const fixture = await host(
      {
        generate: tool({
          inputSchema: z.object({}),
          execute(_input, options) {
            const generator = (async function* () {
              try {
                yield 'preliminary'
                entered.resolve()
                const abortSignal = options.abortSignal
                if (abortSignal === undefined) throw new Error('Expected tool abort signal')
                if (!abortSignal.aborted) {
                  const cancelled = signal()
                  abortSignal.addEventListener('abort', cancelled.resolve, { once: true })
                  await cancelled.promise
                }
                yield 'cancelled in-flight value'
              } finally {
                finished.resolve()
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
    const opened = await fixture.open()
    opened.faux.setResponses([call('generate', {}, 'generator'), fauxAssistantMessage('Done.')])
    const stream = await streamRun(
      opened.harness,
      { conversationId: opened.root.id, content: 'Generate', requestId: 'abort' },
      context,
    )
    const reading = consume(stream)
    await Promise.race([
      entered.promise,
      reading.then(() => {
        throw new Error('Tool settled without iterating')
      }),
    ])
    await abort(opened.harness, opened.root.id, context)
    await finished.promise
    const result = await reading
    expect(returned).toBe(1)
    expect(pulls).toBe(2)
    expect(result.chunks.filter((chunk) => chunk.type === 'tool-output-available')).toEqual([])
  }),
)

/** A pending native generator await queues return; cancellation must release Pi without waiting for it. */
it.live('aborts a suspended generator and runs the next turn before generator cleanup', () =>
  Effect.promise(async () => {
    const entered = signal()
    const release = signal()
    const finished = signal()
    let closed = false
    const fixture = await host(
      {
        generate: tool({
          inputSchema: z.object({}),
          async *execute() {
            try {
              yield 'preliminary'
              entered.resolve()
              await release.promise
              yield 'too late'
            } finally {
              closed = true
              finished.resolve()
            }
          },
        }),
      },
      {},
    )
    onTestFinished(() => release.resolve())
    const opened = await fixture.open()
    opened.faux.setResponses([call('generate', {}, 'stuck')])
    const reading = consume(
      await streamRun(
        opened.harness,
        { conversationId: opened.root.id, content: 'Generate', requestId: 'suspended' },
        context,
      ),
    )
    await entered.promise
    await abort(opened.harness, opened.root.id, context)
    const first = await reading
    expect(first.message.parts.find((part) => part.type === 'tool-generate')).toMatchObject({
      state: 'output-error',
    })
    expect((await attachRun(opened.harness, opened.root.id, context)).status).toBe('idle')
    opened.faux.setResponses([fauxAssistantMessage('Next turn.')])
    const next = await consume(
      await streamRun(
        opened.harness,
        { conversationId: opened.root.id, content: 'Continue', requestId: 'next' },
        context,
      ),
    )
    expect(texts(next.message)).toEqual(['Next turn.'])
    expect(closed).toBe(false)
    release.resolve()
    await finished.promise
  }),
)

/** SDK for-await does not invoke return on normal exhaustion. */
it.live('does not call iterator return after normal exhaustion', () =>
  Effect.promise(async () => {
    let returned = 0
    let pulls = 0
    const fixture = await host(
      {
        generate: tool({
          inputSchema: z.object({}),
          execute: () => ({
            [Symbol.asyncIterator]() {
              return this
            },
            async next() {
              pulls++
              return pulls === 1
                ? { done: false as const, value: 'final' }
                : { done: true as const, value: undefined }
            },
            async return() {
              returned++
              return { done: true as const, value: undefined }
            },
          }),
        }),
      },
      {},
    )
    const opened = await fixture.open()
    opened.faux.setResponses([call('generate', {}, 'exhaustion'), fauxAssistantMessage('Done.')])
    const result = await consume(
      await streamRun(
        opened.harness,
        { conversationId: opened.root.id, content: 'Generate', requestId: 'exhaustion' },
        context,
      ),
    )
    expect(result.message.parts.find((part) => part.type === 'tool-generate')).toMatchObject({
      output: 'final',
    })
    expect(returned).toBe(0)
  }),
)

/** Rejected return promises are observed without blocking cancellation or causing an unhandled rejection. */
it.live('observes a rejecting iterator return during abort', () =>
  Effect.promise(async () => {
    const entered = signal()
    const suspended = signal()
    let returned = 0
    const fixture = await host(
      {
        generate: tool({
          inputSchema: z.object({}),
          execute: () => ({
            [Symbol.asyncIterator]() {
              return this
            },
            next() {
              entered.resolve()
              return suspended.promise.then(() => ({ done: true as const, value: undefined }))
            },
            async return(): Promise<IteratorResult<string>> {
              returned++
              throw new Error('cleanup rejection')
            },
          }),
        }),
      },
      {},
    )
    const opened = await fixture.open()
    opened.faux.setResponses([call('generate', {}, 'rejection')])
    const reading = consume(
      await streamRun(
        opened.harness,
        { conversationId: opened.root.id, content: 'Generate', requestId: 'rejection' },
        context,
      ),
    )
    await entered.promise
    await abort(opened.harness, opened.root.id, context)
    await reading
    expect(returned).toBe(1)
  }),
)

// AI SDK process-ui-message-stream.test.ts:7521/9422; upstream-aisdk.test.ts on the suites branch
// requests all four static/dynamic and approval/no-approval final-result combinations.
it.each([
  { dynamic: false, approval: false },
  { dynamic: false, approval: true },
  { dynamic: true, approval: false },
  { dynamic: true, approval: true },
])(
  'keeps the final SDK generator value with dynamic=$dynamic and approval=$approval',
  async (sample) => {
    let executions = 0
    const registration = {
      inputSchema: z.object({}),
      execute: async function* () {
        executions++
        yield { status: 'loading' }
        yield { status: 'success' }
      },
    }
    const progress = sample.dynamic ? dynamicTool(registration) : tool(registration)
    const fixture = await host({ progress }, { approval: { progress: sample.approval } })
    const opened = await fixture.open()
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
    let finished = signal()
    const chat = new PlainChat({
      transport: opened.transport,
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
      onFinish: () => finished.resolve(),
      onError: (error) => finished.reject(error),
    })
    await chat.sendMessage({ text: 'Run' })
    if (chat.lastMessage === undefined) throw new Error('Expected assistant')
    if (sample.approval) {
      expect(executions).toBe(0)
      const part = chat.lastMessage.parts.find(isToolUIPart)
      if (part === undefined || part.state !== 'approval-requested')
        throw new Error('Expected approval')
      finished = signal()
      await chat.addToolApprovalResponse({ id: part.approval.id, approved: true })
      await finished.promise
    }
    expect(executions).toBe(1)
    expect(chat.lastMessage.parts.find(isToolUIPart)).toMatchObject({
      type: sample.dynamic ? 'dynamic-tool' : 'tool-progress',
      state: 'output-available',
      output: { status: 'success' },
    })
    expect(chat.lastMessage.parts.find(isToolUIPart)).not.toMatchObject({ preliminary: true })
    expect(texts(chat.lastMessage)).toEqual(['Done.'])
    await opened.root.waitForIdle(context)
    const saved = await history(opened.harness, opened.root.id, { limit: 10 }, context)
    const stored = saved.messages.at(-1)
    if (stored === undefined) throw new Error('Expected stored assistant')
    expect(stored.parts.find(isToolUIPart)).toEqual(chat.lastMessage.parts.find(isToolUIPart))
  },
)
