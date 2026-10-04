import { VividRpcClient } from '@vivid/client-runtime'
import {
  ChannelFailure,
  ChannelStanding,
  type Channel,
  type ChannelLink,
  type ChannelListResponse,
} from '@vivid/contracts'
import { Effect, Option, Schema } from 'effect'
import type { ProductFailure } from './live.js'

/**
 * Texting Vivid from a messaging app, as every client says and does it.
 *
 * A Person gives their own number, texts a short code from that phone to the number they are
 * shown, and from then on messages from that phone are theirs. The web app and the phone app draw
 * this differently, but what each standing is called, what a refusal says and what link opens the
 * messaging app already addressed are the same everywhere, so they are decided here once.
 */

/**
 * A number as it is sent: without the spaces, brackets, dots and hyphens people write a phone
 * number with so it can be read. The server decides whether what is left is a number it can
 * reach; this only stops "+234 801 234 5678" being refused for its spacing.
 */
export const typedAddress = (written: string) => written.replaceAll(/[\s().-]/gu, '')

/**
 * Gives the Person's own number to a channel. The answer is where the channel now stands:
 * `Confirming`, with the code to text. Asking again with the same number while it is still
 * `Confirming` is how a new code is asked for.
 */
export const connectChannel = Effect.fn('Texting.connect')(function* (
  channel: Channel,
  written: string,
) {
  const client = yield* VividRpcClient
  const { link } = yield* client.ConnectChannel({ channel, address: typedAddress(written) })
  return link
})

/** Takes the Person's number off a channel, confirmed or not. */
export const disconnectChannel = Effect.fn('Texting.disconnect')(function* (channel: Channel) {
  const client = yield* VividRpcClient
  const { link } = yield* client.DisconnectChannel({ channel })
  return link
})

/**
 * The channels as they stand once one of them has answered a connect or a disconnect. The call's
 * own answer is laid over the live list (`LiveQuery.expect`) so the screen moves the moment the
 * server replies, and does not show the old standing until the watch catches up.
 */
export const withLink = (current: ChannelListResponse, link: ChannelLink): ChannelListResponse => ({
  channels: current.channels.map((known) => (known.channel === link.channel ? link : known)),
})

/** Where a channel stands, in the word or two a tile or a row has room for. */
export const channelWords = (standing: ChannelStanding): string =>
  ChannelStanding.match(standing, {
    Unavailable: () => 'Not set up',
    NotConnected: () => 'Not connected',
    Confirming: () => 'Waiting for your text',
    Connected: () => 'Connected',
  })

/**
 * What each refusal is in plain words. Keyed by the contract's own failures, so a failure added
 * there without a sentence here does not typecheck.
 */
const SAID = {
  ChannelUnavailable: (channel) => `${channel} is not set up on this Vivid yet.`,
  ChannelAddressInvalid: (channel) =>
    `That is not a phone number ${channel} can reach. Write it with its country code, like +234 801 234 5678.`,
  ChannelAddressTaken: () => 'That number is already connected to someone. Use a different number.',
  ChannelLimitReached: (channel) => `No more people can be connected to ${channel} right now.`,
  ChannelProviderFailed: (channel) =>
    `${channel} could not be reached, so nothing was changed. Try again.`,
} satisfies Record<ChannelFailure['_tag'], (channel: Channel) => string>

const isChannelFailure = Schema.is(ChannelFailure)

/** Everything a connect or a disconnect can end in: the channel's own refusals, or the product's. */
export type TextingFailure = ChannelFailure | ProductFailure

/** What is said when the call never got an answer at all. The same promise holds. */
export const textingUnreached = 'Vivid could not be reached, so nothing was changed. Try again.'

/**
 * The one sentence a refused connect or disconnect is said in. A channel's own failure gets its
 * own words; anything else (the socket dropped, the session ended) is Vivid not being reached,
 * and the same promise holds: nothing was changed.
 */
export const textingRefusal = (failure: TextingFailure): string =>
  isChannelFailure(failure) ? SAID[failure._tag](failure.channel) : textingUnreached

/** The app a channel's messages are written in, as the Person knows it on their phone. */
export const MESSENGER = {
  iMessage: 'Messages',
  WhatsApp: 'WhatsApp',
} satisfies Record<Channel, string>

/**
 * How a device writes the body into an `sms:` link. RFC 5724 puts it after `?`; Apple's Messages
 * (iPhone, iPad and Mac) reads it only after `&`, and Android reads the RFC's form. A link in the
 * wrong form still opens the conversation, but with the code missing, which is the part the Person
 * would then have to type.
 */
export type Composer = 'apple' | 'standard'

/**
 * The link that opens a channel's own app on a conversation with `textTo`, with `body` already
 * written when there is one. A code is sent as the body so confirming is one press and "Send";
 * a connected channel has nothing to pre-write and only opens the conversation.
 */
export const messageLink = (
  channel: Channel,
  composer: Composer,
  textTo: string,
  body: Option.Option<string>,
): string => {
  const written = Option.map(body, encodeURIComponent)
  if (channel === 'WhatsApp') {
    // WhatsApp's own link form takes the number as bare digits, without the plus.
    const number = textTo.replaceAll(/\D/gu, '')
    return Option.match(written, {
      onNone: () => `https://wa.me/${number}`,
      onSome: (text) => `https://wa.me/${number}?text=${text}`,
    })
  }
  return Option.match(written, {
    onNone: () => `sms:${textTo}`,
    onSome: (text) => `sms:${textTo}${composer === 'apple' ? '&' : '?'}body=${text}`,
  })
}

/**
 * Whether a code has ended, as a store a screen reads with `useSyncExternalStore`.
 *
 * A screen must say "this code has ended" the moment it does, but must not repaint while it
 * waits. So nothing ticks: one timer is set for the moment the code ends, and only while
 * something is reading. A code that has already ended sets no timer at all.
 */
export const codeEnding = (expiresAt: number) => ({
  subscribe: (listener: () => void) => {
    const left = expiresAt - Date.now()
    if (left <= 0) return () => undefined
    const timer = setTimeout(listener, left)
    return () => clearTimeout(timer)
  },
  read: () => Date.now() >= expiresAt,
})
