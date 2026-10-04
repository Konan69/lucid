import { expect, it } from '@effect/vitest'
import { ConfigProvider, Effect, Option, Redacted } from 'effect'
import { loadServerConfig, ObservabilityConfiguration } from './config.ts'

const base = {
  DATABASE_URL: 'postgres://test@127.0.0.1:1/test',
  AUTH_SECRET: 'test-Auth_secret-0123456789-ABCDEFG',
  VIVID_RUNTIME_URL: 'http://127.0.0.1:1',
  VIVID_RUNTIME_TOKEN: 'test-token',
}

const load = (environment: Record<string, string>) =>
  loadServerConfig.pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ ...base, ...environment }))),
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
