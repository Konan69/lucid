import { Channel, ChannelAddress, ChannelUnavailable } from '@vivid/contracts'
import { Context, Effect, Layer, Schema, Stream } from 'effect'

/** Provider ids are opaque; replay identity must not depend on the message's words. */
export const ChannelMessageId = Schema.NonEmptyString.pipe(Schema.brand('ChannelMessageId'))
export type ChannelMessageId = typeof ChannelMessageId.Type

/** Attachments and control events stay explicit so none accidentally become Person-authored text. */
export const ChannelContent = Schema.TaggedUnion({
  Text: { text: Schema.NonEmptyString },
  Unsupported: {},
})
export type ChannelContent = typeof ChannelContent.Type

/** The adapter decodes once; no SDK values or credentials cross the provider seam. */
export const ChannelInbound = Schema.Struct({
  id: ChannelMessageId,
  channel: Channel,
  sender: ChannelAddress,
  content: ChannelContent,
  receivedAt: Schema.Number.check(Schema.isFinite()),
})
export type ChannelInbound = typeof ChannelInbound.Type

/** Connection failure is retryable; it carries no SDK payload, address, or content. */
export class ChannelDisconnected extends Schema.TaggedError<ChannelDisconnected>()(
  'ChannelDisconnected',
  { channel: Channel },
  { title: 'Channel disconnected' },
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
  { channel: Channel, key: Schema.String },
  { title: 'Channel send outcome unknown' },
) {}

/** A proven missing inbound conversation refuses before dispatch. */
export class ChannelRecipientMissing extends Schema.TaggedError<ChannelRecipientMissing>()(
  'ChannelRecipientMissing',
  { channel: Channel },
  { title: 'Channel recipient unavailable' },
) {}

export interface ChannelProviderService {
  readonly address: (channel: Channel) => Effect.Effect<ChannelAddress, ChannelUnavailable>
  readonly inbound: Stream.Stream<ChannelInbound, ChannelDisconnected>
  readonly send: (input: {
    readonly channel: Channel
    readonly address: ChannelAddress
    readonly text: string
    readonly key: string
  }) => Effect.Effect<void, ChannelUnavailable | ChannelRecipientMissing | ChannelSendUnknown>
  /** Recovery may resend only when this capability guarantees caller-key deduplication. */
  readonly idempotentSends: boolean
}

/** Owns the external messaging connection, independent of Thread transport and tenancy. */
export class ChannelProvider extends Context.Service<ChannelProvider, ChannelProviderService>()(
  'vivid/ChannelProvider',
) {}

/** Missing credentials leave the server operational and every channel start explicitly unavailable. */
export const unavailableChannelProviderLayer = Layer.succeed(ChannelProvider, {
  address: Effect.fn('Channels.unavailableAddress')((channel) =>
    Effect.fail(new ChannelUnavailable({ channel })),
  ),
  inbound: Stream.empty,
  send: Effect.fn('Channels.unavailableSend')((input) =>
    Effect.fail(new ChannelUnavailable({ channel: input.channel })),
  ),
  idempotentSends: false,
})
