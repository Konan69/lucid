import { expect, it } from '@effect/vitest'
import { Effect, Redacted } from 'effect'
import { vi } from 'vitest'
import { signedInDevices } from './account.ts'
// Vite's raw import keeps the captured bytes exactly as Better Auth wrote them.
import fixture from './fixtures/sessions.json?raw'

/**
 * Better Auth 1.7.5 lists plain string tokens. This JSON was produced offline by its installed
 * parseSessionOutput with an inert session and dates serialized by JSON. Exercise the private
 * consumer schema through the public account reader.
 */
it.effect('reads the Better Auth wire session and wraps its credential', () =>
  Effect.gen(function* () {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      if (input === '/api/auth/list-sessions') return Promise.resolve(new Response(fixture))
      if (input === '/api/auth/get-session') {
        return Promise.resolve(Response.json({ session: { id: 'fixture-session' } }))
      }
      return Promise.reject(new Error('Unexpected account request'))
    })
    yield* Effect.addFinalizer(() => Effect.sync(() => fetcher.mockRestore()))
    const devices = yield* signedInDevices
    expect(devices).toHaveLength(1)
    expect(devices).toMatchObject([
      { here: true, lastUsedAt: Date.parse('2026-10-02T00:00:00.000Z') },
    ])
    expect(devices.map((entry) => Redacted.value(entry.token))).toEqual([
      'fixture-credential-not-valid-anywhere',
    ])
  }).pipe(Effect.scoped),
)
