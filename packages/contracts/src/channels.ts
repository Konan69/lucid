import { Schema } from 'effect'

/** The product vocabulary is closed even while only iMessage has an installed provider. */
export const Channel = Schema.Literals(['iMessage', 'WhatsApp'])
export type Channel = typeof Channel.Type

/** Canonical sender identity: international phone number or lower-case email address. */
export const ChannelAddress = Schema.String.check(
  Schema.isPattern(/^(?:\+[1-9]\d{1,14}|[^\s@]+@[^\s@]+\.[^\s@]+)$/u),
).pipe(Schema.brand('ChannelAddress'))
export type ChannelAddress = typeof ChannelAddress.Type

/** An absent Integration is an expected installation state, never a startup failure. */
export class ChannelUnavailable extends Schema.TaggedError<ChannelUnavailable>()(
  'ChannelUnavailable',
  { channel: Channel },
  { title: 'Channel unavailable' },
) {}
