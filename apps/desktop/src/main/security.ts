import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { BridgeRequest } from '../shared/bridge.ts'
import { ServerSettings } from '../shared/settings.ts'

const decodeUrl = Schema.decodeUnknownOption(Schema.URLFromString)

/** Match an HTTP origin exactly; WebSockets use the same authority through the matching scheme. */
export function isAppRequest(url: string, server: ServerSettings): boolean {
  return ServerSettings.match(server, {
    NoServer: () => false,
    Server: ({ origin }) =>
      Option.exists(decodeUrl(url), (parsed) => {
        if (parsed.username !== '' || parsed.password !== '') return false
        if (parsed.protocol === 'ws:') parsed.protocol = 'http:'
        if (parsed.protocol === 'wss:') parsed.protocol = 'https:'
        return parsed.origin === new URL(origin).origin
      }),
  })
}

/** Local chooser trust is document-specific: file origins are opaque and cannot be compared. */
export function isTrustedDocument(url: string, server: ServerSettings, chooser: string): boolean {
  return ServerSettings.match(server, {
    NoServer: () =>
      Option.exists(decodeUrl(url), (parsed) => {
        parsed.hash = ''
        parsed.search = ''
        return parsed.href === chooser
      }),
    Server: () => isAppRequest(url, server) && /^https?:/.test(url),
  })
}

/** Refuse malformed or foreign redirect destinations before any redirected bytes are sent. */
export function isAllowedRedirect(
  from: string,
  destination: string,
  server: ServerSettings,
): boolean {
  if (!isAppRequest(from, server) || !URL.canParse(destination, from)) return false
  return isAppRequest(new URL(destination, from).href, server)
}

/** Only notifications and sanitized clipboard writes are needed; media stays denied. */
export function isAllowedPermission(
  permission: string,
  origin: string,
  server: ServerSettings,
): boolean {
  return (
    (permission === 'notifications' || permission === 'clipboard-sanitized-write') &&
    /^https?:/.test(origin) &&
    isAppRequest(origin, server)
  )
}

/** Duplicate Location headers fail closed; same-origin relative redirects remain usable. */
export function isAllowedResponse(input: {
  readonly url: string
  readonly status: number
  readonly headers: Readonly<Record<string, ReadonlyArray<string>>>
  readonly server: ServerSettings
}): boolean {
  if (![301, 302, 303, 307, 308].includes(input.status)) return true
  const locations = Object.entries(input.headers)
    .filter(([name]) => name.toLowerCase() === 'location')
    .flatMap(([, values]) => values)
  if (locations.length === 0) return true
  const [destination] = locations
  return (
    locations.length === 1 &&
    destination !== undefined &&
    isAllowedRedirect(input.url, destination, input.server)
  )
}

/** Only the bundled chooser can mutate shell authority; selected-origin documents get version metadata. */
export function isAllowedBridgeRequest(
  url: string,
  server: ServerSettings,
  chooser: string,
  request: BridgeRequest,
): boolean {
  if (isTrustedDocument(url, ServerSettings.cases.NoServer.make({}), chooser)) return true
  return BridgeRequest.guards.GetAppVersion(request) && isTrustedDocument(url, server, chooser)
}
