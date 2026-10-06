import { Channel, ChannelAddress } from '@vivid/contracts'
import { Effect, Schema } from 'effect'

/** Identity normalization failure stays distinct from a missing Integration or transport failure. */
export class InvalidChannelAddress extends Schema.TaggedError<InvalidChannelAddress>()(
  'InvalidChannelAddress',
  { channel: Channel },
  { title: 'Invalid channel address' },
) {}

const decodeAddress = Schema.decodeUnknownEffect(ChannelAddress)

/**
 * Normalize only at ingress. Local phone numbers are refused because inventing a country would
 * link another Person; E.164 display separators are removed and email addresses folded once.
 */
export const normalizeChannelAddress = Effect.fn('Channels.normalizeAddress')(function* (input: {
  readonly channel: Channel
  readonly value: string
}) {
  const trimmed = input.value.trim()
  const canonical = trimmed.startsWith('+')
    ? trimmed.replace(/[ ()-]/gu, '')
    : trimmed.toLowerCase()
  return yield* decodeAddress(canonical).pipe(
    Effect.mapError(() => new InvalidChannelAddress({ channel: input.channel })),
  )
})

/** Enrolment accepts only decoded phone identities; the contract already validates E.164. */
export const normalizeChannelPhone = Effect.fn('Channels.normalizePhone')(function* (input: {
  readonly channel: Channel
  readonly value: string
}) {
  const address = yield* normalizeChannelAddress(input)
  if (!address.startsWith('+')) return yield* new InvalidChannelAddress({ channel: input.channel })
  return address
})
