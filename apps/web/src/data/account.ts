import { VividRpcClient } from '@vivid/client-runtime'
import { Array as Arr, Data, Effect, Layer, Option, Order, Redacted, Schema } from 'effect'
import * as FetchHttpClient from 'effect/unstable/http/FetchHttpClient'
import { deviceName } from './device'

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
  [403, 'That email and password do not match an account.'],
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
    yield* Effect.fail(new AccountRefused({ message: reasonFor(response.status, said) }))
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
const adoptTimeZone = Effect.gen(function* () {
  const client = yield* VividRpcClient
  yield* client.PatchSettings({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })
}).pipe(Effect.provide(oneShot), Effect.ignore)

/** Makes an account and gives it the time zone of the browser it was made in. */
export const createAccount = (input: {
  readonly name: string
  readonly email: string
  readonly password: string
}) => Effect.andThen(signUp(input), adoptTimeZone)

export const signIn = (input: { readonly email: string; readonly password: string }) =>
  post('sign-in/email', input)

export const signOut = () => post('sign-out', {})

/** One place this Person is signed in, as Better Auth lists it. Its token is a credential. */
const Session = Schema.Struct({
  id: Schema.String,
  token: Schema.Redacted(Schema.String),
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
    if (!response.ok) return yield* Effect.fail(new AccountRefused({ message: UNREACHABLE }))
    const body = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: () => new AccountRefused({ message: UNREACHABLE }),
    })
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(body).pipe(
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
export const signedInDevices = () =>
  Effect.gen(function* () {
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
  })

/** Signs one other device out. It has to sign in, or be paired, again. */
export const signOutDevice = (device: SignedInDevice) =>
  post('revoke-session', { token: Redacted.value(device.token) })

/** Signs out everywhere except here. */
export const signOutElsewhere = () => post('revoke-other-sessions', {})

/** Lets a device that is waiting with this code sign in as the Person approving it. */
export const approveDevice = (userCode: string) => post('device/approve', { userCode })

/** Tells a waiting device it will not be signed in. */
export const denyDevice = (userCode: string) => post('device/deny', { userCode })

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
