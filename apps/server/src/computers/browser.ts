import { Effect } from 'effect'
import * as NodeURL from 'node:url'
import { BrowserAddressRefused, MachineInputInvalid } from './machine.js'

/** Reject non-web navigation and local literals; provider network policy handles DNS and redirects. */
export const validateAddress = Effect.fn('Machine.browser.address')(function* (address: string) {
  const url = yield* Effect.try({
    try: () => new NodeURL.URL(address),
    catch: () => new BrowserAddressRefused(),
  })
  const host = url.hostname.toLowerCase()
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username !== '' ||
    url.password !== '' ||
    /(^|\.)(localhost|local|internal|home|lan)\.?$/.test(host) ||
    /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) ||
    host.startsWith('[')
  ) {
    yield* Effect.fail(new BrowserAddressRefused())
  }
})

/** Only editing/navigation keys are accepted; closing tabs/windows and browser control shortcuts are excluded. */
export const validateKey = Effect.fn('Machine.browser.key')(function* (key: string) {
  if (
    !/^(Enter|Tab|Escape|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Backspace|Delete|Home|End|PageUp|PageDown|[^\p{C}\p{Zl}\p{Zp}]|Shift\+[^\p{C}\p{Zl}\p{Zp}]|Control\+[aAcCvVfF]|Control\+Shift\+[vV])$/u.test(
      key,
    )
  ) {
    yield* Effect.fail(new MachineInputInvalid())
  }
})
