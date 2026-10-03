import { expect, it } from '@effect/vitest'
import { ConfigProvider, Effect, Option } from 'effect'
import { loadServerConfig } from './config.ts'

const base = {
  DATABASE_URL: 'postgres://test@127.0.0.1:1/test',
  AUTH_SECRET: 'test-Auth_secret-0123456789-ABCDEFG',
  VIVID_RUNTIME_URL: 'http://127.0.0.1:1',
  VIVID_RUNTIME_TOKEN: 'test-token',
}

/** An unchanged local environment keeps loopback and no static routes; container inputs are opt-in. */
it.effect('keeps local launch defaults and decodes container launch inputs', () =>
  Effect.gen(function* () {
    const local = yield* loadServerConfig.pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(base))),
    )
    expect(local.HOST).toBe('127.0.0.1')
    expect(local.VIVID_WEB_DIST).toEqual(Option.none())
    expect(local.VIVID_MOBILE_UPDATES).toEqual(Option.none())
    const container = yield* loadServerConfig.pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            ...base,
            HOST: '0.0.0.0',
            VIVID_WEB_DIST: '/app/apps/web/dist',
            VIVID_MOBILE_UPDATES: '/app/apps/mobile/updates',
          }),
        ),
      ),
    )
    expect(container.HOST).toBe('0.0.0.0')
    expect(container.VIVID_WEB_DIST).toEqual(Option.some('/app/apps/web/dist'))
    expect(container.VIVID_MOBILE_UPDATES).toEqual(Option.some('/app/apps/mobile/updates'))
  }),
)
