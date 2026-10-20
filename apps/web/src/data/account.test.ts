import * as NodeFS from 'node:fs'
import { expect, it } from '@effect/vitest'
import { Effect, Redacted } from 'effect'
import { vi } from 'vitest'
import { signedInDevices } from './account.ts'

/**
 * Better Auth 1.7.5 lists plain string tokens. This JSON was produced offline by its installed
 * parseSessionOutput with an inert session and dates serialized by JSON. Exercise the private consumer schema through the public account reader.
 */
it.effect('reads the Better Auth wire session and wraps its credential', () =>
  Effect.gen(function* () {
    const fixture = NodeFS.readFileSync(
      new URL('./fixtures/sessions.json', import.meta.url),
      'utf8',
    )
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (input === '/api/auth/list-sessions') return new Response(fixture)
      if (input === '/api/auth/get-session') {
        return Response.json({ session: { id: 'fixture-session' } })
      }
      throw new Error('Unexpected account request')
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
