import * as Config from 'effect/Config'
import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'

const authSecretValue = Schema.String.check(
  Schema.makeFilter((value) => {
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/]
    const hasEntropy =
      new Set(value).size >= 12 && classes.filter((pattern) => pattern.test(value)).length >= 3
    return value.length >= 32 && hasEntropy
      ? true
      : 'at least 32 characters, 12 distinct characters, and 3 character classes'
  }),
)
const nonEmptyString = Schema.String.check(Schema.isNonEmpty({ message: 'a non-empty string' }))
const secret = Schema.RedactedFromValue(Schema.String)
const authSecret = Schema.RedactedFromValue(authSecretValue)
const databaseUrl = Schema.RedactedFromValue(nonEmptyString)

export class ConfigurationError extends Schema.TaggedError<ConfigurationError>()(
  'ConfigurationError',
  {
    variable: Schema.String,
    expected: Schema.String,
    message: Schema.String,
  },
  { title: 'Server configuration error' },
) {}

/**
 * Google sign-in is either fully configured or off. The three variables are one atomic set, so
 * "partly configured" is a startup error, never a third state.
 */
export type GoogleOAuthConfiguration = Data.TaggedEnum<{
  Disabled: {}
  Enabled: {
    readonly clientId: string
    readonly clientSecret: Redacted.Redacted
    readonly redirectUri: URL
  }
}>

/** Constructors and the exhaustive `$match`; a `Redacted` secret and a `URL` rule out a Schema. */
export const GoogleOAuthConfiguration = Data.taggedEnum<GoogleOAuthConfiguration>()

export interface ServerConfigService {
  readonly DATABASE_URL: Redacted.Redacted
  readonly AUTH_SECRET: Redacted.Redacted
  readonly RUNTIME_URL: URL
  readonly RUNTIME_TOKEN: Redacted.Redacted
  readonly PORT: number
  readonly PUBLIC_URL: URL
  readonly GOOGLE_OAUTH: GoogleOAuthConfiguration
}

export class ServerConfig extends Context.Service<ServerConfig, ServerConfigService>()(
  'vivid/ServerConfig',
) {}

const configError = (variable: string, expected: string) =>
  new ConfigurationError({
    variable,
    expected,
    message: `${variable} is invalid: expected ${expected}`,
  })

const required = <A>(name: string, schema: Schema.ConstraintCodec<A, unknown>) =>
  Config.schema(schema, name).pipe(Effect.mapError(() => configError(name, 'a valid value')))

const optional = <A>(
  name: string,
  schema: Schema.ConstraintCodec<A, unknown>,
  expected = 'a valid value',
) =>
  Config.option(Config.schema(schema, name)).pipe(
    Effect.mapError(() => configError(name, expected)),
  )

const loadDatabaseUrl = Effect.fn('ServerConfig.loadDatabaseUrl')(function* () {
  const value = yield* required('DATABASE_URL', databaseUrl).pipe(
    Effect.mapError(() => configError('DATABASE_URL', 'a PostgreSQL connection URL')),
  )
  const parsed = yield* Effect.try({
    try: () => new URL(Redacted.value(value)),
    catch: () => configError('DATABASE_URL', 'a PostgreSQL connection URL'),
  })
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    return yield* Effect.fail(configError('DATABASE_URL', 'a PostgreSQL connection URL'))
  }
  if (parsed.hostname.length === 0) {
    return yield* Effect.fail(
      configError('DATABASE_URL', 'a PostgreSQL connection URL with a host'),
    )
  }
  return value
})

const loadGoogleOAuth = Effect.fn('ServerConfig.loadGoogleOAuth')(function* () {
  const clientId = yield* optional('GOOGLE_CLIENT_ID', nonEmptyString, 'a non-empty string')
  const clientSecret = yield* optional('GOOGLE_CLIENT_SECRET', secret, 'a non-empty secret')
  const redirectUri = yield* optional(
    'GOOGLE_REDIRECT_URI',
    Schema.URLFromString,
    'an absolute URL',
  )
  if (Option.isNone(clientId) && Option.isNone(clientSecret) && Option.isNone(redirectUri)) {
    return GoogleOAuthConfiguration.Disabled()
  }
  if (Option.isNone(clientId)) {
    return yield* Effect.fail(
      configError('GOOGLE_CLIENT_ID', 'present when Google OAuth is enabled'),
    )
  }
  if (Option.isNone(clientSecret)) {
    return yield* Effect.fail(
      configError('GOOGLE_CLIENT_SECRET', 'present when Google OAuth is enabled'),
    )
  }
  if (Option.isNone(redirectUri)) {
    return yield* Effect.fail(
      configError('GOOGLE_REDIRECT_URI', 'an absolute URL when Google OAuth is enabled'),
    )
  }
  return GoogleOAuthConfiguration.Enabled({
    clientId: clientId.value,
    clientSecret: clientSecret.value,
    redirectUri: redirectUri.value,
  })
})

const loadConfig = Effect.fn('loadServerConfig')(function* (): Effect.fn.Return<
  ServerConfigService & {
    readonly HOST: string
    readonly VIVID_WEB_DIST: Option.Option<string>
    readonly VIVID_MOBILE_UPDATES: Option.Option<string>
  },
  ConfigurationError
> {
  const loadedAuthSecret = yield* required('AUTH_SECRET', authSecret).pipe(
    Effect.mapError(() =>
      configError(
        'AUTH_SECRET',
        'at least 32 characters, 12 distinct characters, and 3 character classes',
      ),
    ),
  )
  const port = Option.getOrElse(
    yield* Config.option(Config.Port('PORT')).pipe(
      Effect.mapError(() => configError('PORT', 'a valid TCP port')),
    ),
    () => 8787,
  )
  const publicUrl = Option.getOrElse(
    yield* optional('PUBLIC_URL', Schema.URLFromString, 'an absolute URL'),
    () => new URL('http://localhost:3000'),
  )
  return {
    DATABASE_URL: yield* loadDatabaseUrl(),
    AUTH_SECRET: loadedAuthSecret,
    RUNTIME_URL: yield* required('VIVID_RUNTIME_URL', Schema.URLFromString),
    RUNTIME_TOKEN: yield* required('VIVID_RUNTIME_TOKEN', secret),
    PORT: port,
    // Listener and static-root inputs belong to launch; domain test Layers need no HTTP host.
    HOST: Option.getOrElse(yield* optional('HOST', nonEmptyString), () => '127.0.0.1'),
    VIVID_WEB_DIST: yield* optional('VIVID_WEB_DIST', nonEmptyString),
    // Where `apps/mobile/scripts/publish.mjs` left the mobile app's over-the-air updates.
    VIVID_MOBILE_UPDATES: yield* optional('VIVID_MOBILE_UPDATES', nonEmptyString),
    PUBLIC_URL: publicUrl,
    GOOGLE_OAUTH: yield* loadGoogleOAuth(),
  }
})

export const serverConfigLayer = Layer.effect(ServerConfig, loadConfig())

/** The validated configuration effect, useful for boot diagnostics and tests. */
export const loadServerConfig = loadConfig()
