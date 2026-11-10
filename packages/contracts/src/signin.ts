import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

/**
 * An app signing in with Google through a browser it does not own, as the parties of it agree on
 * the wire. The desktop app comes first, and the phone app, which differs in how the browser
 * hands back, is at the end of this file.
 *
 * The desktop app signing in with Google, as the three parties of it agree on the wire: the
 * desktop shell that starts it, the server that carries it through Google, and the app's window
 * that ends it.
 *
 * Google will not sign anyone in inside an app's own window, so the system browser does that
 * part. What matters is how the browser hands the result back to the app that asked, and to no
 * other. This is the answer Better Auth's own desktop integration gives (`@better-auth/electron`
 * 1.7.5, `requestAuth` and `authenticate` in `dist/client.mjs`, `electronToken` in
 * `dist/index.mjs`): the app makes a secret, sends the server only its digest, and at the end
 * trades a one-use code plus the secret for a session. Whoever sees the code on its way back
 * cannot use it without the secret, which never left the app.
 *
 * One step differs from that integration, and it is why this contract has a port. The code comes
 * back on a loopback address the shell is listening on (RFC 8252 section 7.3) and not on a
 * `vivid://` link. A browser asks before it opens another app for a link like that, every time;
 * it asks nothing before going to an address on the same computer. It also works in an app that
 * was never installed, where no link scheme is registered.
 */

/** Base64url of 32 bytes, without padding: the form of both the secret and its digest. */
const BASE64URL_OF_32_BYTES = /^[A-Za-z0-9_-]{43}$/u

/**
 * The digest of the app's secret (SHA-256, base64url, as PKCE's `S256` writes it). It is public:
 * it goes to the server through the browser's address bar, and proves nothing by itself.
 */
export const SignInChallenge = Schema.String.check(Schema.isPattern(BASE64URL_OF_32_BYTES)).pipe(
  Schema.brand('SignInChallenge'),
)
export type SignInChallenge = typeof SignInChallenge.Type

/**
 * The app's secret: 32 random bytes, base64url. It stays in the app until the trade, and is
 * `Redacted` everywhere it is held so that it cannot be logged or drawn by accident.
 */
const SignInVerifier = Schema.RedactedFromValue(
  Schema.String.check(Schema.isPattern(BASE64URL_OF_32_BYTES)),
)
type SignInVerifier = typeof SignInVerifier.Type

/**
 * Names one attempt, so the shell answers only the return of the attempt it started and the
 * server refuses a code traded under another attempt's name. Sixteen letters and digits, as the
 * reference makes it.
 */
export const SignInAttempt = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9]{16}$/u)).pipe(
  Schema.brand('SignInAttempt'),
)
export type SignInAttempt = typeof SignInAttempt.Type

/**
 * The one-use code the server issues once Google has signed the Person in. Thirty-two letters
 * and digits, good for five minutes, and worth nothing without the secret its attempt was
 * started with.
 */
export const SignInCode = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9]{32}$/u)).pipe(
  Schema.brand('SignInCode'),
)
export type SignInCode = typeof SignInCode.Type

/**
 * The port the shell listens on for the return. The operating system picks it, so it is never a
 * reserved one; the server sends a browser to this port on the loopback address and nowhere else.
 */
export const LoopbackPort = Schema.Int.check(
  Schema.isBetween({ minimum: 1024, maximum: 65_535 }),
).pipe(Schema.brand('LoopbackPort'))
export type LoopbackPort = typeof LoopbackPort.Type

/** The same port as an address carries it: text that reads as that number. */
const LoopbackPortFromText = Schema.FiniteFromString.pipe(Schema.decodeTo(LoopbackPort))

/** Where each step is served, under the server's own origin. */
export const SIGN_IN_PLACES = {
  /** The system browser is opened here; it leaves for Google at once. */
  start: '/api/auth/desktop/google',
  /** The window trades the code here. */
  trade: '/api/auth/desktop/session',
} as const

/** What the shell puts on the address it opens the system browser on. */
export const SignInStart = Schema.Struct({
  challenge: SignInChallenge,
  state: SignInAttempt,
  port: LoopbackPortFromText,
})
export type SignInStart = typeof SignInStart.Type
const encodeStart = Schema.encodeOption(SignInStart)

