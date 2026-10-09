import { afterEach, beforeEach, vi } from 'vitest'
import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { normalizeContext } from '@earendil-works/pi-ai'
// Preload the real adapter so fake time controls retry timers rather than module loading.
import '@earendil-works/pi-ai/api/openai-completions'
import { provider } from './explabs.ts'

const model = provider.getModels().find((candidate) => candidate.id === 'glm-5.3-flash')
if (model === undefined) throw new Error('Production model is missing')
const context = normalizeContext({ messages: [{ role: 'user', content: 'hello', timestamp: 0 }] })

/** A real OpenAI streaming payload reaches Pi; only the HTTP peer is controlled. */
const completion = () =>
  new Response(
    'data: {"choices":[{"index":0,"delta":{"content":"ready"},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
      'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  )

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('production provider request retries', () => {
  for (const method of ['stream', 'streamSimple'] as const) {
    it.effect.each([500, 501, 502, 503, 504, 520, 521, 522, 523, 524, 599])(
      `${method} retries %s before output and returns the successful answer`,
      (status) =>
        Effect.gen(function* () {
          const fetch = vi
            .fn()
            .mockResolvedValueOnce(new Response(null, { status }))
            .mockResolvedValueOnce(completion())
          const result = provider[method](model, context, { apiKey: 'test', fetch }).result()
          yield* Effect.promise(() => vi.runAllTimersAsync())
          expect((yield* Effect.promise(() => result)).content).toEqual([
            { type: 'text', text: 'ready' },
          ])
          expect(fetch).toHaveBeenCalledTimes(2)
        }),
    )
  }

  it.effect('bounds one Pi request to three HTTP attempts, despite a larger caller budget', () =>
    Effect.gen(function* () {
      const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 520 })))
      const result = provider
        .streamSimple(model, context, { apiKey: 'test', fetch, maxRetries: 20 })
        .result()
      yield* Effect.promise(() => vi.runAllTimersAsync())
      expect((yield* Effect.promise(() => result)).stopReason).toBe('error')
      expect(fetch).toHaveBeenCalledTimes(3)
    }),
  )

  it.effect('retries a connection reset before receiving a response', () =>
    Effect.gen(function* () {
      const fetch = vi
        .fn()
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValueOnce(completion())
      const result = provider.streamSimple(model, context, { apiKey: 'test', fetch }).result()
      yield* Effect.promise(() => vi.runAllTimersAsync())
      expect((yield* Effect.promise(() => result)).stopReason).toBe('stop')
      expect(fetch).toHaveBeenCalledTimes(2)
    }),
  )

  it.effect('does not retry authentication or an excessive server-requested delay', () =>
    Effect.gen(function* () {
      for (const response of [
        new Response(null, { status: 401 }),
        new Response(null, { status: 503, headers: { 'retry-after': '10' } }),
      ]) {
        const fetch = vi.fn(() => Promise.resolve(response))
        const result = provider.streamSimple(model, context, { apiKey: 'test', fetch }).result()
        yield* Effect.promise(() => vi.runAllTimersAsync())
        expect((yield* Effect.promise(() => result)).stopReason).toBe('error')
        expect(fetch).toHaveBeenCalledTimes(1)
      }
    }),
  )

  it.effect.each([
    { content: 'partial answer' },
    {
      tool_calls: [
        { index: 0, id: 'call', type: 'function', function: { name: 'read', arguments: '{}' } },
      ],
    },
  ])('does not replay a response stream after an assistant delta: %j', (delta) =>
    Effect.gen(function* () {
      const bytes = new TextEncoder().encode(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
      )
      let sent = false
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) controller.error(new Error('ECONNRESET'))
          else {
            sent = true
            controller.enqueue(bytes)
          }
        },
      })
      const fetch = vi.fn(() =>
        Promise.resolve(new Response(body, { headers: { 'content-type': 'text/event-stream' } })),
      )
      const result = provider.streamSimple(model, context, { apiKey: 'test', fetch }).result()
      yield* Effect.promise(() => vi.runAllTimersAsync())
      const answer = yield* Effect.promise(() => result)
      expect(answer.stopReason).toBe('error')
      expect(answer.content.length).toBeGreaterThan(0)
      expect(fetch).toHaveBeenCalledTimes(1)
    }),
  )
})
