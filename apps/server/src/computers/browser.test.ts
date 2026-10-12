import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { validateAddress, validateKey } from './browser.js'

describe('Computer boundary', () => {
  it.effect('refuses local and non-web navigation at the application boundary', () =>
    Effect.gen(function* () {
      for (const address of [
        'file:///etc/passwd',
        'javascript:alert(1)',
        'http://127.0.0.1',
        'http://10.0.0.1',
        'http://localhost',
      ]) {
        const failure = yield* Effect.flip(validateAddress(address))
        expect(failure._tag).toBe('BrowserAddressRefused')
      }
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
        const failure = yield* Effect.flip(validateKey(key))
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
        yield* validateKey(key)
      }
    }),
  )
})
