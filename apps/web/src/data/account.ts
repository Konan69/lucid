import { VividRpcClient } from '@vivid/client-runtime'
import { Array as Arr, Data, Effect, Layer, Option, Order, Redacted, Schema } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import { auth } from './auth'
import { deviceName } from './device'
import { firstArrival, googleAddresses, outcomeOf, type GoogleOutcome } from './google'

/**
 * Signing in and out. These are Better Auth's own routes (`/api/auth/*`), the one part of the
 * product that is not a `VividRpc` call: the session cookie they set is what every other call is
 * authenticated by. Each response is decoded here; nothing downstream sees an undecoded body.
 */

/** Why an account request did not succeed, in words the form can show beside the field. */
export class AccountRefused extends Data.TaggedError('AccountRefused')<{
  readonly message: string
}> {}

const Refusal = Schema.Struct({ message: Schema.optionalKey(Schema.String) })
const decodeRefusalText = Schema.decodeUnknownOption(Schema.fromJsonString(Refusal))

const UNREACHABLE = 'Vivid could not be reached. Try again.'

/** Better Auth's wording is for developers; these are the cases a Person can act on. */
const REASONS = new Map([
  [401, 'That email and password do not match an account.'],
  // A 403 is the server declining where the request came from, never a wrong password. It used to
  // be worded as one, which sent a Person whose desktop app was misconfigured to retype theirs.
  [403, 'This Vivid did not accept a request from here. Try again in a moment.'],
  [422, 'An account with that email already exists. Sign in instead.'],
  [429, 'Too many attempts. Wait a minute and try again.'],
])

/** What to tell the Person: the known reason for this status, else what the server said. */
const reasonFor = (status: number, said: Option.Option<string>) => {
  const known = REASONS.get(status)
  return known === undefined ? Option.getOrElse(said, () => UNREACHABLE) : known
}

type AccountRequest = Readonly<Record<string, string>>

