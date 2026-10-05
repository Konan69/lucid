import { PersonId } from '@vivid/contracts'
import {
  LoopbackPort,
  SignedIn,
  SignInArrival,
  SignInAttempt,
  SignInChallenge,
  SignInCode,
  SignInReturn,
  signInReturnAddress,
  SignInStart,
  SignInTrade,
} from '@vivid/contracts/signin'
import type { BetterAuthPlugin, GenericEndpointContext } from 'better-auth'
import {
  addOAuthServerContext,
  createAuthEndpoint,
  createAuthMiddleware,
  getOAuthState,
} from 'better-auth/api'
import { setSessionCookie } from 'better-auth/cookies'
import { generateRandomString } from 'better-auth/crypto'
import {
  generateCodeChallenge,
  generateIdTokenNonce,
  generateState,
  getOAuthCallbackPath,
} from 'better-auth/oauth2'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'

/**
 * The desktop app signing in with Google: one attempt carried from the app, through the system
 * browser and Google, and back to the app that started it.
 *
 * The app's window cannot run Google's sign-in (Google refuses an embedded window), so the system
 * browser does. The mechanism is Better Auth's own desktop integration, `@better-auth/electron`
 * 1.7.5 (`dist/index.mjs`), with Vivid's names: the app sends the digest of a secret it keeps;
 * when a sign-in succeeds, a hook after it stores that digest beside the Person as a one-use
 * verification value good for 300 seconds (`handleTransfer`, run from the `hooks.after` entry
 * that matches `/callback` and requires `ctx.context.newSession`); and the app trades the code
 * and the secret for a session of its own (`electronToken`: `consumeVerificationValue`, the state
 * check, `generateCodeChallenge` against the stored digest, `createSession`, `setSessionCookie`).
 * A code read off the browser's address bar is worth nothing without the secret, which never
 * left the app.
 *
 * Two things differ from that integration, each for a reason this product has:
 *
 * - The code goes back on a loopback address (`signInReturnAddress`, RFC 8252 section 7.3), not
 *   on a link the browser must ask to open (`electronProxyClient` in `dist/proxy.mjs` sends it to
 *   `<scheme>:/auth/callback`). The Person presses nothing in the browser after Google.
 * - The attempt rides inside Google's sign-in state, as server-trusted context
 *   (`addOAuthServerContext`), and the hook sends the browser to the app itself. The integration
 *   keeps the attempt in a signed cookie, leaves the code in a cookie a page can read, and has a
 *   page of the web app read it and leave again. Here no page loads between Google and the app.
 *
 * What is kept exactly is where a code comes from: only from a sign-in that has just succeeded,
 * for the Person that sign-in made the session for. No route issues a code to a browser because
 * it is signed in. Another program on the computer can start an attempt, but it gets a code only
 * if the Person then chooses an account at Google, which is as far as any app signing in through
 * a browser can be protected (RFC 8252 section 8.6).
 *
 * It is built from Better Auth's public plugin API alone, like the integration it follows. The
 * handlers are promise chains because that is what Better Auth calls and is called with; nothing
 * here is application logic that could live in an Effect program.
 */

/** The key the attempt is kept under in the sign-in state's server context. */
const ATTEMPT = 'desktopSignIn'
/** A code that is waiting to be traded. */
const GRANTED = 'desktop-grant:'

/** How long a code is good for: the integration's `codeExpiresIn`, 300 seconds. */
const GRANT_LASTS_MS = 300 * 1000

/**
 * What an attempt is, as it rides through Google: where the app listens, the digest of its
 * secret, and its name. It is the start's own fields with the port as a number.
 */
const Attempt = Schema.Struct({
  challenge: SignInChallenge,
  state: SignInAttempt,
  port: LoopbackPort,
})
type Attempt = typeof Attempt.Type
const encodeAttempt = Schema.encodeSync(Attempt)

/**
 * The part of a sign-in's state the hook reads, when the sign-in is a desktop attempt: the
 * attempt, and the landing Better Auth uses for an account it just made. A sign-in started any
 * other way has no attempt in its server context and does not decode, which is how the hook
 * tells them apart.
 */
const Round = Schema.Struct({
  newUserURL: Schema.String,
  serverContext: Schema.Struct({ [ATTEMPT]: Attempt }),
})
const decodeRound = Schema.decodeUnknownOption(Round)

/**
 * What a code stands for: the Person the sign-in made a session for, the digest the trade must
 * match, the attempt it belongs to, and whether Google made the account just now.
 */
const Granted = Schema.fromJsonString(
  Schema.Struct({
    person: PersonId,
    challenge: SignInChallenge,
    state: SignInAttempt,
    arrival: SignInArrival,
  }),
)
type Granted = typeof Granted.Type
const encodeGranted = Schema.encodeSync(Granted)
const decodeGranted = Schema.decodeUnknownOption(Granted)

/** The trade's answer as it goes out on the wire. */
const encodeSignedIn = Schema.encodeSync(SignedIn)

