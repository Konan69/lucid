import { describe, expect, it } from '@effect/vitest'
import { BrowserAction, ComputerState } from '@vivid/contracts'
import { Effect } from 'effect'
import { browserArguments, decodeBrowserOutput } from './browser.js'
import { commandInvocation } from './docker.js'
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

  it.effect('keeps shell source and typed credentials out of executable argv', () =>
    Effect.gen(function* () {
      const command = "printf '%s' 'command-secret-marker'"
      const invocation = commandInvocation({
        key: MachineKey.make('argv-proof'),
        command,
        timeoutSeconds: 10,
      })
      expect(invocation.args).toContain('-i')
      expect(invocation.args).toContain('-s')
      expect(invocation.args.join(' ')).not.toContain(command)
      expect(invocation.args.join(' ')).not.toContain('command-secret-marker')
      expect(invocation.input).toBe(`${command}\n`)
      const step = yield* browserArguments(
        BrowserAction.cases.Type.make({ target: 'element-reference', text: 'typed-secret-marker' }),
      )
      expect(step.args.join(' ')).not.toContain('typed-secret-marker')
      expect(step.args.join(' ')).not.toContain('element-reference')
      expect(step.input).toContain('typed-secret-marker')
    }),
  )

  it.effect('refuses closing shortcuts while allowing editing and page navigation', () =>
    Effect.gen(function* () {
      for (const key of [
        'Control+W',
        'Control+Shift+W',
        'Alt+F4',
        'Meta+W',
        'Control+L',
        'F12',
        'Enter+Control',
      ]) {
        const failure = yield* Effect.flip(
          browserArguments(BrowserAction.cases.Press.make({ key })),
        )
        expect(failure._tag).toBe('MachineInputInvalid')
      }
      for (const key of [
        'Enter',
        'Tab',
        'Escape',
        'ArrowLeft',
        'ArrowUp',
        'ArrowDown',
        'ArrowRight',
        'Backspace',
        'Delete',
        'Home',
        'End',
        'PageUp',
        'PageDown',
        'a',
        'é',
        '😀',
        'Shift+é',
        ' ',
        'Shift+A',
        'Control+A',
        'Control+C',
        'Control+V',
        'Control+F',
        'Control+Shift+V',
      ]) {
        yield* browserArguments(BrowserAction.cases.Press.make({ key }))
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
