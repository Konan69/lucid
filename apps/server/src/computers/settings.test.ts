import { describe, expect, it } from '@effect/vitest'
import { ConfigProvider, Effect, Option } from 'effect'
import { ConfigurationError } from '../config.ts'
import { boatConfiguration } from './boat/transport.ts'

const complete = {
  VIVID_BOAT_API_KEY: 'settings-test-key',
  VIVID_BOAT_TEMPLATE: 'vivid-computer-settings-test',
}

/** The whole environment is replaced, so a developer's own Boat settings cannot leak into a case. */
const reading = (settings: Readonly<Record<string, string>>) =>
  boatConfiguration().pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(settings))),
  )

/**
 * A server has its Computer provider or it does not start. These read the settings exactly as the
 * provider Layer does while the server is composed; a failure here is a failed launch.
 */
describe('Computer provider settings', () => {
  it.effect.each(['VIVID_BOAT_API_KEY', 'VIVID_BOAT_TEMPLATE'] as const)(
    'refuses to compose without %s and names it',
    (missing) =>
      Effect.gen(function* () {
        const { [missing]: _left, ...rest } = complete
        const failure = yield* reading(rest).pipe(Effect.flip)
        expect(failure).toBeInstanceOf(ConfigurationError)
        expect(failure.variable).toBe(missing)
        // A blank line in an env file is not a setting either, and neither is a padded paste.
        for (const value of ['', '   ', ` ${complete[missing]}\n`])
          expect(
            (yield* reading({ ...complete, [missing]: value }).pipe(Effect.flip)).variable,
          ).toBe(missing)
      }),
  )

  it.effect('never carries a supplied value in the failure', () =>
    Effect.gen(function* () {
      const failure = yield* reading({ ...complete, VIVID_BOAT_SIZE: 'secret-pasted-here' }).pipe(
        Effect.flip,
      )
      expect(failure.variable).toBe('VIVID_BOAT_SIZE')
      expect(JSON.stringify(failure)).not.toContain('secret-pasted-here')
    }),
  )

  it.effect('needs only the key and the template; the rest have defaults or are choices', () =>
    Effect.gen(function* () {
      const settings = yield* reading(complete)
      expect(settings.create).toMatchObject({
        from: 'vivid-computer-settings-test',
        type: 'default',
        ttlSeconds: 3600,
      })
      expect(Option.isNone(settings.org)).toBe(true)
      expect(Option.isNone(settings.adopt)).toBe(true)
    }),
  )
})