/**
 * Where Better Auth would land the browser if the hook below did not send it to the app. They
 * are the web app's own three landings for a Google sign-in (`googleAddresses` in its
 * `data/google.ts`): the app, the app marked as a first arrival, and the welcome saying that
 * Google sign-in did not finish. The hook always replaces them for a desktop attempt; they are
 * real places so that nothing is ever sent to an address that does not exist, and the second
 * differs from the first so that the hook can tell which one Better Auth chose.
 */
const landings = (origin: string) => ({
  callbackURL: `${origin}/`,
  newUserCallbackURL: `${origin}/?joined=google`,
  errorCallbackURL: `${origin}/?signin=returned`,
})

/**
 * Sends the browser to Google for one attempt, the way Better Auth's own `signInSocial` does it
 * (the redirect branch in `dist/api/routes/sign-in.mjs`): a nonce if Google's ID token needs one,
 * the sign-in state, and the provider's authorization address for Better Auth's own callback.
 *
 * `generateState` reads where the browser lands afterwards from the request body, because its
 * caller upstream is a POST. This route is a GET the system browser opens, so the landings are
 * given to it here. It also writes into the state whatever server context this request has
 * gathered (`getOAuthServerContext`), which is how the attempt reaches the callback.
 */
const toGoogle = (
  ctx: GenericEndpointContext,
  google: GenericEndpointContext['context']['socialProviders'][number],
  origin: string,
) => {
  const idTokenNonce = generateIdTokenNonce(google)
  return generateState({ ...ctx, body: landings(origin) }, { idTokenNonce })
    .then(({ state, codeVerifier }) =>
      google.createAuthorizationURL({
        state,
        codeVerifier,
        idTokenNonce,
        redirectURI: `${ctx.context.baseURL}${getOAuthCallbackPath(google)}`,
      }),
    )
    .then((address) => address.toString())
}

/**
 * `GET /api/auth/desktop/google`: where the desktop shell opens the system browser. It puts the
 * attempt into the sign-in state and leaves for Google at once.
 *
 * `addOAuthServerContext` is Better Auth's place for this (`dist/api/state/oauth.mjs`): unlike a
 * request's `additionalData`, what is put there cannot be supplied by a client, and it comes back
 * at the callback as `getOAuthState().serverContext`.
 *
 * Anything may open this address, with any digest and any port; that grants nothing. What comes
 * of it is a browser at Google's account chooser, which has five minutes (the life of the state
 * cookie `generateGenericState` sets) and, if the Person chooses, a code sent to that same
 * computer's loopback address, good only with the secret behind the digest.
 */
const started = (origin: string) =>
  createAuthEndpoint(
    '/desktop/google',
    { method: 'GET', query: Schema.toStandardSchemaV1(SignInStart) },
    (ctx) => {
      const google = ctx.context.socialProviders.find((provider) => provider.id === 'google')
      if (google === undefined)
        return Promise.reject(ctx.error('NOT_FOUND', { message: 'Google sign-in is not set up' }))
      return addOAuthServerContext({ [ATTEMPT]: encodeAttempt(ctx.query) })
        .then(() => toGoogle(ctx, google, origin))
        .then((address) => Promise.reject(ctx.redirect(address)))
    },
  )

/** Issues the code for an attempt, for the Person a sign-in has just made a session for. */
const grant = (
  ctx: GenericEndpointContext,
  attempt: Attempt,
  person: PersonId,
  arrival: SignInArrival,
) => {
  const code = SignInCode.make(generateRandomString(32, 'a-z', 'A-Z', '0-9'))
  return ctx.context.internalAdapter
    .createVerificationValue({
      identifier: `${GRANTED}${code}`,
      value: encodeGranted({
        person,
        challenge: attempt.challenge,
        state: attempt.state,
        arrival,
      }),
      expiresAt: new Date(Date.now() + GRANT_LASTS_MS),
    })
    .then(() => SignInReturn.cases.Granted.make({ code, state: attempt.state }))
}

/**
 * What the app is told for a callback that has just run. A callback that made no session did not
 * sign anyone in (the Person closed Google's page, Google refused, the code was no good), and
 * that is a failure the app shows. So is a code that could not be stored: the failure is logged
 * here, where its cause is known, and the app is told to start again while the port to tell it
 * on is still in hand.
 *
 * `arrival` is which of the two successes it was, as `landed` read it.
 */
const outcome = (ctx: GenericEndpointContext, round: typeof Round.Type, arrival: SignInArrival) => {
  const attempt = round.serverContext[ATTEMPT]
  const failed = SignInReturn.cases.Failed.make({ state: attempt.state })
  const session = ctx.context.newSession
  if (session === null) return Promise.resolve<SignInReturn>(failed)
  return grant(ctx, attempt, PersonId.make(session.user.id), arrival).catch(
    (cause): SignInReturn => {
      ctx.context.logger.error('A desktop sign-in code could not be stored', cause)
      return failed
    },
  )
}

