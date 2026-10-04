import { BetterAuth } from '@alchemy.run/better-auth'
import { bearer, deviceAuthorization, organization } from 'better-auth/plugins'
import { RuntimeContext } from 'alchemy'
import * as Effect from 'effect/Effect'
import * as Redacted from 'effect/Redacted'
import { DatabaseFailure } from '@vivid/contracts'
import { GoogleOAuthConfiguration, ServerConfig } from '../config.ts'
import { authDatabaseLayer } from './dialect.ts'

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
    trustedOrigins: [config.PUBLIC_URL.href],
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
      bearer(),
      deviceAuthorization({ verificationUri: '/device' }),
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
  return GoogleOAuthConfiguration.$match(config.GOOGLE_OAUTH, {
    Disabled: () => options,
    Enabled: (google) => ({
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
    }),
  })
}

/** Closes Better Auth's type-only Alchemy context requirement for this static Node runtime. */
export const localAuthRuntimeLayer = RuntimeContext.phantom

/**
 * The Better Auth instance over Vivid's PostgreSQL.
 *
 * Every way a session ends by being removed (signing out, revoking a paired device, revoking the
 * other sessions) is a delete on the session table. The database Layer announces the Person in
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
    Effect.provide(authDatabaseLayer(config.DATABASE_URL)),
  )
}).pipe(
  Effect.mapError(() => new DatabaseFailure({ message: 'Session removal cannot be announced' })),
)

export type AuthInstance = Effect.Success<typeof authEffect>
