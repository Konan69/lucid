import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"

const authSecretValue = Schema.String.check(Schema.makeFilter(
  (value) => {
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/]
    const hasEntropy = new Set(value).size >= 12 && classes.filter((pattern) => pattern.test(value)).length >= 3
    return value.length >= 32 && hasEntropy
      ? true
      : "at least 32 characters, 12 distinct characters, and 3 character classes"
  }
))
const nonEmptyString = Schema.String.check(Schema.isNonEmpty({ message: "a non-empty string" }))
const secret = Schema.RedactedFromValue(Schema.String)
const authSecret = Schema.RedactedFromValue(authSecretValue)
const databaseUrl = Schema.RedactedFromValue(nonEmptyString)

export class ConfigurationError extends Schema.TaggedError<ConfigurationError>()("ConfigurationError", {
  variable: Schema.String,
  expected: Schema.String,
  message: Schema.String
}) {}

export interface ServerConfigService {
  readonly DATABASE_URL: Redacted.Redacted<string>
  readonly AUTH_SECRET: Redacted.Redacted<string>
  readonly PORT: number
  readonly PUBLIC_URL: URL
  readonly GOOGLE_CLIENT_ID?: string
  readonly GOOGLE_CLIENT_SECRET?: Redacted.Redacted<string>
  readonly GOOGLE_REDIRECT_URI?: URL
}

type LoadedServerConfig = { -readonly [Key in keyof ServerConfigService]: ServerConfigService[Key] }

export class ServerConfig extends Context.Service<ServerConfig, ServerConfigService>()("vivid/ServerConfig") {}

const configError = (variable: string, expected: string) =>
  new ConfigurationError({
    variable,
    expected,
    message: `${variable} is invalid: expected ${expected}`
  })

const required = <A>(name: string, schema: Schema.ConstraintCodec<A, unknown, never, never>) =>
  Config.schema(schema, name).pipe(
    Effect.mapError(() => configError(name, "a valid value"))
  )

const optional = <A>(name: string, schema: Schema.ConstraintCodec<A, unknown, never, never>, expected = "a valid value") =>
  Config.option(Config.schema(schema, name)).pipe(
    Effect.mapError(() => configError(name, expected))
  )

const loadConfig = Effect.fn("loadServerConfig")(function*(): Effect.fn.Return<ServerConfigService, ConfigurationError> {
  const databaseUrlValue = yield* required("DATABASE_URL", databaseUrl).pipe(
    Effect.mapError(() => configError("DATABASE_URL", "a PostgreSQL connection URL"))
  )
  const parsedDatabaseUrl = yield* Effect.try({
    try: () => new URL(Redacted.value(databaseUrlValue)),
    catch: () => configError("DATABASE_URL", "a PostgreSQL connection URL")
  })
  if (parsedDatabaseUrl.protocol !== "postgres:" && parsedDatabaseUrl.protocol !== "postgresql:") {
    return yield* Effect.fail(configError("DATABASE_URL", "a PostgreSQL connection URL"))
  }
  if (parsedDatabaseUrl.hostname.length === 0) {
    return yield* Effect.fail(configError("DATABASE_URL", "a PostgreSQL connection URL with a host"))
  }

  const authSecretValue = yield* required("AUTH_SECRET", authSecret).pipe(
    Effect.mapError(() => configError("AUTH_SECRET", "at least 32 characters, 12 distinct characters, and 3 character classes"))
  )
  const port = Option.getOrUndefined(yield* optional("PORT", Config.Port)) ?? 8787
  const publicUrl = Option.getOrUndefined(yield* optional("PUBLIC_URL", Schema.URLFromString, "an absolute URL"))
    ?? new URL("http://localhost:3000")
  const googleClientId = Option.getOrUndefined(yield* optional("GOOGLE_CLIENT_ID", nonEmptyString, "a non-empty string"))
  const googleClientSecret = Option.getOrUndefined(yield* optional("GOOGLE_CLIENT_SECRET", secret, "a non-empty secret"))
  const googleRedirectUri = Option.getOrUndefined(yield* optional("GOOGLE_REDIRECT_URI", Schema.URLFromString, "an absolute URL"))

  if (googleClientId !== undefined && googleClientSecret === undefined) {
    return yield* Effect.fail(configError("GOOGLE_CLIENT_SECRET", "present when GOOGLE_CLIENT_ID is set"))
  }
  if (googleClientId === undefined && googleClientSecret !== undefined) {
    return yield* Effect.fail(configError("GOOGLE_CLIENT_ID", "present when GOOGLE_CLIENT_SECRET is set"))
  }
  if (googleClientId !== undefined && googleRedirectUri === undefined) {
    return yield* Effect.fail(configError("GOOGLE_REDIRECT_URI", "an absolute URL when Google OAuth is enabled"))
  }

  const config: LoadedServerConfig = {
    DATABASE_URL: databaseUrlValue,
    AUTH_SECRET: authSecretValue,
    PORT: port,
    PUBLIC_URL: publicUrl
  }
  if (googleClientId !== undefined) config.GOOGLE_CLIENT_ID = googleClientId
  if (googleClientSecret !== undefined) config.GOOGLE_CLIENT_SECRET = googleClientSecret
  if (googleRedirectUri !== undefined) config.GOOGLE_REDIRECT_URI = googleRedirectUri
  return config
})

export const serverConfigLayer = Layer.effect(ServerConfig, loadConfig())

/** The validated configuration effect, useful for boot diagnostics and tests. */
export const loadServerConfig = loadConfig()
