import { expect, it } from '@effect/vitest'
import { ConfigProvider, Effect, Option, Redacted } from 'effect'
import { ConfigurationError, loadServerConfig, ObservabilityConfiguration } from './config.ts'

const base = {
  DATABASE_URL: 'postgres://test@127.0.0.1:1/test',
  AUTH_SECRET: 'test-Auth_secret-0123456789-ABCDEFG',
  VIVID_RUNTIME_URL: 'http://127.0.0.1:1',
  VIVID_RUNTIME_TOKEN: 'test-token',
  GOOGLE_CLIENT_ID: 'test-google-client',
  GOOGLE_CLIENT_SECRET: 'test-google-secret',
  GOOGLE_REDIRECT_URI: 'http://127.0.0.1:8787/api/auth/callback/google',
}

const load = (environment: Record<string, string>) =>
  loadServerConfig.pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ ...base, ...environment }))),
  )

/**
 * Signing in with Google is part of every running Vivid: with any one of its three settings
 * missing or malformed the configuration does not load, so the server does not start, and the
 * failure names that variable without carrying the secret.
 */
for (const [name, environment, variable] of [
  ['the client id is missing', { ...base, GOOGLE_CLIENT_ID: undefined }, 'GOOGLE_CLIENT_ID'],
  ['the client id is empty', { ...base, GOOGLE_CLIENT_ID: '' }, 'GOOGLE_CLIENT_ID'],
  [
    'the client secret is missing',
    { ...base, GOOGLE_CLIENT_SECRET: undefined },
    'GOOGLE_CLIENT_SECRET',
  ],
  [
    'the return address is missing',
    { ...base, GOOGLE_REDIRECT_URI: undefined },
    'GOOGLE_REDIRECT_URI',
  ],
  [
    'the return address is not a URL',
    { ...base, GOOGLE_REDIRECT_URI: '/api/auth/callback/google' },
    'GOOGLE_REDIRECT_URI',
  ],
] as const) {
  it.effect(`does not load when ${name}`, () =>
    Effect.gen(function* () {
      const failure = yield* loadServerConfig.pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(environment))),
        Effect.flip,
      )
      expect(failure).toBeInstanceOf(ConfigurationError)
      expect(failure.variable).toBe(variable)
      expect(JSON.stringify(failure)).not.toContain(base.GOOGLE_CLIENT_SECRET)
    }),
  )
}

it.effect('reads the Google client and keeps its secret redacted', () =>
  Effect.gen(function* () {
    const google = (yield* load({})).GOOGLE_OAUTH
    expect(google.clientId).toBe(base.GOOGLE_CLIENT_ID)
    expect(google.redirectUri.href).toBe(base.GOOGLE_REDIRECT_URI)
    expect(JSON.stringify(google)).not.toContain(base.GOOGLE_CLIENT_SECRET)
  }),
)

/** Telemetry export is off unless both names are set; half a setting stops the launch. */
it.effect('reads telemetry export as one atomic pair and keeps its credential redacted', () =>
  Effect.gen(function* () {
    expect((yield* load({})).OBSERVABILITY).toEqual(ObservabilityConfiguration.Disabled())

    const enabled = (yield* load({
      VIVID_OTLP_URL: 'https://ingest.example.test/api/1/integration/otlp',
      VIVID_OTLP_HEADERS: 'x-sentry-auth=sentry sentry_key=abc123, x-extra=1',
      VIVID_ENVIRONMENT: 'production',
      // What a Railway reference to a variable it did not set resolves to.
      VIVID_COMMIT: '',
    })).OBSERVABILITY
    // Only the first `=` splits a pair: the credential's own `=` belongs to the value.
    expect(
      ObservabilityConfiguration.$match(enabled, {
        Disabled: () => ({}),
        Enabled: ({ url, headers, environment, commit }) => ({
          url: url.href,
          headers: Redacted.value(headers),
          environment,
          commit,
        }),
      }),
    ).toEqual({
      url: 'https://ingest.example.test/api/1/integration/otlp',
      headers: { 'x-sentry-auth': 'sentry sentry_key=abc123', 'x-extra': '1' },
      environment: Option.some('production'),
      commit: Option.none(),
    })
    expect(JSON.stringify(enabled)).not.toContain('abc123')

    for (const [environment, variable] of [
      [{ VIVID_OTLP_URL: 'https://ingest.example.test/otlp' }, 'VIVID_OTLP_HEADERS'],
      [{ VIVID_OTLP_HEADERS: 'x-sentry-auth=key' }, 'VIVID_OTLP_URL'],
      [
        { VIVID_OTLP_URL: 'https://ingest.example.test/otlp', VIVID_OTLP_HEADERS: 'no-value' },
        'VIVID_OTLP_HEADERS',
      ],
    ] as const) {
      const failure = yield* Effect.flip(load(environment))
      expect(failure.variable).toBe(variable)
      // The refusal names the variable and what was expected, never what was supplied.
      expect(failure.message).not.toContain('no-value')
    }
  }),
)
