import { NodeHttpClient } from '@effect/platform-node'
import { describe, expect, it, layer } from '@effect/vitest'
import { ConfigProvider, Effect, Layer, Result } from 'effect'
import { ConfigurationError } from '../config.ts'
import { normalizeChannelAddress } from './address.ts'
import { photonLayer } from './photon.ts'
import { ChannelProvider } from './provider.ts'

const settings = {
  VIVID_PHOTON_PROJECT_ID: 'test-project',
  VIVID_PHOTON_PROJECT_SECRET: 'test-secret',
}

/**
 * Texting is part of every running Vivid: with a Photon credential missing or blank the Layer does
 * not build, so the server does not start, and the failure names the variable without carrying a
 * supplied value. Building dials nothing, so no transport is stubbed.
 */
describe('Photon settings', () => {
  layer(NodeHttpClient.layerUndici)((it) => {
    for (const [name, values, variable] of [
      [
        'the project id is missing',
        { ...settings, VIVID_PHOTON_PROJECT_ID: undefined },
        'VIVID_PHOTON_PROJECT_ID',
      ],
      [
        'the project id is blank',
        { ...settings, VIVID_PHOTON_PROJECT_ID: ' ' },
        'VIVID_PHOTON_PROJECT_ID',
      ],
      [
        'the project secret is missing',
        { ...settings, VIVID_PHOTON_PROJECT_SECRET: undefined },
        'VIVID_PHOTON_PROJECT_SECRET',
      ],
      [
        'the project secret is empty',
        { ...settings, VIVID_PHOTON_PROJECT_SECRET: '' },
        'VIVID_PHOTON_PROJECT_SECRET',
      ],
    ] as const) {
      it.effect(`does not build when ${name}`, () =>
        Effect.gen(function* () {
          const failure = yield* Layer.build(photonLayer).pipe(
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromUnknown(values),
            ),
            Effect.scoped,
            Effect.flip,
          )
          expect(failure).toBeInstanceOf(ConfigurationError)
          expect(failure).toMatchObject({ variable })
          expect(JSON.stringify(failure)).not.toContain(settings.VIVID_PHOTON_PROJECT_SECRET)
        }),
      )
    }

    it.layer(
      photonLayer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(settings)))),
    )((it) => {
      it.effect('builds with both credentials and texts on iMessage only', () =>
        Effect.gen(function* () {
          expect((yield* ChannelProvider).channels).toEqual(['iMessage'])
        }).pipe(Effect.scoped),
      )
    })
  })
})

describe('channel address', () => {
  it.effect('normalizes an international phone without inventing a country', () =>
    Effect.gen(function* () {
      expect(
        yield* normalizeChannelAddress({ channel: 'iMessage', value: ' +1 (202) 555-0123 ' }),
      ).toBe('+12025550123')
      const local = yield* normalizeChannelAddress({
        channel: 'iMessage',
        value: '2025550123',
      }).pipe(Effect.result)
      expect(Result.isFailure(local) ? local.failure._tag : 'accepted').toBe(
        'InvalidChannelAddress',
      )
    }),
  )

  it.effect('normalizes email sender identity once', () =>
    Effect.gen(function* () {
      expect(
        yield* normalizeChannelAddress({ channel: 'iMessage', value: ' Ada@Example.TEST ' }),
      ).toBe('ada@example.test')
    }),
  )

  it.effect('refuses malformed identity without retaining its supplied value', () =>
    Effect.gen(function* () {
      for (const value of ['+000123', '+1234567890123456', 'no-address', 'a@']) {
        const result = yield* normalizeChannelAddress({ channel: 'iMessage', value }).pipe(
          Effect.result,
        )
        expect(Result.isFailure(result) ? result.failure._tag : 'accepted').toBe(
          'InvalidChannelAddress',
        )
        if (Result.isFailure(result)) expect(JSON.stringify(result.failure)).not.toContain(value)
      }
    }),
  )
})
