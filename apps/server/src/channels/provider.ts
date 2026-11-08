import {
  Channel,
  ChannelAddress,
  ChannelUnavailable,
  ChannelProviderFailed,
} from '@vivid/contracts'
import { Context, type Effect, type Option, Schema, type Stream } from 'effect'

/** Provider ids are opaque; replay identity must not depend on the message's words. */
export const ChannelMessageId = Schema.NonEmptyString.pipe(Schema.brand('ChannelMessageId'))
export type ChannelMessageId = typeof ChannelMessageId.Type

/**
 * Where a message was written when a channel has more than one place for it: on Discord, a direct
 * message or a server channel, and the message itself. A reply goes back to that place and
 * answers that message. A channel with one conversation per Person (iMessage) has none.
 */
export const ChannelPlace = Schema.Struct({
  conversation: Schema.NonEmptyString,
  message: ChannelMessageId,
})
export type ChannelPlace = typeof ChannelPlace.Type

/** The adapter decodes once; no SDK values or credentials cross the provider seam. */
export const ChannelInbound = Schema.Struct({
  id: ChannelMessageId,
  channel: Channel,
  sender: ChannelAddress,
  text: Schema.NonEmptyString,
  receivedAt: Schema.Number.check(Schema.isFinite()),
  place: Schema.optionalKey(ChannelPlace),
})
export type ChannelInbound = typeof ChannelInbound.Type

/** Connection failure is retryable; it carries no SDK payload, address, or content. */
export class ChannelDisconnected extends Schema.TaggedError<ChannelDisconnected>()(
  'ChannelDisconnected',
  { channel: Channel },
  { title: 'Channel disconnected' },
) {}

/** Provider authentication or project setup must be repaired before reconnecting can succeed. */
export class ChannelConnectionRefused extends Schema.TaggedError<ChannelConnectionRefused>()(
  'ChannelConnectionRefused',
  { channel: Channel },
  { title: 'Channel connection refused' },
) {}

/** Invalid SDK envelopes cannot safely be attributed to a Person. */
export class InvalidChannelMessage extends Schema.TaggedError<InvalidChannelMessage>()(
  'InvalidChannelMessage',
  { channel: Channel },
  { title: 'Invalid channel message' },
) {}

/** A send can have left the provider before its Promise failed; it must never be blindly retried. */
export class ChannelSendUnknown extends Schema.TaggedError<ChannelSendUnknown>()(
  'ChannelSendUnknown',
  { channel: Channel },
  { title: 'Channel send outcome unknown' },
) {}

/** SDK acquisition or recipient resolution failed before send: nothing was dispatched. */
export class ChannelRecipientMissing extends Schema.TaggedError<ChannelRecipientMissing>()(
  'ChannelRecipientMissing',
  { channel: Channel },
  { title: 'Channel recipient unavailable' },
) {}

export interface ChannelProviderService {
  /**
   * The channels Vivid can text on. `Channel` is the closed product vocabulary and is wider: a
   * channel named there and absent here (WhatsApp today) is refused with `ChannelUnavailable`.
   */
  readonly channels: ReadonlyArray<Channel>
  /**
   * The address a Person messages on a channel that learns their account from a code (Discord:
   * Vivid's own bot account). None for a channel that enrols a number the Person gives.
   */
  readonly codeAddress: (channel: Channel) => Option.Option<ChannelAddress>
  /** Photon deletes by user id, so its opaque enrolment receipt must survive server restarts. */
  readonly enrol: (
    channel: Channel,
    address: ChannelAddress,
  ) => Effect.Effect<ChannelEnrolment, ChannelUnavailable | ChannelProviderFailed>
  readonly unenrol: (
    channel: Channel,
    id: ChannelEnrolmentId,
  ) => Effect.Effect<void, ChannelUnavailable | ChannelProviderFailed>
  readonly inbound: Stream.Stream<ChannelInbound, ChannelDisconnected | ChannelConnectionRefused>
  readonly send: (input: {
    readonly channel: Channel
    readonly address: ChannelAddress
    readonly text: string
    /** Answer in this place instead of the Person's own conversation (`ChannelPlace`). */
    readonly place?: ChannelPlace
  }) => Effect.Effect<void, ChannelUnavailable | ChannelRecipientMissing | ChannelSendUnknown>
}

/** The hosted API assigns a line per Person and deletes by opaque user id, never by phone. */
export const ChannelEnrolmentId = Schema.NonEmptyString.pipe(Schema.brand('ChannelEnrolmentId'))
export type ChannelEnrolmentId = typeof ChannelEnrolmentId.Type
export const ChannelEnrolment = Schema.Struct({ id: ChannelEnrolmentId, textTo: ChannelAddress })
export type ChannelEnrolment = typeof ChannelEnrolment.Type

/** Owns the external messaging connection, independent of Thread transport and tenancy. */
export class ChannelProvider extends Context.Service<ChannelProvider, ChannelProviderService>()(
  'vivid/ChannelProvider',
) {}

/** A timed-out send may still reach Photon; the claimed reply must remain unknown. */
export class ChannelSendTimedOut extends Schema.TaggedError<ChannelSendTimedOut>()(
  'ChannelSendTimedOut',
  { channel: Channel },
  { title: 'Channel send timed out' },
) {}
