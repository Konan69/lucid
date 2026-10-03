import { BrowseResult, BrowserAction } from '@vivid/contracts'
import { Effect, Schema } from 'effect'
import * as NodeURL from 'node:url'
import {
  BrowserAddressRefused,
  BrowserStepFailed,
  MachineInputInvalid,
  MachineResponseInvalid,
} from './machine.js'

const decodeBrowseResult = Schema.decodeUnknownEffect(Schema.fromJsonString(BrowseResult))

/** Reject non-web navigation and local literals; namespace firewall handles DNS and redirects. */
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

/** The private JSON step travels on stdin; argv contains only the fixed driver path. */
export const browserArguments = Effect.fn('Machine.browser.arguments')(function* (
  action: BrowserAction,
) {
  if (BrowserAction.guards.Open(action)) yield* validateAddress(action.address)
  if (BrowserAction.guards.OpenTab(action)) yield* validateAddress(action.address)
  if (BrowserAction.guards.Press(action)) yield* validateKey(action.key)
  const step = BrowserAction.match(action, {
    Open: ({ address }) => ({ step: 'open', address }),
    Read: () => ({ step: 'read' }),
    Click: ({ target }) => ({ step: 'click', target }),
    Type: ({ target, text }) => ({ step: 'type', target, text }),
    Press: ({ key }) => ({ step: 'press', key }),
    Screenshot: () => ({ step: 'screenshot' }),
    Scroll: ({ direction, notches }) => ({ step: 'scroll', direction, notches }),
    Back: () => ({ step: 'back' }),
    Forward: () => ({ step: 'forward' }),
    Wait: ({ seconds }) => ({ step: 'wait', seconds }),
    OpenTab: ({ address }) => ({ step: 'openTab', address }),
    ShowTab: ({ tab }) => ({ step: 'showTab', tab }),
    CloseTab: ({ tab }) => ({ step: 'closeTab', tab }),
  })
  return { args: ['node', '/opt/vivid/browser.mjs'], input: JSON.stringify(step) }
})

/** Decode at the driver ingress; clipped JSON and failed steps cannot masquerade as page state. */
export const decodeBrowserOutput = Effect.fn('Machine.browser.decode')(function* (result: {
  readonly output: string
  readonly exitCode: number
  readonly truncated: boolean
}) {
  if (result.exitCode !== 0) return yield* Effect.fail(new BrowserStepFailed())
  if (result.truncated)
    return yield* Effect.fail(new MachineResponseInvalid({ operation: 'browse' }))
  return yield* decodeBrowseResult(result.output).pipe(
    Effect.mapError(() => new MachineResponseInvalid({ operation: 'browse' })),
  )
})
