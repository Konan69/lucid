import { Effect, Option } from 'effect'
import {
  ChannelListResponse,
  ChannelLinkResponse,
  type Channel,
  type ConnectChannelRequest,
} from '@vivid/contracts'
import { requirePerson, type Actor } from '../auth/access.ts'
import { live } from '../live/query.ts'
import { ChannelStore } from './store.ts'

/** Every watch reloads this Person's persisted standing through the house live-query helper. */
const standings = Effect.fn('Channels.standings')(function* (actor: Actor) {
  return ChannelListResponse.make({ channels: yield* (yield* ChannelStore).list(actor) })
})

/** Linking remains a signed-in Person's act even when their selected workspace is a Company. */
const personActor = Effect.fn('Channels.personActor')(function* () {
  const auth = yield* requirePerson()
  return {
    person: auth.person,
    workspace: auth.workspace,
    by: 'person',
    threadId: Option.none(),
    helper: Option.none(),
  } satisfies Actor
})

export const channelHandlers = {
  WatchChannels: () => live('WatchChannels', [], standings),
  /** Owner decision, 4 October 2026: testing with one Person; ownership proof deferred, so Connect emits Connected directly. */
  ConnectChannel: Effect.fn('Rpc.ConnectChannel')(function* (request: ConnectChannelRequest) {
    const link = yield* (yield* ChannelStore).connect(
      yield* personActor(),
      request.channel,
      request.address,
    )
    return ChannelLinkResponse.make({ link })
  }),
  DisconnectChannel: Effect.fn('Rpc.DisconnectChannel')(function* ({
    channel,
  }: {
    readonly channel: Channel
  }) {
    const link = yield* (yield* ChannelStore).disconnect(yield* personActor(), channel)
    return ChannelLinkResponse.make({ link })
  }),
}
