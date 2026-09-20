import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import { afterEach, vi } from 'vitest'
import { ClientRequestFailed, request } from './request'

const decodeGreeting = (input: string): string => {
  if (input !== 'hello') throw new Error('not a greeting')
  return input
}

/** Replaces the browser's fetch for one test; `request` owns no other seam to the network. */
const respondWith = (response: () => Promise<Response>) => vi.stubGlobal('fetch', response)

describe('WebClient.request', () => {
  afterEach(() => vi.unstubAllGlobals())

  it.effect('returns the decoded body of a successful response', () =>
    Effect.gen(function* () {
      respondWith(() => Promise.resolve(new Response('hello', { status: 200 })))
      expect(yield* request('/api/greeting', decodeGreeting)).toBe('hello')
    }),
  )

  it.effect("surfaces the server's own error sentence on a failed response", () =>
    Effect.gen(function* () {
      respondWith(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: 'Thread not found' }), { status: 404 }),
        ),
      )
      const failure = yield* request('/api/threads/missing', decodeGreeting).pipe(Effect.flip)
      expect(failure).toBeInstanceOf(ClientRequestFailed)
      expect(failure).toMatchObject({ status: 404, message: 'Thread not found' })
    }),
  )

  it.effect('reports a success whose body fails its decoder as invalid data, not as a crash', () =>
    Effect.gen(function* () {
      respondWith(() => Promise.resolve(new Response('goodbye', { status: 200 })))
      const failure = yield* request('/api/greeting', decodeGreeting).pipe(Effect.flip)
      expect(failure).toMatchObject({ status: 200, message: 'Vivid returned invalid data.' })
    }),
  )

  it.effect('reports an unreachable server without a status', () =>
    Effect.gen(function* () {
      respondWith(() => Promise.reject(new TypeError('Failed to fetch')))
      const failure = yield* request('/api/greeting', decodeGreeting).pipe(Effect.flip)
      expect(failure).toMatchObject({ status: null, message: 'Could not reach Vivid.' })
    }),
  )
})
