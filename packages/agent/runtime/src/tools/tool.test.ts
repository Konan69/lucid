/// <reference lib="es2024.promise" />
import type { Schema } from 'effect'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { createRegistry, defineExtension, Harness, MemoryStorage } from '@earendil-works/pi-durable'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as v from 'valibot'
import { defineTool } from './tool.ts'
import type { ToolResult } from './result.ts'
import { roundTrip } from './tests/harness.ts'

// Timer virtualization belongs only to the deadline claim, not to readiness or provider progress.
afterEach(() => vi.useRealTimers())

describe('Pi tool boundary', () => {
  // @effect-diagnostics-next-line asyncFunction:off -- This test drives Pi's Promise-only public runtime, not an Effect program.
  it('coerces numbers and removes optional nulls before decoding once', async () => {
    let calls = 0
    const tool = defineTool({
      name: 'count',
      description: 'Count records.',
      input: v.object({ count: v.number(), limit: v.optional(v.number(), 6) }),
      run: ({ data }) => {
        calls += 1
        return { output: data }
      },
    })
    const accepted: Schema.JsonObject[] = [{ count: '2' }, { count: 2, limit: null }]
    for (const args of accepted) {
      const { message, calls: generations } = await roundTrip(
        tool,
        args,
        new AbortController().signal,
      )
      expect(message.isError).toBe(false)
      expect(message.content).toEqual([{ type: 'text', text: '{"count":2,"limit":6}' }])
      expect(generations).toBe(2)
    }
    expect(calls).toBe(2)
    const result = await roundTrip(
      tool,
      { count: 2, ignored: 'not decoded' },
      new AbortController().signal,
    )
    expect(result.message.details).toEqual({ customTool: 'count', output: { count: 2, limit: 6 } })
    expect(result.message.content).toEqual([{ type: 'text', text: '{"count":2,"limit":6}' }])
    expect(calls).toBe(3)
  })

  for (const [name, output, expected] of [
    ['undefined optional key', { ok: true, note: undefined }, { ok: true }],
    ['infinite value', { value: Infinity }, { value: null }],
    ['NaN value', { value: NaN }, { value: null }],
  ] as const) {
    // @effect-diagnostics-next-line asyncFunction:off -- Pi's persisted result is the Promise-only runtime surface under test.
    it(`normalizes ${name} after the action without asking the model to repeat it`, async () => {
      let calls = 0
      const tool = defineTool({
        name: 'receipt',
        description: 'Read an RPC receipt.',
        input: v.object({}),
        // @ts-expect-error -- A third-party RPC receipt can violate Json at runtime; test normalization after the action.
        run: () => {
          calls += 1
          return { output }
        },
      })
      const { message } = await roundTrip(tool, {}, new AbortController().signal)
      expect(message.isError).toBe(false)
      expect(message.content).toEqual([{ type: 'text', text: JSON.stringify(expected) }])
      expect(message.details).toEqual({ customTool: 'receipt', output: expected })
      expect(calls).toBe(1)
    })
  }

  // @effect-diagnostics-next-line asyncFunction:off -- Pi's transcript is the Promise-only surface under test.
  it('serializes a missing output root as null, as main did', async () => {
    const tool = defineTool({
      name: 'empty',
      description: 'Return an empty receipt.',
      input: v.object({}),
      // @ts-expect-error -- Deliberately violate the RPC Json contract to reproduce a missing runtime output.
      run: () => ({ output: undefined }),
    })
    const { message } = await roundTrip(tool, {}, new AbortController().signal)
    expect(message.isError).toBe(false)
    expect(message.content).toEqual([{ type: 'text', text: 'null' }])
    expect(message.details).toEqual({ customTool: 'empty', output: null })
  })

  // @effect-diagnostics-next-line asyncFunction:off -- Pi's transcript is the Promise-only surface under test.
  it('refuses an unserializable receipt without describing the completed action as unrun', async () => {
    const output: Record<string, Schema.Json> = {}
    output.self = output
    let calls = 0
    const tool = defineTool({
      name: 'cycle',
      description: 'Return a receipt.',
      input: v.object({}),
      run: () => {
        calls += 1
        return { output }
      },
    })
    const { message } = await roundTrip(tool, {}, new AbortController().signal)
    expect(calls).toBe(1)
    expect(message.isError).toBe(true)
    expect(message.content).toEqual([
      {
        type: 'text',
        text: 'The tool ran, but its result could not be represented as JSON. Check before running it again.',
      },
    ])
  })

  // @effect-diagnostics-next-line asyncFunction:off -- This test drives Pi's Promise-only public runtime, not an Effect program.
  it('cancels a signal-deaf callback and records an aborted call', async () => {
    const started = Promise.withResolvers<AbortSignal>()
    const pending = Promise.withResolvers<ToolResult>()
    const controller = new AbortController()
    const tool = defineTool({
      name: 'waiting',
      description: 'Wait for a server receipt.',
      input: v.object({}),
      run: ({ signal }) => {
        started.resolve(signal)
        return pending.promise
      },
    })
    const running = roundTrip(tool, {}, controller.signal)
    const signal = await started.promise
    controller.abort()
    const result = await running
    expect(signal.aborted).toBe(true)
    expect(result.message.isError).toBe(true)
    expect(
      result.message.content.map((block) => (block.type === 'text' ? block.text : '')).join(''),
    ).toMatch(/abort/i)
    pending.resolve({ output: { late: true } })
    expect(result.message.details).toBeUndefined()
  })

  // @effect-diagnostics-next-line asyncFunction:off -- This test drives Pi's Promise-only public runtime, not an Effect program.
  it('races a signal-deaf callback against its deadline and lets the model continue', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const started = Promise.withResolvers<AbortSignal>()
    const pending = Promise.withResolvers<ToolResult>()
    const tool = defineTool({
      name: 'deadline',
      description: 'Wait for a server receipt.',
      input: v.object({}),
      timeoutMs: 75,
      run: ({ signal }) => {
        started.resolve(signal)
        return pending.promise
      },
    })
    const running = roundTrip(tool, {}, new AbortController().signal)
    const signal = await started.promise
    await vi.advanceTimersByTimeAsync(75)
    const result = await running
    expect(signal.aborted).toBe(true)
    expect(result.message.isError).toBe(true)
    expect(result.message.content).toEqual([
      { type: 'text', text: 'Tool "deadline" timed out after 75ms' },
    ])
    expect(result.calls).toBe(2)
    pending.resolve({ output: { late: true } })
  })

  // @effect-diagnostics-next-line asyncFunction:off -- This test drives Pi's Promise-only public runtime, not an Effect program.
  it('terminates without another model request and gives queued input a successor run', async () => {
    const entered = Promise.withResolvers<void>()
    const answer = Promise.withResolvers<ToolResult>()
    const tool = defineTool({
      name: 'ask',
      description: 'Ask the Person.',
      input: v.object({}),
      run: () => {
        entered.resolve()
        return answer.promise
      },
    })
    const models = createModels()
    const faux = fauxProvider({ tokensPerSecond: 0 })
    models.setProvider(faux.provider)
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('ask', {}), { stopReason: 'toolUse' }),
      fauxAssistantMessage('Handled the next message.'),
    ])
    const registry = createRegistry()
    registry.install(defineExtension({ name: 'fixture', tools: [tool] }))
    const harness = await Harness.open(
      new MemoryStorage(),
      { models, registry },
      BACKGROUND_CONTEXT,
    )
    await Promise.resolve()
      // @effect-diagnostics-next-line asyncFunction:off -- This test drives Pi's Promise-only public runtime, not an Effect program.
      .then(async () => {
        const root = await harness.root(BACKGROUND_CONTEXT, {
          agent: { model: { provider: 'faux', modelId: 'faux-1' } },
        })
        const first = await root.submit({ type: 'input', content: 'Ask me.' }, BACKGROUND_CONTEXT)
        await entered.promise
        const next = await root.submit(
          { type: 'input', content: 'My next message.', whenBusy: 'followUp' },
          BACKGROUND_CONTEXT,
        )
        expect((await next.status(BACKGROUND_CONTEXT)).status).toBe('queued')
        answer.resolve({ output: { question: 'Which one?' }, terminate: true })
        const firstReceipt = await first.wait(BACKGROUND_CONTEXT)
        const nextReceipt = await next.wait(BACKGROUND_CONTEXT)
        expect(firstReceipt.status).toBe('done')
        expect(nextReceipt.status).toBe('done')
        if (
          firstReceipt.status !== 'done' ||
          firstReceipt.type !== 'input' ||
          nextReceipt.status !== 'done' ||
          nextReceipt.type !== 'input'
        )
          throw new Error('Expected answered inputs.')
        expect(firstReceipt.answer).not.toBe(nextReceipt.answer)
        expect(faux.state.callCount).toBe(2)
      })
      .finally(() => harness.close(BACKGROUND_CONTEXT))
  })
})
