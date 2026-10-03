import { BetterAuth } from '@alchemy.run/better-auth'
import { Postgres } from '@alchemy.run/better-auth/Postgres'
import { bearer, deviceAuthorization, organization } from 'better-auth/plugins'
import { RuntimeContext } from 'alchemy'
import * as Effect from 'effect/Effect'
import * as Redacted from 'effect/Redacted'
import { DatabaseFailure, PersonId } from '@vivid/contracts'
import { GoogleOAuthConfiguration, ServerConfig } from '../config.ts'
import { Changes, Topic } from '../live/changes.ts'

/**
 * Better Auth's internal identity model is mapped once at this boundary:
 * its organization/member/invitation model names use Vivid's company,
 * membership, and invitation tables. Public contracts and routes use only
 * the Vivid glossary.
 */
const makeOptions = (
  config: ServerConfig['Service'],
  sessionEnded: (personId: string) => Promise<void>,
) => {
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
    /**
     * Every way a session ends by being removed (signing out, revoking a paired device, revoking
     * the other sessions) deletes its row through this hook, in Better Auth 1.7.5's
     * `db/with-hooks` `deleteWithHooks` and `deleteManyWithHooks`. The hook runs after the delete
     * has committed and says the Person's data moved, which is what makes every open subscription
     * of theirs ask again whether its session is still one.
     */
    databaseHooks: {
      session: {
        delete: { after: (session: { readonly userId: string }) => sessionEnded(session.userId) },
      },
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

/**
 * Says a Person's data moved when one of their sessions is removed. Better Auth calls its database
 * hooks as Promises and offers no other way in, so the publish is run as one here and nowhere else.
 */
const sessionRemoved = (changes: Changes['Service']) => (personId: string) =>
  // oxlint-disable-next-line vivid/no-runpromise-in-library -- Better Auth's Promise-only database hook ingress.
  Effect.runPromise(changes.publish([Topic.person(PersonId.make(personId))]))

export const authEffect = Effect.gen(function* () {
  const config = yield* ServerConfig
  const changes = yield* Changes
  return yield* BetterAuth(makeOptions(config, sessionRemoved(changes))).pipe(
    Effect.provide(Postgres(Redacted.value(config.DATABASE_URL), { migrate: false })),
  )
}).pipe(Effect.mapError(() => new DatabaseFailure({ message: 'Server configuration is invalid' })))

export type AuthInstance = Effect.Success<typeof authEffect>
