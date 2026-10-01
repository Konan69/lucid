import { expect, it } from '@effect/vitest'
import { Effect, type Schema } from 'effect'
import { toolMessage } from './message.ts'

/** Diagnostics can nest headers in JSON or quote them in prose; neither representation leaks. */
it.effect('discards credential-bearing diagnostics and bounds ordinary explanations', () =>
  Effect.sync(() => {
    const diagnostics: readonly (typeof Schema.Json.Type)[] = [
      'Authorization: Basic private-value',
      'authorization=private-value',
      'BEARER private-value',
      'api_key="private-value"',
      'api-key: private-value',
      'apikey private-value',
      'Token\nprivate-value',
      'Set-Cookie: session=private-value',
      { headers: { Authorization: 'Bearer private-value' } },
      { content: [{ text: '401 request failed: Cookie=private-value' }] },
    ]
    for (const value of diagnostics) {
      const message = toolMessage(value)
      expect(message).not.toContain('private-value')
      expect(message.length).toBeLessThanOrEqual(400)
    }
    const explanation = 'The request was refused. '.repeat(100)
    expect(toolMessage(explanation)).toBe(explanation.slice(0, 400))
    expect(toolMessage({ reason: 'Missing record' })).toBe('{"reason":"Missing record"}')
  }),
)
