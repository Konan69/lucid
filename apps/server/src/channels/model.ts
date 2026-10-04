import { Channel, ChannelAddress, ChannelStanding, PersonId, ThreadId } from '@vivid/contracts'
import { Schema } from 'effect'
import { ChannelEnrolmentId } from './provider.ts'

/** A stored enrolment is connected immediately during the one-Person test; no proof state is persisted. */
export const StoredLink = Schema.Struct({
  personId: PersonId,
  channel: Channel,
  address: ChannelAddress,
  textTo: ChannelAddress,
  enrolmentId: ChannelEnrolmentId,
  since: Schema.Number.check(Schema.isFinite()),
  threadId: Schema.NullOr(ThreadId),
})
export type StoredLink = typeof StoredLink.Type

/** Persistence owns routing; the established public standing remains transport-independent. */
export const standingOf = (link: StoredLink): ChannelStanding =>
  ChannelStanding.cases.Connected.make({
    address: link.address,
    textTo: link.textTo,
    since: link.since,
  })
