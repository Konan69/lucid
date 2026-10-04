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

/** The path the server names as its device-approval page (`verificationUri` in its auth provider). */
const APPROVAL_PATH = '/device'
/** What an approval address may carry: the code, and the mark that starts Google sign-in there. */
const APPROVAL_MARKS = new Set(['user_code', 'signin'])

/**
 * Whether an address is the selected server's approval page for one sign-in code, and nothing
 * else. This is the only same-origin address the shell hands to the system browser: the desktop
 * window signs in with Google by having the Person approve a code there (the phone's answer,
 * `googlePlace` in `@vivid/state`), and every other app address belongs inside the window.
 *
 * It is exact on purpose. The origin is the saved server's and uses a page scheme, never a
 * WebSocket's. The path is the approval page alone. There is one non-empty `user_code`; the only
 * other thing allowed beside it is `signin=google`. Credentials and a fragment are refused, so
 * nothing a document adds can ride along to the browser.
 */
export function isApprovalAddress(address: string, server: ServerSettings): boolean {
  if (!/^https?:/.test(address) || !isAppRequest(address, server)) return false
  return Option.exists(decodeUrl(address), (parsed) => {
    const marks = [...parsed.searchParams.keys()]
    const codes = parsed.searchParams.getAll('user_code')
    const signin = parsed.searchParams.getAll('signin')
    return (
      parsed.pathname === APPROVAL_PATH &&
      parsed.hash === '' &&
      marks.every((mark) => APPROVAL_MARKS.has(mark)) &&
      codes.length === 1 &&
      codes[0] !== '' &&
      signin.every((value) => value === 'google') &&
      signin.length <= 1
    )
  })
}

/**
 * Only the chooser changes shell authority; app documents receive the closed page capability.
 *
 * Opening the approval page is decided first and by its address, whoever asks: it is granted to
 * the selected server's own document for that server's approval page, and to nothing else, the
 * chooser included (which has no server to approve a sign-in on).
 */
export function isAllowedBridgeRequest(
  url: string,
  server: ServerSettings,
  chooser: string,
  request: BridgeRequest,
): boolean {
  if (BridgeRequest.guards.OpenApproval(request))
    return isTrustedDocument(url, server, chooser) && isApprovalAddress(request.address, server)
  if (isTrustedDocument(url, ServerSettings.cases.NoServer.make({}), chooser)) return true
  return (
    BridgeRequest.isAnyOf(['GetAppVersion', 'Pages', 'GetDeviceLink', 'RefreshDeviceLink'])(
      request,
    ) && isTrustedDocument(url, server, chooser)
  )
}
