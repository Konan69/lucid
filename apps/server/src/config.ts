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
 * The Google client a Person signs in through. Signing in with Google is part of every running
 * Vivid, so all three settings are required while the server is composed; there is no "Google
 * sign-in is off". Google refusing, or a Person closing its screen, is a failure of that one
 * sign-in and is answered there.
 */
export interface GoogleOAuthConfiguration {
  readonly clientId: string
  readonly clientSecret: Redacted.Redacted
  readonly redirectUri: URL
}

/**
 * Telemetry export is either fully configured or off. The endpoint and its credential are one
 * atomic pair, so an address with no credential (or the reverse) is a startup error.
 *
 * `url` is the OTLP/HTTP base address; the exporter appends `/v1/traces` and `/v1/logs`. `headers`
 * is every header sent with an export, and it carries the backend's key, so the whole map is
 * `Redacted` and never logged.
 */
export type ObservabilityConfiguration = Data.TaggedEnum<{
  Disabled: {}
  Enabled: {
    readonly url: URL
    readonly headers: Redacted.Redacted<Readonly<Record<string, string>>>
    /** The deployment's environment name and commit, each present only when the host names it. */
    readonly environment: Option.Option<string>
    readonly commit: Option.Option<string>
  }
}>

/** Constructors and the exhaustive `$match`; a `Redacted` map and a `URL` rule out a Schema. */
export const ObservabilityConfiguration = Data.taggedEnum<ObservabilityConfiguration>()

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
    message: `${variable} is missing or invalid: expected ${expected}`,
  })

/**
 * The text of a setting: not empty and with no surrounding spaces. A blank line in an env file, or
 * a value pasted with a space or a newline, is not a setting: a padded key authenticates nowhere
 * and a blank model name would be written into stored state before anyone noticed.
 */
export const settingText = Schema.String.check(
  Schema.makeFilter(
    (value) => (value.length > 0 && value.trim() === value) || 'text with no surrounding spaces',
  ),
)

/** A credential read as a setting: the same rule, and never rendered. */
export const settingSecret = Schema.RedactedFromValue(settingText)

/**
 * A setting the server cannot run without. It is read once, while the server is composed, and its
 * absence or a malformed value stops launch with the variable named. The supplied value is never
 * carried: it may be a credential pasted into the wrong variable.
 *
 * Adapters that own a required setting (the Computer provider, memory) read it through this, so
 * "not configured" is a server that did not start and never a state a running server is in.
 */
export const requiredSetting = <A>(
  name: string,
  schema: Schema.ConstraintCodec<A, unknown>,
  expected = 'a valid value',
) => Config.schema(schema, name).pipe(Effect.mapError(() => configError(name, expected)))

/** A setting whose absence is a real choice; a malformed value still stops launch. */
export const optionalSetting = <A>(
  name: string,
  schema: Schema.ConstraintCodec<A, unknown>,
  expected = 'a valid value',
) =>
  Config.option(Config.schema(schema, name)).pipe(
    Effect.mapError(() => configError(name, expected)),
  )

const loadDatabaseUrl = Effect.fn('ServerConfig.loadDatabaseUrl')(function* () {
  const value = yield* requiredSetting('DATABASE_URL', databaseUrl).pipe(
    Effect.mapError(() => configError('DATABASE_URL', 'a PostgreSQL connection URL')),
  )
  const parsed = yield* Effect.try({
    try: () => new URL(Redacted.value(value)),
    catch: () => configError('DATABASE_URL', 'a PostgreSQL connection URL'),
  })
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    return yield* configError('DATABASE_URL', 'a PostgreSQL connection URL')
  }
  if (parsed.hostname.length === 0) {
    return yield* configError('DATABASE_URL', 'a PostgreSQL connection URL with a host')
  }
  return value
})

/** Each of the three is read on its own, so a missing one stops launch under its own name. */
const loadGoogleOAuth = Effect.fn('ServerConfig.loadGoogleOAuth')(function* () {
  const configuration: GoogleOAuthConfiguration = {
    clientId: yield* requiredSetting('GOOGLE_CLIENT_ID', settingText, 'the Google client id'),
    clientSecret: yield* requiredSetting(
      'GOOGLE_CLIENT_SECRET',
      settingSecret,
      'the Google client secret',
    ),
    // Google sends the Person back here; it must be the address registered with the client.
    redirectUri: yield* requiredSetting(
      'GOOGLE_REDIRECT_URI',
      Schema.URLFromString,
      'the absolute URL Google returns a sign-in to',
    ),
  }
  return configuration
})

