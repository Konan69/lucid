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
function isAllowedRedirect(from: string, destination: string, server: ServerSettings): boolean {
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

/** Signing in with Google through the system browser: the four requests of `main/signin.ts`. */
const isSignInRequest = BridgeRequest.isAnyOf([
  'BeginGoogleSignIn',
  'ReopenGoogleSignIn',
  'AwaitGoogleSignIn',
  'CancelGoogleSignIn',
])

/**
 * Only the chooser changes shell authority; app documents receive the closed page capability.
 *
 * Google sign-in is decided first, and differently from everything else: it is granted to the
 * selected server's own document and to nothing else. The chooser is otherwise trusted with
 * every request, but it has no server to sign in to, so it is refused here before that trust is
 * consulted, whether or not a server is saved. The requests carry no address, so there is
 * nothing in them to check: the shell builds the browser's address from the server it saved.
 */
export function isAllowedBridgeRequest(
  url: string,
  server: ServerSettings,
  chooser: string,
  request: BridgeRequest,
): boolean {
  if (isSignInRequest(request))
    return ServerSettings.guards.Server(server) && isTrustedDocument(url, server, chooser)
  if (isTrustedDocument(url, ServerSettings.cases.NoServer.make({}), chooser)) return true
  return (
    BridgeRequest.isAnyOf([
      'GetAppVersion',
      'Pages',
      'GetDeviceLink',
      'RefreshDeviceLink',
      'ShowColorScheme',
      'ShowNotification',
    ])(request) && isTrustedDocument(url, server, chooser)
  )
}
