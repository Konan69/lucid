import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

/**
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
export const SignInVerifier = Schema.RedactedFromValue(
  Schema.String.check(Schema.isPattern(BASE64URL_OF_32_BYTES)),
)
export type SignInVerifier = typeof SignInVerifier.Type

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
const LoopbackPortFromText = Schema.NumberFromString.pipe(Schema.decodeTo(LoopbackPort))

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
const encodeStart = Schema.encodeSync(SignInStart)

/**
 * The address the shell opens in the system browser to start an attempt on a server. The origin
 * is the shell's saved server and never something a document supplied.
 */
export const signInStartAddress = (origin: string, start: SignInStart): string => {
  const address = new URL(SIGN_IN_PLACES.start, origin)
  const fields = encodeStart(start)
  for (const [name, value] of Object.entries(fields)) address.searchParams.set(name, value)
  return address.href
}

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

/**
 * The loopback address the server sends the browser back to. Only the port varies: the host is
 * the IPv4 loopback literal, as RFC 8252 section 8.3 asks, never a name that could resolve
 * elsewhere.
 */
export const signInReturnAddress = (port: LoopbackPort, back: SignInReturn): string => {
  const address = new URL(`http://127.0.0.1:${port}/`)
  address.searchParams.set('state', back.state)
  const [name, value] = SignInReturn.match<readonly [name: string, value: string]>(back, {
    Granted: ({ code }) => ['code', code],
    Failed: () => ['error', 'sign_in_failed'],
  })
  address.searchParams.set(name, value)
  return address.href
}

/**
 * Reads a return off the query of a request to the loopback address. Anything that is not one
 * (another program probing the port, a browser asking for an icon) is nothing.
 */
export const readSignInReturn = (query: URLSearchParams): Option.Option<SignInReturn> =>
  Option.map(decodeReturnFields(Object.fromEntries(query)), (fields) =>
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