/**
 * Runs after Better Auth's callback from a sign-in provider, and acts only when the sign-in was
 * started as a desktop attempt: it sends the browser to the app instead of to a page, with a
 * code when the callback has just signed a Person in and with the news that there is none when
 * it has not.
 *
 * This is the only place a code is issued, and it is issued for `ctx.context.newSession`: the
 * session this very callback made, never whatever session the browser happened to hold. That is
 * the reference's rule (`handleTransfer` is reached only past `ctx.context.newSession`), and it
 * is what stops a program that knows an attempt's addresses from asking a signed-in browser for
 * a code without the Person going through Google.
 *
 * Which arrival it was is read from where Better Auth was about to send the browser: it picks
 * the new-account landing when it has just made the account (`callbackOAuth` in
 * `dist/api/routes/callback.mjs`), and nothing else it leaves behind says so.
 *
 * Throwing the redirect is how an after-hook replaces the response: `runAfterHooks` in
 * `dist/api/dispatch.mjs` takes a thrown `APIError` as the new `returned` and sets its
 * `location` over the callback's own. The cookies the callback set stay, so the browser is also
 * signed in to the web app, as it is after any Google sign-in there.
 */
const landed = createAuthMiddleware((ctx) => {
  const headers = ctx.context.responseHeaders
  const sentTo = headers === undefined ? null : headers.get('location')
  return getOAuthState().then((state) =>
    Option.match(decodeRound(state), {
      onNone: () => Promise.resolve(),
      onSome: (round) =>
        outcome(ctx, round, sentTo === round.newUserURL ? 'first' : 'returning').then((back) =>
          Promise.reject(
            ctx.redirect(signInReturnAddress(round.serverContext[ATTEMPT].port, back)),
          ),
        ),
    }),
  )
})

/**
 * Admits a trade only from the app's own window: a request whose `Origin` is the server's public
 * origin, the value Better Auth is given as `trustedOrigins`. A browser names the origin of the
 * page on every POST and a page cannot forge it.
 *
 * Better Auth's own origin check guards requests that carry a cookie, and a trade carries none.
 * Without this, a page on another site that held a code and a secret for its own account could
 * sign a visitor's browser in as that account.
 */
const fromWindow = (origin: string) =>
  createAuthMiddleware((ctx) =>
    ctx.request !== undefined && ctx.request.headers.get('origin') === origin
      ? Promise.resolve()
      : Promise.reject(ctx.error('FORBIDDEN', { message: 'Origin not allowed' })),
  )

/** The one answer to a trade that will not be honoured. It does not say which check failed. */
const refused = (ctx: GenericEndpointContext) =>
  Promise.reject(ctx.error('UNAUTHORIZED', { message: 'This sign-in cannot be finished' }))

/**
 * Makes the Person a session of the window's own and sets its cookie. It is a new session, never
 * the browser's: signing out in one must not end the other.
 *
 * Both lookups can come back empty and each is a refusal, as in `electronToken`: the Person was
 * removed in the five minutes the code was good for, or a hook on creating sessions said no
 * (`createWithHooks` answers `null` then).
 */
const signIn = (ctx: GenericEndpointContext, granted: Granted) =>
  ctx.context.internalAdapter.findUserById(granted.person).then((user) => {
    if (user === null) return refused(ctx)
    return ctx.context.internalAdapter.createSession(user.id).then((session) => {
      if (session === null) return refused(ctx)
      return setSessionCookie(ctx, { session, user }).then(() =>
        ctx.json(encodeSignedIn({ arrival: granted.arrival })),
      )
    })
  })

/**
 * `POST /api/auth/desktop/session`: the window trades a code and the app's secret for a session.
 *
 * The code is taken out of the store first, so it works once whatever comes next. The attempt
 * must be the one the code was issued under, and the secret must hash to the digest the attempt
 * was started with (`generateCodeChallenge`, the same S256 the integration checks with). The
 * answer is the session cookie, plus whether this was a first arrival.
 */
const traded = (origin: string) =>
  createAuthEndpoint(
    '/desktop/session',
    { method: 'POST', body: Schema.toStandardSchemaV1(SignInTrade), use: [fromWindow(origin)] },
    (ctx) =>
      ctx.context.internalAdapter
        .consumeVerificationValue(`${GRANTED}${ctx.body.code}`)
        .then((row) =>
          Option.getOrUndefined(
            Option.flatMap(Option.fromNullishOr(row), (found) => decodeGranted(found.value)),
          ),
        )
        .then((granted) => {
          if (granted === undefined || granted.state !== ctx.body.state) return refused(ctx)
          return generateCodeChallenge(Redacted.value(ctx.body.verifier)).then((challenge) =>
            challenge === granted.challenge ? signIn(ctx, granted) : refused(ctx),
          )
        }),
  )

/** The desktop app's Google sign-in, for a server whose public origin is `origin`. */
export const desktopSignIn = (options: { readonly origin: string }) =>
  ({
    id: 'vivid-desktop-sign-in',
    hooks: {
      after: [
        {
          // Better Auth's callback from a sign-in provider, as the integration matches it.
          matcher: (ctx) => ctx.path !== undefined && ctx.path.startsWith('/callback'),
          handler: landed,
        },
      ],
    },
    endpoints: {
      desktopSignInStarted: started(options.origin),
      desktopSignInTraded: traded(options.origin),
    },
  }) satisfies BetterAuthPlugin