/**
 * A query written out: each value percent-encoded, joined in the order given. Addresses are
 * built as text here because this package is read by the server, the desktop shell and the web
 * app alike and assumes none of their platforms.
 */
const queryOf = (fields: Readonly<Record<string, string>>): string =>
  Object.entries(fields)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join('&')

/**
 * The address the shell opens in the system browser to start an attempt on a server. The origin
 * is the shell's saved server (scheme, host and port, with no path) and never something a
 * document supplied. There is none for a start that will not encode: the shell has nothing to
 * open then, and says so as it does for a browser that would not open.
 */
export const signInStartAddress = (origin: string, start: SignInStart): Option.Option<string> =>
  Option.map(encodeStart(start), (query) => `${origin}${SIGN_IN_PLACES.start}?${queryOf(query)}`)

/**
 * How an attempt comes back to the shell: with a code, or with the news that there is none. A
 * failure says only that. Why Google or the server did not sign the Person in stays on the
 * server; the shell and the window need it only to say that it did not finish.
 */
export const SignInReturn = Schema.TaggedUnion({
  Granted: { code: SignInCode, state: SignInAttempt },
  Failed: { state: SignInAttempt },
})
export type SignInReturn = typeof SignInReturn.Type

/**
 * The same return as the loopback address carries it: `code` and `state`, or `error` and `state`.
 * What `error` says is not read; its presence without a code is the failure.
 */
const ReturnFields = Schema.Union([
  Schema.Struct({ code: SignInCode, state: SignInAttempt }),
  Schema.Struct({ error: Schema.String, state: SignInAttempt }),
])
const decodeReturnFields = Schema.decodeUnknownOption(ReturnFields)

/** A return as the names and values an address carries it in. */
const returnFields = (back: SignInReturn): Readonly<Record<string, string>> =>
  SignInReturn.match<Readonly<Record<string, string>>>(back, {
    Granted: ({ code, state }) => ({ state, code }),
    Failed: ({ state }) => ({ state, error: 'sign_in_failed' }),
  })

/**
 * The loopback address the server sends the browser back to. Only the port varies: the host is
 * the IPv4 loopback literal, as RFC 8252 section 8.3 asks, never a name that could resolve
 * elsewhere.
 */
export const signInReturnAddress = (port: LoopbackPort, back: SignInReturn): string =>
  `http://127.0.0.1:${port}/?${queryOf(returnFields(back))}`

/**
 * Reads a return off the query of a request to the loopback address, given as its names and
 * values. Anything that is not one (another program probing the port, a browser asking for an
 * icon) is nothing.
 */
export const readSignInReturn = (
  query: Readonly<Record<string, string>>,
): Option.Option<SignInReturn> =>
  Option.map(decodeReturnFields(query), (fields) =>
    'code' in fields
      ? SignInReturn.cases.Granted.make(fields)
      : SignInReturn.cases.Failed.make({ state: fields.state }),
  )

/** What the window sends to trade a code for a session. */
export const SignInTrade = Schema.Struct({
  code: SignInCode,
  state: SignInAttempt,
  verifier: SignInVerifier,
})
export type SignInTrade = typeof SignInTrade.Type

/**
 * Whether Google sign-in just made this Person's account or found one. The window needs it for
 * the one thing a first arrival does that a later one does not: adopt this computer's time zone
 * (`firstArrival` in the web app's `data/google.ts`).
 */
export const SignInArrival = Schema.Literals(['first', 'returning'])
export type SignInArrival = typeof SignInArrival.Type

/** The answer to a trade. The session itself is the cookie the answer sets, never a field here. */
export const SignedIn = Schema.Struct({ arrival: SignInArrival })
export type SignedIn = typeof SignedIn.Type

