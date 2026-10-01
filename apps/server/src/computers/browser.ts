import { BrowseResult, BrowserAction } from '@vivid/contracts'
import { Effect, Schema } from 'effect'
import * as NodeURL from 'node:url'
import { BrowserAddressRefused, BrowserStepFailed, MachineResponseInvalid } from './machine.js'

const decodeBrowseResult = Schema.decodeUnknownEffect(Schema.fromJsonString(BrowseResult))

/** Reject non-web navigation and local literals; namespace firewall handles DNS and redirects. */
const validateAddress = Effect.fn('Machine.browser.address')(function* (address: string) {
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

/** Each contract case becomes one argv JSON value, never shell source or page-supplied script. */
export const browserArguments = Effect.fn('Machine.browser.arguments')(function* (
  action: BrowserAction,
) {
  const validation: Effect.Effect<void, BrowserAddressRefused> = BrowserAction.match(action, {
    Open: ({ address }) => validateAddress(address),
    Read: () => Effect.void,
    Click: () => Effect.void,
    Type: () => Effect.void,
    Press: () => Effect.void,
    Screenshot: () => Effect.void,
  })
  yield* validation
  const step = BrowserAction.match(action, {
    Open: ({ address }) => ({ step: 'open', address }),
    Read: () => ({ step: 'read' }),
    Click: ({ target }) => ({ step: 'click', target }),
    Type: ({ target, text }) => ({ step: 'type', target, text }),
    Press: ({ key }) => ({ step: 'press', key }),
    Screenshot: () => ({ step: 'screenshot' }),
  })
  return ['node', '/opt/vivid/browser.mjs', JSON.stringify(step)]
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
