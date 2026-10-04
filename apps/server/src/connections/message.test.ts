import { expect, it } from '@effect/vitest'
import { Effect, type Schema } from 'effect'
import { toolMessage, validationProblem } from './message.ts'

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
      'secret: private-value',
      'password=private-value',
      'credential private-value',
      'key: private-value',
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

/** Opaque secrets often arrive without a field name. Redact whole runs before truncation, so a
 * token crossing the cut cannot leave a usable prefix and JWT segments cannot escape separately.
 */
it.effect('redacts unnamed keys, JWT segments and header echoes before truncation', () =>
  Effect.sync(() => {
    const opaque = 'sk_live_' + 'aBcDeF0123456789_'.repeat(3)
    const segment = 'eyJhbGciOiJIUzI1NiJ9abcdefghijklmnop'
    const jwt = `${segment}.${segment}.${'A'.repeat(43)}`
    expect(toolMessage(`Refused ${opaque}`)).toBe('Refused [REDACTED]')
    expect(toolMessage(`Refused ${jwt}`)).toBe('Refused [REDACTED].[REDACTED].[REDACTED]')
    expect(toolMessage('Header echo X-Request-Id: ' + opaque)).not.toContain(opaque)
    const prefix = 'x '.repeat(195)
    expect(toolMessage(prefix + opaque)).toBe((prefix + '[REDACTED]').slice(0, 400))
    expect(toolMessage('a'.repeat(24))).toBe('[REDACTED]')
    expect(toolMessage('a'.repeat(23))).toBe('a'.repeat(23))
  }),
)

/** Invalid input should remain correctable without exposing credentials or internal selections. */
it.effect('filters sensitive validation summaries while preserving field guidance', () =>
  Effect.sync(() => {
    const identity = { app: 'app-private', deployment: 'deployment-private' }
    expect(validationProblem('repoName: expected a string', identity)).toBe(
      'repoName: expected a string',
    )
    for (const problem of [
      'token: private-value',
      'account: short-private',
      'profile id: short-private',
      'unknown app-private',
      'unknown deployment-private',
      'selection 37e21f26-63ed-4075-aad1-0118929da0ac',
      'opaque ' + 'x'.repeat(32),
    ]) {
      expect(validationProblem(problem, identity)).not.toMatch(
        /private-value|short-private|app-private|deployment-private|37e21f26|x{32}/,
      )
    }
  }),
)
