import { Schema } from 'effect'

/** The product vocabulary is closed. Discord is offered only where the server has a Discord bot. */
export const Channel = Schema.Literals(['iMessage', 'WhatsApp', 'Discord'])
export type Channel = typeof Channel.Type

/**
 * Canonical sender identity: international phone number, lower-case email address, or a Discord
 * account as `discord:` and its user id.
 */
export const ChannelAddress = Schema.String.check(
  Schema.isPattern(/^(?:\+[1-9]\d{1,14}|[^\s@]+@[^\s@]+\.[^\s@]+|discord:[1-9]\d{16,19})$/u),
).pipe(Schema.brand('ChannelAddress'))
export type ChannelAddress = typeof ChannelAddress.Type

/** Vivid does not text on this channel yet (WhatsApp today). Every running Vivid has iMessage. */
export class ChannelUnavailable extends Schema.TaggedError<ChannelUnavailable>()(
  'ChannelUnavailable',
  { channel: Channel },
  { title: 'Channel unavailable' },
) {}

/**
 * Where one channel stands for the signed-in Person. A Person has at most one address on a
 * channel.
 *
 * - `Unavailable`: Vivid does not text on this channel yet (WhatsApp today). Every running Vivid
 *   has iMessage, so iMessage never stands here.
 * - `NotConnected`: nothing has been started.
 * - `Confirming`: the Person gave their number and it is enrolled with the provider, but it is
 *   not theirs to us until a message carrying `code` arrives FROM that number at `textTo`.
 *   Typing a number proves nothing: without this step anyone could attach someone else's phone
 *   and read that person's replies. The code is short-lived and shown only to the Person who
 *   asked for it, so it is kept readable and comes back on every watch, not once.
 * - `Awaiting`: for a channel where the Person has no number to give (Discord), Vivid learns who
 *   they are from the first message carrying `code` sent to `textTo`. Until then no account is
 *   theirs, and a message without the code from anyone is ignored.
 * - `Connected`: messages from `address` are this Person's, and Vivid answers at `textTo`.
 *
 * `textTo` is per Person: the provider assigns each enrolled number the number it must text.
 */
export const ChannelStanding = Schema.TaggedUnion({
  Unavailable: {},
  NotConnected: {},
  Confirming: {
    address: ChannelAddress,
    textTo: ChannelAddress,
    code: Schema.String,
    expiresAt: Schema.Finite,
  },
  Awaiting: { textTo: ChannelAddress, code: Schema.String, expiresAt: Schema.Finite },
  Connected: { address: ChannelAddress, textTo: ChannelAddress, since: Schema.Finite },
})
export type ChannelStanding = typeof ChannelStanding.Type

/** One channel and where it stands. `WatchChannels` answers one of these for every `Channel`. */
export const ChannelLink = Schema.Struct({ channel: Channel, standing: ChannelStanding }).annotate({
  identifier: 'ChannelLink',
  title: 'ChannelLink',
})
export interface ChannelLink extends Schema.Schema.Type<typeof ChannelLink> {}

export const ChannelListResponse = Schema.Struct({ channels: Schema.Array(ChannelLink) })
export interface ChannelListResponse extends Schema.Schema.Type<typeof ChannelListResponse> {}

/**
 * The Person's own number on the channel. It is decoded as an address before anything is sent.
 * A channel that learns the account from the code (Discord) takes no address; a phone channel
 * without one is refused with `ChannelAddressInvalid`.
 */
export const ConnectChannelRequest = Schema.Struct({
  channel: Channel,
  address: Schema.optionalKey(Schema.String),
})
export interface ConnectChannelRequest extends Schema.Schema.Type<typeof ConnectChannelRequest> {}

export const ChannelLinkResponse = Schema.Struct({ link: ChannelLink })
export interface ChannelLinkResponse extends Schema.Schema.Type<typeof ChannelLinkResponse> {}

/** What was typed is not a number this channel can reach. */
export class ChannelAddressInvalid extends Schema.TaggedError<ChannelAddressInvalid>()(
  'ChannelAddressInvalid',
  { channel: Channel },
  { title: 'That is not a phone number this channel can reach' },
) {}

/** The number already belongs to another Person on this channel. Nothing about them is said. */
export class ChannelAddressTaken extends Schema.TaggedError<ChannelAddressTaken>()(
  'ChannelAddressTaken',
  { channel: Channel },
  { title: 'That number is already connected' },
) {}

/** The provider's plan has no room for another enrolled Person. */
export class ChannelLimitReached extends Schema.TaggedError<ChannelLimitReached>()(
  'ChannelLimitReached',
  { channel: Channel },
  { title: 'No more people can be connected on this plan' },
) {}

/** The provider refused or could not be reached. Nothing was changed. */
export class ChannelProviderFailed extends Schema.TaggedError<ChannelProviderFailed>()(
  'ChannelProviderFailed',
  { channel: Channel },
  { title: 'The channel could not be reached' },
) {}

export const ChannelFailure = Schema.Union([
  ChannelUnavailable,
  ChannelAddressInvalid,
  ChannelAddressTaken,
  ChannelLimitReached,
  ChannelProviderFailed,
])
export type ChannelFailure = typeof ChannelFailure.Type
