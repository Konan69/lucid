import { Channel, ChannelAddress, ChannelStanding, PersonId, ThreadId } from '@vivid/contracts'
import { Schema } from 'effect'

/** Only confirmation owns a code; consuming it removes it from persistence altogether. */
export const LinkState = Schema.TaggedUnion({
  Confirming: { code: Schema.String, expiresAt: Schema.Number },
  Connected: { since: Schema.Number },
})
export type LinkState = typeof LinkState.Type

/** The address columns own routing; state JSON owns only the proof of possession. */
export const StoredLink = Schema.Struct({
  personId: PersonId,
  channel: Channel,
  address: ChannelAddress,
  textTo: ChannelAddress,
  enrolmentId: Schema.NonEmptyString,
  state: LinkState,
  threadId: Schema.NullOr(ThreadId),
})
export type StoredLink = typeof StoredLink.Type

/** Projection keeps the public contract independent of the persistence state machine. */
export const standingOf = (link: StoredLink): ChannelStanding =>
  LinkState.match<ChannelStanding>(link.state, {
    Confirming: ({ code, expiresAt }) =>
      ChannelStanding.cases.Confirming.make({
        address: link.address,
        textTo: link.textTo,
        code,
        expiresAt,
      }),
    Connected: ({ since }) =>
      ChannelStanding.cases.Connected.make({ address: link.address, textTo: link.textTo, since }),
  })