/**
 * `name=value` pairs separated by commas, the shape OpenTelemetry uses for
 * `OTEL_EXPORTER_OTLP_HEADERS`. Only the first `=` splits a pair, because a value may contain one
 * (`x-sentry-auth=sentry sentry_key=…`). A pair with no name or no value is refused rather than
 * dropped: a silently missing credential would look like an exporter that works and sends nothing.
 */
const parseHeaders = (text: string): Option.Option<Readonly<Record<string, string>>> => {
  const pairs = text.split(',').map((pair) => {
    const at = pair.indexOf('=')
    return at === -1
      ? (['', ''] as const)
      : ([pair.slice(0, at).trim(), pair.slice(at + 1).trim()] as const)
  })
  return pairs.every(([name, value]) => name.length > 0 && value.length > 0)
    ? Option.some(Object.fromEntries(pairs))
    : Option.none()
}

const loadObservability = Effect.fn('ServerConfig.loadObservability')(function* () {
  const url = yield* optionalSetting('VIVID_OTLP_URL', Schema.URLFromString, 'an absolute URL')
  const headers = yield* optionalSetting('VIVID_OTLP_HEADERS', secret, 'name=value pairs')
  if (Option.isNone(url) && Option.isNone(headers)) return ObservabilityConfiguration.Disabled()
  if (Option.isNone(url)) {
    return yield* configError('VIVID_OTLP_URL', 'an absolute URL when VIVID_OTLP_HEADERS is set')
  }
  if (Option.isNone(headers)) {
    return yield* configError('VIVID_OTLP_HEADERS', 'present when VIVID_OTLP_URL is set')
  }
  const parsed = parseHeaders(Redacted.value(headers.value))
  if (Option.isNone(parsed)) {
    return yield* configError('VIVID_OTLP_HEADERS', 'name=value pairs separated by commas')
  }
  // `infra/railway.ts` fills both from Railway's own variables. Railway names a commit only for a
  // deployment built from one, and a reference to a variable it did not set arrives as an empty
  // string, so empty means the host did not say, exactly as an unset name does.
  const named = (value: Option.Option<string>) => Option.filter(value, (text) => text.length > 0)
  return ObservabilityConfiguration.Enabled({
    url: url.value,
    headers: Redacted.make(parsed.value),
    environment: named(yield* optionalSetting('VIVID_ENVIRONMENT', Schema.String)),
    commit: named(yield* optionalSetting('VIVID_COMMIT', Schema.String)),
  })
})

const loadConfig = Effect.fn('loadServerConfig')(function* (): Effect.fn.Return<
  ServerConfigService & {
    readonly HOST: string
    readonly VIVID_WEB_DIST: Option.Option<string>
    readonly VIVID_MOBILE_UPDATES: Option.Option<string>
    readonly OBSERVABILITY: ObservabilityConfiguration
  },
  ConfigurationError
> {
  const loadedAuthSecret = yield* requiredSetting('AUTH_SECRET', authSecret).pipe(
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
    yield* optionalSetting('PUBLIC_URL', Schema.URLFromString, 'an absolute URL'),
    () => new URL('http://localhost:3000'),
  )
  return {
    DATABASE_URL: yield* loadDatabaseUrl(),
    AUTH_SECRET: loadedAuthSecret,
    RUNTIME_URL: yield* requiredSetting('VIVID_RUNTIME_URL', Schema.URLFromString),
    RUNTIME_TOKEN: yield* requiredSetting('VIVID_RUNTIME_TOKEN', secret),
    PORT: port,
    // Listener and static-root inputs belong to launch; domain test Layers need no HTTP host.
    HOST: Option.getOrElse(yield* optionalSetting('HOST', nonEmptyString), () => '127.0.0.1'),
    VIVID_WEB_DIST: yield* optionalSetting('VIVID_WEB_DIST', nonEmptyString),
    // Where `apps/mobile/scripts/publish.mjs` left the mobile app's over-the-air updates.
    VIVID_MOBILE_UPDATES: yield* optionalSetting('VIVID_MOBILE_UPDATES', nonEmptyString),
    // Telemetry export is installed at launch only; domain test Layers never export.
    OBSERVABILITY: yield* loadObservability(),
    PUBLIC_URL: publicUrl,
    GOOGLE_OAUTH: yield* loadGoogleOAuth(),
  }
})

export const serverConfigLayer = Layer.effect(ServerConfig, loadConfig())

/** The validated configuration effect, useful for boot diagnostics and tests. */
export const loadServerConfig = loadConfig()
