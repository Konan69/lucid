import { ChannelUnavailable, type Channel } from '@vivid/contracts'
import { Effect, Layer, Option, Predicate, Schedule, Stream } from 'effect'
import { optionalSetting } from '../config.ts'
import { discordLayer, discordToken } from './discord.ts'
import { photonLayer } from './photon.ts'
import {
  ChannelProvider,
  type ChannelDisconnected,
  type ChannelConnectionRefused,
} from './provider.ts'
import { channelBackoff } from './worker.ts'

/** Retry each socket independently. A refused provider parks until configuration is repaired and the server restarts. */
const supervised = (provider: ChannelProvider['Service']) =>
  provider.inbound.pipe(
    Stream.tapError((error) =>
      Effect.logError('Channel connection failed', { channel: error.channel, reason: error._tag }),
    ),
    Stream.retry(
      channelBackoff.pipe(
        Schedule.setInputType<ChannelDisconnected | ChannelConnectionRefused>(),
        Schedule.while(({ input }) =>
          Effect.succeed(Predicate.isTagged(input, 'ChannelDisconnected')),
        ),
      ),
    ),
    Stream.catchTag('ChannelConnectionRefused', () => Stream.never),
  )

/** The provider that advertises a channel also owns its enrolments, code address and sends. */
export const combineChannels = (providers: ReadonlyArray<ChannelProvider['Service']>) => {
  const selected = (channel: Channel) =>
    providers.find((provider) => provider.channels.includes(channel))
  return ChannelProvider.of({
    channels: providers.flatMap((provider) => provider.channels),
    codeAddress: (channel) => {
      const provider = selected(channel)
      return provider === undefined ? Option.none() : provider.codeAddress(channel)
    },
    enrol: (channel, address) => {
      const provider = selected(channel)
      return provider === undefined
        ? Effect.fail(new ChannelUnavailable({ channel }))
        : provider.enrol(channel, address)
    },
    unenrol: (channel, id) => {
      const provider = selected(channel)
      return provider === undefined
        ? Effect.fail(new ChannelUnavailable({ channel }))
        : provider.unenrol(channel, id)
    },
    send: (input) => {
      const provider = selected(input.channel)
      return provider === undefined
        ? Effect.fail(new ChannelUnavailable({ channel: input.channel }))
        : provider.send(input)
    },
    inbound: Stream.mergeAll(providers.map(supervised), { concurrency: 'unbounded' }),
  })
}

/** No Discord credential means the exact existing Photon provider, with no Discord I/O during startup. */
export const channelProviderLayer = Layer.unwrap(
  Effect.gen(function* () {
    const photon = yield* ChannelProvider
    const token = yield* optionalSetting(
      'VIVID_DISCORD_BOT_TOKEN',
      discordToken,
      'a Discord bot token containing a snowflake user id',
    )
    if (Option.isNone(token)) return Layer.succeed(ChannelProvider, photon)
    return Layer.effect(
      ChannelProvider,
      Effect.gen(function* () {
        const discord = yield* ChannelProvider
        return combineChannels([photon, discord])
      }),
    ).pipe(Layer.provide(discordLayer(token.value)))
  }),
).pipe(Layer.provide(photonLayer))
