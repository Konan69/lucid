import { Effect } from 'effect'
import {
  Channel,
  ChannelLink,
  ChannelListResponse,
  ChannelStanding,
  ChannelUnavailable,
  type ConnectChannelRequest,
} from '@vivid/contracts'
import { requirePerson } from '../auth/access.ts'
import { live } from '../live/query.ts'

/**
 * Every channel as it stands for a Person today: none has a store behind it yet, so each is
 * `Unavailable`. This is the true state, not a placeholder value: the linking store, the ledger
 * and the provider wiring are not built, so no number can be connected and none is claimed to
 * be. The screens are built against the real contract and change by themselves when this does.
 */
const standings = Effect.succeed(
  ChannelListResponse.make({
    channels: Channel.literals.map((channel) =>
      ChannelLink.make({ channel, standing: ChannelStanding.cases.Unavailable.make({}) }),
    ),
  }),
)

export const channelHandlers = {
  WatchChannels: () => live(() => standings),
  /** Refused with the channel named, so the screen can say which one is not set up. */
  ConnectChannel: Effect.fn('Rpc.ConnectChannel')(function* (request: ConnectChannelRequest) {
    yield* requirePerson()
    return yield* new ChannelUnavailable({ channel: request.channel })
  }),
  DisconnectChannel: Effect.fn('Rpc.DisconnectChannel')(function* ({
    channel,
  }: {
    readonly channel: Channel
  }) {
    yield* requirePerson()
    return yield* new ChannelUnavailable({ channel })
  }),
}
