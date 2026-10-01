import { describe, expect, it } from '@effect/vitest'
import { BrowserAction, ComputerState } from '@vivid/contracts'
import { Effect } from 'effect'
import { browserArguments, decodeBrowserOutput } from './browser.js'
import { Machine, MachineKey, unavailableMachineLayer } from './machine.js'

describe('Computer boundary', () => {
  it.effect('refuses local and non-web navigation before invoking a provider', () =>
    Effect.gen(function* () {
      for (const address of [
        'file:///etc/passwd',
        'javascript:alert(1)',
        'http://127.0.0.1',
        'http://10.0.0.1',
        'http://localhost',
      ]) {
        const failure = yield* Effect.flip(
          browserArguments(BrowserAction.cases.Open.make({ address })),
        )
        expect(failure._tag).toBe('BrowserAddressRefused')
      }
    }),
  )

  it.effect(
    'rejects clipped or malformed driver output rather than fabricating a readable page',
    () =>
      Effect.gen(function* () {
        const clipped = yield* Effect.flip(
          decodeBrowserOutput({ exitCode: 0, output: '{', truncated: true }),
        )
        expect(clipped._tag).toBe('MachineResponseInvalid')
        const malformed = yield* Effect.flip(
          decodeBrowserOutput({ exitCode: 0, output: '{"title":42}', truncated: false }),
        )
        expect(malformed._tag).toBe('MachineResponseInvalid')
      }),
  )

  it.effect('disabled installations answer Unavailable without trying Docker', () =>
    Effect.gen(function* () {
      const machine = yield* Machine
      const key = MachineKey.make('unconfigured')
      expect(yield* machine.status(key)).toEqual(ComputerState.cases.Unavailable.make({}))
      const failure = yield* Effect.flip(machine.ensure(key))
      expect(failure._tag).toBe('MachineUnavailable')
    }).pipe(Effect.provide(unavailableMachineLayer)),
  )
})
