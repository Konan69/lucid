import type { Message } from '@earendil-works/pi-ai'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { tool } from 'ai'
import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { z } from 'zod'
import { abort, history, streamRun } from '../main.ts'
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
