import { BetterAuth } from "@alchemy.run/better-auth"
import { Postgres } from "@alchemy.run/better-auth/Postgres"
import { bearer, deviceAuthorization, organization } from "better-auth/plugins"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { DatabaseFailure } from "@vivid/contracts"
import { ServerConfig, serverConfigLayer } from "./config.ts"

/**
 * Better Auth's internal identity model is mapped once at this boundary:
 * its organization/member/invitation model names use Vivid's company,
 * membership, and invitation tables. Public contracts and routes use only
 * the Vivid glossary.
 */
const makeOptions = (config: ServerConfig["Service"]) => ({
  id: "VividAuth",
  migrate: false,
  basePath: "/api/auth",
  baseURL: config.PUBLIC_URL.href,
  secret: config.AUTH_SECRET,
  trustedOrigins: [config.PUBLIC_URL.href],
  emailAndPassword: {
    enabled: true,
    autoSignIn: true
  },
  ...(config.GOOGLE_CLIENT_ID === undefined || config.GOOGLE_CLIENT_SECRET === undefined
    ? {}
    : {
        socialProviders: {
          google: {
            clientId: config.GOOGLE_CLIENT_ID,
            clientSecret: Redacted.value(config.GOOGLE_CLIENT_SECRET),
            redirectURI: config.GOOGLE_REDIRECT_URI?.href
          }
        }
      }),
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ["google"]
    }
  },
  plugins: [
    bearer(),
    deviceAuthorization({ verificationUri: "/device" }),
    organization({
      creatorRole: "owner",
      schema: {
        organization: { modelName: "company" },
        member: {
          modelName: "membership",
          fields: { organizationId: "companyId", userId: "userId" }
        },
        invitation: {
          modelName: "invitation",
          fields: { organizationId: "companyId" }
        },
        session: { fields: { activeOrganizationId: "activeCompanyId" } }
      }
    })
  ]
})

export const authEffect = Effect.gen(function*() {
  const config = yield* ServerConfig
  return yield* BetterAuth(makeOptions(config)).pipe(
    Effect.provide(Postgres(config.DATABASE_URL, { migrate: false }))
  )
}).pipe(
  Effect.provide(serverConfigLayer),
  Effect.mapError(() => new DatabaseFailure({ message: "Server configuration is invalid" }))
)

export type AuthInstance = Effect.Success<typeof authEffect>
