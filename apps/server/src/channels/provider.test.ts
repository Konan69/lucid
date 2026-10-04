import { NodeHttpClient } from '@effect/platform-node'
import { describe, expect, it } from '@effect/vitest'
import { ConfigProvider, Effect, Layer, Option, Result, Stream } from 'effect'
import { normalizeChannelAddress } from './address.ts'
import { photonLayer } from './photon.ts'
import { ChannelProvider } from './provider.ts'

/** Empty config exercises the production selection without contacting Photon or opening a line. */
const noPhoton = photonLayer.pipe(
  Layer.provide(NodeHttpClient.layerUndici),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
)

/** Partial credentials must also select unavailable, rather than trying an anonymous connection. */
const partialPhoton = photonLayer.pipe(
  Layer.provide(NodeHttpClient.layerUndici),
  Layer.provide(
    ConfigProvider.layer(ConfigProvider.fromUnknown({ VIVID_PHOTON_PROJECT_ID: 'test' })),
  ),
)

describe('channel provider', () => {
  it.effect('starts without credentials and reports both channels unavailable', () =>
    Effect.gen(function* () {
      const provider = yield* ChannelProvider
      for (const channel of ['iMessage', 'WhatsApp'] as const) {
        const outcome = yield* provider
          .enrol(channel, yield* normalizeChannelAddress({ channel, value: '+12025550123' }))
          .pipe(Effect.result)
        expect(Result.isFailure(outcome) ? outcome.failure._tag : 'available').toBe(
          'ChannelUnavailable',
        )
      }
      expect(Option.isNone(yield* Stream.runHead(provider.inbound))).toBe(true)
    }).pipe(Effect.provide(noPhoton)),
  )

  it.effect('refuses a send before dispatch when no Integration is configured', () =>
    Effect.gen(function* () {
      const address = yield* normalizeChannelAddress({ channel: 'iMessage', value: '+12025550123' })
      const outcome = yield* (yield* ChannelProvider)
        .send({
          channel: 'iMessage',
          address,
          text: 'test',
        })
        .pipe(Effect.result)
      expect(Result.isFailure(outcome) ? outcome.failure._tag : 'sent').toBe('ChannelUnavailable')
    }).pipe(Effect.provide(noPhoton)),
  )

  it.effect('does not acquire a connection with partial credentials', () =>
    Effect.gen(function* () {
      const outcome = yield* (yield* ChannelProvider)
        .enrol(
          'iMessage',
          yield* normalizeChannelAddress({ channel: 'iMessage', value: '+12025550123' }),
        )
        .pipe(Effect.result)
      expect(Result.isFailure(outcome) ? outcome.failure._tag : 'available').toBe(
        'ChannelUnavailable',
      )
    }).pipe(Effect.provide(partialPhoton)),
  )

  it.effect('empty credential values also select the unavailable provider without SDK I/O', () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(
        photonLayer.pipe(
          Layer.provide(NodeHttpClient.layerUndici),
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                VIVID_PHOTON_PROJECT_ID: '',
                VIVID_PHOTON_PROJECT_SECRET: '',
              }),
            ),
          ),
        ),
      )
      const provider = yield* ChannelProvider.pipe(Effect.provideContext(context))
      expect(provider.channels).toEqual([])
    }).pipe(Effect.scoped),
  )

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
