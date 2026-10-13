import { BetterAuth } from '@alchemy.run/better-auth'
import { bearer, organization } from 'better-auth/plugins'
import { RuntimeContext } from 'alchemy'
import * as Effect from 'effect/Effect'
import * as Redacted from 'effect/Redacted'
import { DatabaseFailure } from '@vivid/contracts'
import { ServerConfig } from '../config.ts'
import { appSignIn } from './signin.ts'
import { authDatabaseLayer } from './dialect.ts'

/** Two weeks. See `session` in the options below for why it is not Better Auth's seven days. */
const SESSION_LASTS_SECONDS = 14 * 24 * 60 * 60

/**
 * Better Auth's internal identity model is mapped once at this boundary:
 * its organization/member/invitation model names use Vivid's company,
 * membership, and invitation tables. Public contracts and routes use only
 * the Vivid glossary.
 */
const makeOptions = (config: ServerConfig['Service']) => {
  const options = {
    id: 'VividAuth',
    migrate: false,
    basePath: '/api/auth',
    baseURL: config.PUBLIC_URL.href,
    secret: config.AUTH_SECRET,
    trustedOrigins: [config.PUBLIC_URL.origin],
    /**
     * Whose request it is, for Better Auth's request limiter (three sign-ins every ten seconds
     * for each client address; on by itself in production, `create-context.mjs`).
     *
     * Better Auth reads `x-forwarded-for` and, with no trusted proxies named, takes it only
     * when it holds one address (`@better-auth/core` `utils/ip.mjs`, `getIPFromHeader`). The
     * host's edge sends two there, the client and its own hop, so no address was found and
     * every Person was counted in one bucket ("falling back to a single shared per-path
     * bucket", production log, 11 October 2026): three sign-ins in ten seconds from anyone
     * refused the next Person with 429.
     *
     * `x-real-ip` is the client's address alone. Measured on the host's edge that day with an
     * echo service: it carried the caller's public address, and a caller that sent its own
     * `X-Real-IP` and `X-Forwarded-For` had both replaced.
     */
    advanced: { ipAddress: { ipAddressHeaders: ['x-real-ip'] } },
    /**
     * How long a sign-in lasts with nobody using it: two weeks, renewed each day it is used
     * (the developer's choice, 13 October 2026: a year was too long).
     *
     * Better Auth's own default is seven days (`sessionConfig.expiresIn` in
     * `dist/context/create-context.mjs`, 1.7.5), which signed a Person out of an app or a browser
     * they had not opened for a week: a phone app left alone, a desktop app, a second browser.
     * A Person who uses a device at least once a fortnight stays signed in on it.
     * Every session takes its lifetime from here: the browser's cookie, and the session an app
     * trades its code for (`signin.ts`), whose token the phone keeps as its bearer token.
     * A session made under the old lifetime is past due for renewal under this one, so it is
     * given the two weeks the next time it is used (`shouldBeUpdated` in `dist/api/routes/session.mjs`).
     */
    session: { expiresIn: SESSION_LASTS_SECONDS },
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
    },
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ['google'],
      },
    },
    plugins: [
      // The phone keeps its session's token and sends it as a bearer token; it holds no cookie.
      bearer(),
      // Google sign-in for the desktop app and the phone app: a browser signs the Person in and
      // hands the app a one-use code, which the app trades for a session of its own
      // (`signin.ts`). There is no other way to sign an app in from somewhere else: no code a
      // Person reads or types, and no page where one is approved.
      appSignIn({ origin: config.PUBLIC_URL.origin }),
      organization({
        creatorRole: 'owner',
        schema: {
          organization: { modelName: 'company' },
          member: {
            modelName: 'membership',
            fields: { organizationId: 'companyId', userId: 'userId' },
          },
          invitation: {
            modelName: 'invitation',
            fields: { organizationId: 'companyId' },
          },
          session: { fields: { activeOrganizationId: 'activeCompanyId' } },
        },
      }),
    ],
  }
  const google = config.GOOGLE_OAUTH
  return {
    ...options,
    socialProviders: {
      google: {
        clientId: google.clientId,
        clientSecret: Redacted.value(google.clientSecret),
        redirectURI: google.redirectUri.href,
        // Signing in asks Google for who the Person is and nothing else. This client is also the
        // one Integrations use for Gmail, Calendar and Drive, and Better Auth's default
        // (`include_granted_scopes=true`) would carry those grants into a sign-in token.
        includeGrantedScopes: false,
        // A Person with several Google accounts chooses one each time; without this Google
        // silently reuses whichever account the browser last used.
        prompt: 'select_account' as const,
      },
    },
  }
}

/** Closes Better Auth's type-only Alchemy context requirement for this static Node runtime. */
export const localAuthRuntimeLayer = RuntimeContext.phantom

/**
 * The Better Auth instance over Vivid's PostgreSQL.
 *
 * Every way a session ends by being removed (signing out, signing another device out, signing
 * out everywhere else) is a delete on the session table. The database Layer announces the Person in
 * that delete's own commit (`auth/dialect.ts`), which is what makes every open subscription of
 * theirs ask again whether its session is still one. Nothing here publishes, so this needs no
 * change bus.
 *
 * The only failure is that Layer refusing to build because it could not form the removal's
 * receipt; auth is then unavailable rather than removing sessions unannounced.
 */
export const authEffect = Effect.gen(function* () {
  const config = yield* ServerConfig
  return yield* BetterAuth(makeOptions(config)).pipe(
    // @effect-diagnostics-next-line strictEffectProvide:off -- This Layer only builds the deferred `Database` description Better Auth captures; the pool it describes is opened later on the caller's own scope (Alchemy `ExecutionMemo`), so providing it here ends no lifetime early.
    Effect.provide(authDatabaseLayer(config.DATABASE_URL)),
  )
}).pipe(
  Effect.mapError(() => new DatabaseFailure({ message: 'Session removal cannot be announced' })),
)

export type AuthInstance = Effect.Success<typeof authEffect>
