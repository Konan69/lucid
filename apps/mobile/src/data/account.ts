import { Effect, Option, Redacted, Schema } from 'effect'
import { AccountRefused, AccountUnreachable, type RefusalReason } from './refusal'
import { accountAddress, type ServerAddress } from './server'
import type { SignedIn } from './session'
import { bearer, request } from './transport'

/**
 * Signing in and out. These are Better Auth's own routes (`/api/auth/*`), the one part of the
 * product that is not a `VividRpc` call: the session they start is what every other call is
 * authenticated by. Each answer is read here; nothing downstream sees an undecoded body.
 *
 * With Better Auth's `bearer` plugin a successful sign-in also answers with the session's token
 * in the `set-auth-token` header, which is what a phone keeps in place of the cookie (verified
 * against `better-auth/dist/plugins/bearer/index.mjs`, better-auth 1.7.5).
 */

const UNREACHABLE = 'Vivid could not be reached at that address. Check the server and try again.'
const NO_SESSION =
  'That server signed you in but gave this device nothing to stay signed in with. Try again.'

const Refusal = Schema.fromJsonString(Schema.Struct({ message: Schema.optionalKey(Schema.String) }))
const decodeRefusal = Schema.decodeUnknownOption(Refusal)

/** Better Auth answers with a status; these are the ones that mean something a Person can act on. */
const REASONS = new Map<number, { reason: RefusalReason; message: string }>([
  [
    401,
    { reason: 'WrongCredentials', message: 'That email and password do not match an account.' },
  ],
  [
    403,
    { reason: 'WrongCredentials', message: 'That email and password do not match an account.' },
  ],
  [422, { reason: 'EmailTaken', message: 'An account with that email already exists.' }],
  [429, { reason: 'TooManyAttempts', message: 'Too many attempts. Wait a minute and try again.' }],
])

/** The refusal for an answer: the known reason for its status, else what the server said. */
const refusalFor = (status: number, body: string): AccountRefused => {
  const known = REASONS.get(status)
  if (known !== undefined) return new AccountRefused(known)
  return new AccountRefused({
    reason: 'Other',
    message: Option.getOrElse(
      Option.flatMap(decodeRefusal(body), (refusal) => Option.fromUndefinedOr(refusal.message)),
      () => UNREACHABLE,
    ),
  })
}

interface Posting {
  readonly server: ServerAddress
  readonly path: string
  readonly fields: Readonly<Record<string, string>>
  readonly headers: Readonly<Record<string, string>>
}

/** Posts one account request and hands back the answer unread: its status, text and token. */
const post = Effect.fn('Account.post')(function* (posting: Posting) {
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      request(accountAddress(posting.server, posting.path), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...posting.headers },
        body: JSON.stringify(posting.fields),
        signal,
      }),
    catch: () => new AccountUnreachable({ message: UNREACHABLE }),
  })
  const body = yield* Effect.tryPromise({
    try: () => response.text(),
    catch: () => new AccountUnreachable({ message: UNREACHABLE }),
  })
  return {
    ok: response.ok,
    status: response.status,
    body,
    token: Option.fromNullOr(response.headers.get('set-auth-token')),
  }
})

/** Starts a session with email and password and returns its token. */
const enter = Effect.fn('Account.enter')(function* (posting: Omit<Posting, 'headers'>) {
  const answer = yield* post({ ...posting, headers: {} })
  if (!answer.ok) {
    return yield* refusalFor(answer.status, answer.body)
  }
  if (Option.isNone(answer.token))
    return yield* new AccountRefused({ reason: 'NoSession', message: NO_SESSION })
  return Redacted.make(answer.token.value)
})

export const signUp = (
  server: ServerAddress,
  account: { readonly name: string; readonly email: string; readonly password: string },
) => enter({ server, path: 'sign-up/email', fields: account })

export const signIn = (
  server: ServerAddress,
  account: { readonly email: string; readonly password: string },
) => enter({ server, path: 'sign-in/email', fields: account })

/** One account request made as the signed-in Person, which either went through or was refused. */
const asPerson = Effect.fn('Account.asPerson')(function* (
  session: SignedIn,
  path: string,
  fields: Readonly<Record<string, string>>,
) {
  const answer = yield* post({
    server: session.server,
    path,
    fields,
    headers: bearer(session.token),
  })
  yield* answer.ok ? Effect.void : Effect.fail(refusalFor(answer.status, answer.body))
})

/** Ends the session on the server, so its token stops working everywhere. */
export const signOut = (session: SignedIn) => asPerson(session, 'sign-out', {})

/** The part of Better Auth's session answer that says when the session ends. */
const Ending = Schema.fromJsonString(
  Schema.Struct({ session: Schema.Struct({ expiresAt: Schema.String }) }),
)
const decodeEnding = Schema.decodeUnknownOption(Ending)

/**
 * When the session this phone holds ends, in epoch milliseconds, as the server says (Better
 * Auth's `get-session`, asked with the session's own token; `session.expiresAt` is an ISO date,
 * better-auth 1.7.5 `dist/api/routes/session.mjs`). The phone keeps a token and nothing about
 * it, so this is the only way it knows. None when the server cannot be reached or the answer
 * does not read as a date: what depends on it (`data/snapshot.ts`) then keeps nothing.
 */
export const sessionExpiry = (session: SignedIn): Effect.Effect<Option.Option<number>> =>
  Effect.tryPromise({
    // The body is read inside the same attempt as the request, so the one abort signal covers
    // both: an interrupted call stops a body still arriving, not only the headers.
    try: (signal) =>
      request(accountAddress(session.server, 'get-session'), {
        method: 'GET',
        headers: bearer(session.token),
        signal,
      }).then((response) =>
        response.ok ? response.text().then(Option.some) : Option.none<string>(),
      ),
    catch: () => new AccountUnreachable({ message: UNREACHABLE }),
  }).pipe(
    Effect.map((body) =>
      body.pipe(
        Option.flatMap(decodeEnding),
        Option.map((here) => Date.parse(here.session.expiresAt)),
        Option.filter((until) => Number.isFinite(until)),
      ),
    ),
    Effect.catchTag('AccountUnreachable', () => Effect.succeed(Option.none<number>())),
  )
