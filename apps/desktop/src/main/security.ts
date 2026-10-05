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
/**
 * A sign-in code exactly as the server issues it: eight characters of Better Auth's own alphabet,
 * which leaves out the look-alikes I, O, 0 and 1 (`defaultCharset` and `userCodeLength`'s default
 * in better-auth 1.7.5 `dist/plugins/device-authorization/routes.mjs` and `index.mjs`; the server
 * sets neither, `apps/server/src/auth/provider.ts`). The server sends it in capitals with no dash,
 * and the app passes it on untouched, so the dashed form a Person reads is not an address form.
 */
const USER_CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/
/** The whole query of an approval address: the code, with or without the mark that starts Google. */
const APPROVAL_QUERY = Schema.Union([
  Schema.Tuple([
    Schema.Tuple([Schema.Literal('user_code'), Schema.String.check(Schema.isPattern(USER_CODE))]),
  ]),
  Schema.Tuple([
    Schema.Tuple([Schema.Literal('user_code'), Schema.String.check(Schema.isPattern(USER_CODE))]),
    Schema.Tuple([Schema.Literal('signin'), Schema.Literal('google')]),
  ]),
])
const isApprovalQuery = Schema.is(APPROVAL_QUERY)

/**
 * Whether an address is the selected server's approval page for one sign-in code, and nothing
 * else. This is the only same-origin address the shell hands to the system browser: the desktop
 * window signs in with Google by having the Person approve a code there (the phone's answer,
 * `googlePlace` in `@vivid/state`), and every other app address belongs inside the window.
 *
 * It is exact on purpose. The origin is the saved server's and uses a page scheme, never a
 * WebSocket's. The path is the approval page alone. The query is one `user_code` in the shape the
 * server issues, then at most `signin=google`, in the order `googlePlace` writes them: no other
 * parameter, no repeat, no other value. Credentials and a fragment are refused, so nothing a
 * document adds can ride along to the browser.
 */
export function isApprovalAddress(address: string, server: ServerSettings): boolean {
  if (!/^https?:/.test(address) || !isAppRequest(address, server)) return false
  return Option.exists(
    decodeUrl(address),
    (parsed) =>
      parsed.pathname === APPROVAL_PATH &&
      parsed.hash === '' &&
      isApprovalQuery([...parsed.searchParams.entries()]),
  )
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
