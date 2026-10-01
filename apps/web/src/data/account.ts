import { Data, Effect, Option, Schema } from 'effect'

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

export const signUp = (input: {
  readonly name: string
  readonly email: string
  readonly password: string
}) => post('sign-up/email', input)

export const signIn = (input: { readonly email: string; readonly password: string }) =>
  post('sign-in/email', input)

export const signOut = () => post('sign-out', {})

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
  location.assign(path)
}
