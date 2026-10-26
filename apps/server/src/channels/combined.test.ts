import { describe, expect, it } from '@effect/vitest'
import { ChannelAddress, ChannelUnavailable, type Channel } from '@vivid/contracts'
import { ConfigProvider, Effect, Layer, Option, Stream } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { channelProviderLayer, combineChannels } from './combined.ts'
import {
  ChannelDisconnected,
  ChannelInbound,
  ChannelMessageId,
  ChannelProvider,
} from './provider.ts'

const message = ChannelInbound.make({
  id: ChannelMessageId.make('message'),
  channel: 'Discord',
  sender: ChannelAddress.make('discord:523456789012345678'),
  text: 'hello',
  receivedAt: 0,
})
const provider = (
  channel: Channel,
  inbound: ChannelProvider['Service']['inbound'],
  sends: string[],
) =>
  ChannelProvider.of({
    channels: [channel],
    codeAddress: () => Option.none(),
    enrol: () => Effect.fail(new ChannelUnavailable({ channel })),
    unenrol: () => Effect.void,
    inbound,
    send: () =>
      Effect.sync(() => {
        sends.push(channel)
      }),
  })

describe('channel composition', () => {
  it.effect('composes the Photon provider when the Discord token is unset', () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(
        channelProviderLayer.pipe(
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                VIVID_PHOTON_PROJECT_ID: 'test',
                VIVID_PHOTON_PROJECT_SECRET: 'test',
              }),
            ),
          ),
        ),
      )
      expect((yield* ChannelProvider.pipe(Effect.provide(context))).channels).toEqual(['iMessage'])
    }).pipe(Effect.scoped),
  )
  it.effect(
    'keeps the other inbound stream alive during a disconnect and routes sends by channel',
    () =>
      Effect.gen(function* () {
        const sends: string[] = []
        const combined = combineChannels([
          provider(
            'iMessage',
            Stream.fail(new ChannelDisconnected({ channel: 'iMessage' })),
            sends,
          ),
          provider('Discord', Stream.make(message).pipe(Stream.concat(Stream.never)), sends),
        ])
        expect(yield* combined.inbound.pipe(Stream.take(1), Stream.runCollect)).toEqual([message])
        for (const channel of ['iMessage', 'Discord'] satisfies ReadonlyArray<Channel>)
          yield* combined.send({ channel, address: message.sender, text: 'reply' })
        expect(sends).toEqual(['iMessage', 'Discord'])
      }).pipe(Effect.scoped),
  )
})
