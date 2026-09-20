import { BetterAuth } from '@alchemy.run/better-auth'
import { Postgres } from '@alchemy.run/better-auth/Postgres'
import { bearer, deviceAuthorization, organization } from 'better-auth/plugins'
import { RuntimeContext } from 'alchemy'
import * as Effect from 'effect/Effect'
import * as Redacted from 'effect/Redacted'
import { DatabaseFailure } from '@vivid/contracts'
import { GoogleOAuthConfiguration, ServerConfig } from '../config.ts'

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
        },
      },
    }),
  })
}

/** Closes Better Auth's type-only Alchemy context requirement for this static Node runtime. */
export const localAuthRuntimeLayer = RuntimeContext.phantom

export const authEffect = Effect.gen(function* () {
  const config = yield* ServerConfig
  return yield* BetterAuth(makeOptions(config)).pipe(
    Effect.provide(Postgres(Redacted.value(config.DATABASE_URL), { migrate: false })),
  )
}).pipe(
  Effect.mapError(() => new DatabaseFailure({ message: 'Server configuration is invalid' })),
)

export type AuthInstance = Effect.Success<typeof authEffect>