/**
 * The phone app signing in with Google. It is the same exchange as the desktop app's above (a
 * secret the app keeps, its digest through Google, a one-use code traded with the secret), and
 * differs in the two places a phone differs from a computer.
 *
 * The return is a link in the app's own scheme and not a loopback address: a phone app listens
 * on no port, and the system opens the app that registered the scheme. That is how Better Auth's
 * own phone integration comes back (`@better-auth/expo` 1.7.5, the `callbackURL` it gives
 * `Browser.openAuthSessionAsync` in `dist/client.js`). Which browser the phone opens is the
 * phone app's own matter (`apps/mobile/src/data/google.ts`) and nothing here depends on it.
 *
 * And the phone holds no cookie. It keeps the session's token and sends it as a bearer token, so
 * the trade answers with the token itself.
 *
 * One thing is not taken from that integration: it puts the session cookie on the link
 * (`hooks.after` in its `dist/index.js`). A link in a custom scheme can be claimed by another app
 * on the phone (RFC 8252 section 8.1), and whatever reads it would then hold the session. Here
 * the link carries only the one-use code, which is worth nothing without the secret.
 */

/** Where each step of the phone's sign-in is served, under the server's own origin. */
export const PHONE_SIGN_IN_PLACES = {
  /** The browser is opened here; it leaves for Google at once. */
  start: '/api/auth/phone/google',
  /** The app trades the code here. */
  trade: '/api/auth/phone/session',
} as const

/**
 * The scheme the phone app registers (`scheme` in `apps/mobile/app.json`). Server-built account
 * and Integration return links use it so the browser hands back to the installed phone app.
 */
export const PHONE_SCHEME = 'vivid'

/** Account sign-in and Integration sign-in share the phone's registered scheme. */
export const PHONE_SIGN_IN_RETURN = `${PHONE_SCHEME}://signin`

/** What the phone puts on the address it opens the browser on. */
export const PhoneSignInStart = Schema.Struct({
  challenge: SignInChallenge,
  state: SignInAttempt,
})
export type PhoneSignInStart = typeof PhoneSignInStart.Type

/** The address the phone opens in the browser to start an attempt on its server. */
export const phoneSignInStartAddress = (origin: string, start: PhoneSignInStart): string =>
  `${origin}${PHONE_SIGN_IN_PLACES.start}?${queryOf(start)}`

/** The link the server sends the browser back to, with what came of the attempt. */
export const phoneSignInReturnAddress = (back: SignInReturn): string =>
  `${PHONE_SIGN_IN_RETURN}?${queryOf(returnFields(back))}`

/** One `name=value` of a query, decoded. A value that is not valid percent-encoding is nothing. */
const fieldOf = (pair: string): Option.Option<readonly [string, string]> => {
  const at = pair.indexOf('=')
  if (at < 1) return Option.none()
  return Option.map(
    Option.liftThrowable(decodeURIComponent)(pair.slice(at + 1)),
    (value) => [pair.slice(0, at), value] as const,
  )
}

/**
 * Reads a return off the link the browser handed the app. The link is read as text, because
 * this package assumes no platform and a phone's `URL` does not parse a custom scheme the way a
 * browser's does. A link that is not the return link, or carries no return, is nothing.
 */
export const readPhoneSignInReturn = (link: string): Option.Option<SignInReturn> => {
  // iOS hands the sign-in sheet's link back as its URL's `absoluteString`, which may carry a
  // trailing slash on the place or a fragment; neither changes which return it is.
  const cut = link.search(/#/u)
  const bare = cut === -1 ? link : link.slice(0, cut)
  const mark = bare.indexOf('?')
  if (mark === -1 || bare.slice(0, mark).replace(/\/$/u, '') !== PHONE_SIGN_IN_RETURN)
    return Option.none()
  const fields = bare
    .slice(mark + 1)
    .split('&')
    .map(fieldOf)
  return Option.flatMap(Option.all(fields), (pairs) => readSignInReturn(Object.fromEntries(pairs)))
}

/**
 * The answer to the phone's trade: the session's token, which the phone keeps and sends as a
 * bearer token. It is `Redacted` wherever it is held. Which arrival it was is not said: the phone
 * does nothing differently on a first one.
 */
export const PhoneSignedIn = Schema.Struct({
  token: Schema.RedactedFromValue(Schema.NonEmptyString),
})
export type PhoneSignedIn = typeof PhoneSignedIn.Type