/** Posts one account request on the page's own origin, cookies included. */
const post = Effect.fn('Account.post')(function* (path: string, body: AccountRequest) {
  const response = yield* Effect.tryPromise({
    try: () =>
      fetch(`/api/auth/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      }),
    catch: () => new AccountRefused({ message: UNREACHABLE }),
  })
  if (!response.ok) {
    // Only a refusal's body is read: a success sets the session cookie and says nothing we use.
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: () => new AccountRefused({ message: UNREACHABLE }),
    })
    const said = Option.flatMap(decodeRefusalText(text), (refusal) =>
      Option.fromUndefinedOr(refusal.message),
    )
    return yield* new AccountRefused({ message: reasonFor(response.status, said) })
  }
})

const signUp = (input: {
  readonly name: string
  readonly email: string
  readonly password: string
}) => post('sign-up/email', input)

/** The one-shot product endpoint, for the moment after signing up when the live socket is stale. */
const oneShot = VividRpcClient.layer({ url: '/api/rpc' }).pipe(Layer.provide(FetchHttpClient.layer))

/**
 * Tells the server which time zone this browser is in, right after an account is made, so that
 * "tomorrow at 9" means the Person's own nine o'clock from their first message.
 *
 * It goes over HTTP: the page's live socket was opened before there was a session and cannot
 * speak for the new Person. If it does not get through the account still stands, the zone stays at
 * the server's default, and Settings shows it and lets the Person change it, so a failure here is
 * deliberately not a reason to refuse the sign-up.
 */
const tellTimeZone = Effect.gen(function* () {
  const client = yield* VividRpcClient
  yield* client.PatchSettings({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })
}).pipe(Effect.withSpan('Account.tellTimeZone'))
// @effect-diagnostics-next-line strictEffectProvide:off -- this one call must not use the app's client (its live socket was opened before the session existed), so it is given its own one-shot HTTP client here, the only place that client is used and the whole of its lifetime
const adoptTimeZone = Effect.ignore(Effect.provide(tellTimeZone, oneShot))

/** Makes an account and gives it the time zone of the browser it was made in. */
export const createAccount = (input: {
  readonly name: string
  readonly email: string
  readonly password: string
}) => Effect.andThen(signUp(input), adoptTimeZone)

export const signIn = (input: { readonly email: string; readonly password: string }) =>
  post('sign-in/email', input)

/** Why Google sign-in did not start, as the outcome the welcome has a sentence for. */
export class GoogleRefused extends Data.TaggedError('GoogleRefused')<{
  readonly outcome: GoogleOutcome
}> {}

/** Better Auth's refusal as its client hands it back: the body's `code`, beside the status. */
const decodeGoogleRefusal = Schema.decodeUnknownOption(
  Schema.Struct({ code: Schema.optionalKey(Schema.String) }),
)

/**
 * Starts signing in with Google, for a new Person and a returning one alike: Google is one
 * action, and Better Auth makes the account when there is none.
 *
 * This is Better Auth's client doing what it does (`signIn.social`, better-auth 1.7.5): it posts
 * to `/api/auth/sign-in/social`, the server keeps the state of this attempt in a cookie and
 * answers with Google's address, and the client's own redirect plugin
 * (`dist/client/fetch-plugins.mjs`) sends the page there. So on success this page is already on
 * its way out, and there is nothing more to do here. Coming back is `readAddress` (a failure) or
 * `adoptFirstArrival` (a new account).
 *
 * The one refusal a Person can meet before leaving is a server that was given no Google client.
 * There is no way to ask a server which sign-in methods it has, so the button is always offered
 * and this is where a Vivid without Google says so.
 */
export const continueWithGoogle = Effect.fn('Account.continueWithGoogle')(function* (
  destination: string,
) {
  const answer = yield* Effect.tryPromise({
    try: () => auth.signIn.social({ provider: 'google', ...googleAddresses(destination) }),
    catch: () => new GoogleRefused({ outcome: 'Unreachable' }),
  })
  if (answer.error === null) return
  const code = Option.flatMap(decodeGoogleRefusal(answer.error), (refusal) =>
    Option.fromUndefinedOr(refusal.code),
  )
  return yield* new GoogleRefused({
    outcome: Option.match(code, { onNone: () => 'Failed', onSome: outcomeOf }),
  })
})

/**
 * Gives an account that Google sign-in just made the time zone of this browser, the way
 * `createAccount` does for one made with a password.
 *
 * A Google sign-in leaves the page before there is an account and returns after, so the only
 * moment to do it is the landing. Better Auth sends a new account, and only a new one, to
 * `newUserCallbackURL`, which `googleAddresses` marks with `joined=google`. This reads that mark
 * when the page loads, takes it out of the address bar so a reload does not act on it twice, and
 * makes the same call. A returning Person lands without the mark, so a zone they chose in
 * Settings is never overwritten by signing in again.
 *
 * Outside a browser (a test drawing a screen) there is no address and nothing is done.
 */
export const adoptFirstArrival = Effect.suspend(() => {
  if (!('location' in globalThis)) return Effect.void
  return Option.match(firstArrival(`${location.pathname}${location.search}`), {
    onNone: () => Effect.void,
    onSome: (address) => {
      history.replaceState(history.state, '', address)
      return Effect.andThen(
        justJoined,
        Effect.fn(function* (joined) {
          if (joined) yield* adoptTimeZone
        }),
      )
    },
  })
})

/** How long after an account is made its landing still counts as the first one. */
const FIRST_ARRIVAL_MS = 10 * 60 * 1000

/** The part of Better Auth's session answer that says when this Person's account was made. */
const Joined = Schema.Struct({ user: Schema.Struct({ createdAt: Schema.String }) })

/**
 * Whether the account signed in here was made in the last few minutes, as the server says.
 *
 * The `joined=google` mark is only an address, and anyone can send a signed-in Person a link that
 * carries it; acted on alone it let such a link replace a time zone the Person had chosen. The
 * account's own creation time is the server's, so the mark is now only the reason to ask, and
 * this is the authority. No session, or an answer that cannot be read, is not a new account.
 */
const justJoined = Effect.suspend(() =>
  read('get-session', Joined).pipe(
    Effect.map((here) => Date.now() - Date.parse(here.user.createdAt) < FIRST_ARRIVAL_MS),
    Effect.orElseSucceed(() => false),
  ),
)

/** Ends this browser's session. Described once; each sign-out starts it afresh. */
export const signOut = post('sign-out', {})

/** The part of Better Auth's session answer that says when the session ends. */
const Ending = Schema.Struct({ session: Schema.Struct({ expiresAt: Schema.String }) })

/**
 * When this browser's session ends, in epoch milliseconds, as the server says (Better Auth's
 * `get-session`, whose `session.expiresAt` is an ISO date; better-auth 1.7.5
 * `dist/api/routes/session.mjs`). The browser cannot read its own session cookie, so this is the
 * only way it knows. None when there is no session, the server cannot be reached, or the answer
 * does not read as a date: what depends on it (`data/snapshot.ts`) then keeps nothing.
 */
export const sessionExpiry = Effect.suspend(() =>
  read('get-session', Ending).pipe(
    Effect.map((here) => Date.parse(here.session.expiresAt)),
    Effect.map((until) => (Number.isFinite(until) ? Option.some(until) : Option.none<number>())),
    Effect.orElseSucceed(() => Option.none<number>()),
  ),
)

/**
 * One place this Person is signed in, as Better Auth lists it. Its token is a credential, so it
 * is wrapped as it is read: `RedactedFromValue` decodes the plain string the server sends, where
 * `Schema.Redacted` accepts only a value that is already wrapped and refused every answer.
 */
const Session = Schema.Struct({
  id: Schema.String,
  token: Schema.RedactedFromValue(Schema.String),
  userAgent: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
})
const Sessions = Schema.Array(Session)
const Here = Schema.Struct({ session: Schema.Struct({ id: Schema.String }) })

/** Reads one account answer on the page's own origin, cookies included, and decodes it. */
const read = <Value, Encoded>(path: string, schema: Schema.Codec<Value, Encoded>) =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () => fetch(`/api/auth/${path}`, { credentials: 'same-origin' }),
      catch: () => new AccountRefused({ message: UNREACHABLE }),
    })
    if (!response.ok) return yield* new AccountRefused({ message: UNREACHABLE })
    const body = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: () => new AccountRefused({ message: UNREACHABLE }),
    })
    return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(body).pipe(
      Effect.mapError(() => new AccountRefused({ message: UNREACHABLE })),
    )
  })

/** Somewhere this Person is signed in: what to call it, when it was last used, and whether it is this one. */
export interface SignedInDevice {
  readonly id: string
  readonly name: string
  readonly lastUsedAt: number
  readonly here: boolean
  /** What signing it out takes. Kept wrapped: it is that device's credential. */
  readonly token: Redacted.Redacted
}

/**
 * Everywhere this Person is signed in: browsers, the desktop app, phones. This device first, then
 * the most recently used. It is what lets a lost phone or an old shared computer be signed out
 * without changing a password.
 */
export const signedInDevices = Effect.gen(function* () {
  const [sessions, here] = yield* Effect.all([
    read('list-sessions', Sessions),
    read('get-session', Here),
  ])
  return Arr.sort(
    sessions.map((session): SignedInDevice => ({
      id: session.id,
      name: deviceName(Option.fromNullOr(session.userAgent)),
      lastUsedAt: Date.parse(session.updatedAt),
      here: session.id === here.session.id,
      token: session.token,
    })),
    Order.combine(
      Order.mapInput(Order.flip(Order.Boolean), (device: SignedInDevice) => device.here),
      Order.mapInput(Order.flip(Order.Number), (device: SignedInDevice) => device.lastUsedAt),
    ),
  )
}).pipe(Effect.withSpan('Account.signedInDevices'))

/** Signs one other device out. It has to sign in again. */
export const signOutDevice = (device: SignedInDevice) =>
  post('revoke-session', { token: Redacted.value(device.token) })

/** Signs out everywhere except here. */
export const signOutElsewhere = post('revoke-other-sessions', {})

/**
 * The session lives in a cookie the live socket read when it opened, so a change of session means
 * a new socket. Reloading is the honest way to get one: every store starts from nothing as the
 * new Person, and nothing from the previous session can still be on screen.
 */
export const reload = (path: string) => {
  // The path can come from a link someone else wrote (a return address after signing in), and
  // `//elsewhere.example/x` is a path that names another site. Only a place in this app is gone
  // to; anything else is the first screen.
  const place = Option.liftThrowable((value: string) => new URL(value, location.origin))(path)
  const here = Option.filter(place, (target) => target.origin === location.origin)
  location.assign(
    Option.match(here, {
      onNone: () => '/',
      onSome: (target) => `${target.pathname}${target.search}`,
    }),
  )
}
