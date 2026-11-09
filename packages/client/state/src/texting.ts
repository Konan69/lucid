import { VividRpcClient } from '@vivid/client-runtime'
import {
  ChannelFailure,
  ChannelStanding,
  type Channel,
  type ChannelLink,
  type ChannelListResponse,
} from '@vivid/contracts'
import { Effect, Option, Result, Schema } from 'effect'
import type { LiveQuery, ProductFailure } from './live.js'

/**
 * Texting Vivid from a messaging app, as every client says and does it.
 *
 * On a phone channel a Person gives their own number, texts a short code from that phone to the
 * number they are shown, and from then on messages from that phone are theirs. On Discord there
 * is no number to give: they press Connect and send the code to the Vivid bot, and the account it
 * came from is theirs. The web app and the phone app draw this differently, but what each standing
 * is called, what a refusal says and what link opens the messaging app already addressed are the
 * same everywhere, so they are decided here once.
 */

/**
 * How a Person is known on each channel: by the phone number they give, or by the account the
 * code is sent from (Discord), which they never type. It decides whether there is a number to ask
 * for, and whether there is a number to show once connected.
 */
export const KNOWN_BY = {
  iMessage: 'number',
  WhatsApp: 'number',
  Discord: 'account',
} satisfies Record<Channel, 'number' | 'account'>

/**
 * A number as it is sent: without the spaces, brackets, dots and hyphens people write a phone
 * number with so it can be read. The server decides whether what is left is a number it can
 * reach; this only stops "+234 801 234 5678" being refused for its spacing.
 */
export const typedAddress = (written: string) => written.replaceAll(/[\s().-]/gu, '')

/**
 * Gives the Person's own number to a channel, or nothing on a channel that learns the account from
 * the code (`KNOWN_BY`). The answer is where the channel now stands: `Confirming` or `Awaiting`,
 * with the code to send. Asking again the same way while the code is out is how a new one is
 * asked for.
 */
export const connectChannel = Effect.fn('Texting.connect')(function* (
  channel: Channel,
  written: Option.Option<string>,
) {
  const client = yield* VividRpcClient
  const { link } = yield* client.ConnectChannel(
    Option.match(written, {
      onNone: () => ({ channel }),
      onSome: (number) => ({ channel, address: typedAddress(number) }),
    }),
  )
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
    Unavailable: () => 'Not available yet',
    NotConnected: () => 'Not connected',
    Confirming: () => 'Waiting for your text',
    Awaiting: () => 'Waiting for your message',
    Connected: () => 'Connected',
  })

/**
 * What each refusal is in plain words. Keyed by the contract's own failures, so a failure added
 * there without a sentence here does not typecheck. A channel where no number is typed (Discord)
 * is never told about one.
 */
const SAID = {
  ChannelUnavailable: (channel) => `Vivid cannot text on ${channel} yet.`,
  ChannelAddressInvalid: (channel) =>
    KNOWN_BY[channel] === 'number'
      ? `That is not a phone number ${channel} can reach. Write it with its country code, like +234 801 234 5678.`
      : `Vivid could not start connecting ${channel}. Try again.`,
  ChannelAddressTaken: (channel) =>
    KNOWN_BY[channel] === 'number'
      ? 'That number is already connected to someone. Use a different number.'
      : `That ${channel} account is already connected to someone.`,
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

/**
 * What one connect or disconnect came to, for the client whose live list is `channels`.
 *
 * These calls are not a `change`: a channel's refusals are its own (`ChannelFailure`), and `change`
 * only carries the product's general ones. So the call is run as a program and its answer is laid
 * over the live list here. The server has already accepted it, so the expectation is settled the
 * moment it is made: it holds the answer on screen until the watch sends its own next result.
 */
export const textingSettled =
  (channels: LiveQuery<ChannelListResponse>) =>
  (result: Result.Result<ChannelLink, TextingFailure>): Option.Option<string> => {
    if (Result.isFailure(result)) return Option.some(textingRefusal(result.failure))
    const link = result.success
    channels.expect((current) => withLink(current, link))(true)
    return Option.none()
  }

/** The app a channel's messages are written in, as the Person knows it on their phone. */
export const MESSENGER = {
  iMessage: 'Messages',
  WhatsApp: 'WhatsApp',
  Discord: 'Discord',
} satisfies Record<Channel, string>

/**
 * How a device writes the body into an `sms:` link. RFC 5724 puts it after `?`; Apple's Messages
 * (iPhone, iPad and Mac) reads it only after `&`, and Android reads the RFC's form. A link in the
 * wrong form still opens the conversation, but with the code missing, which is the part the Person
 * would then have to type.
 */
export type Composer = 'apple' | 'standard'

/**
 * Which `sms:` form a browser's device reads, from its user agent, or nothing when the device has
 * no app that takes an `sms:` link at all.
 *
 * A Mac, an iPhone and an iPad open Messages (an iPad asking for the desktop site calls itself a
 * Mac, which is the same answer). An Android phone opens its own messaging app; its user agent
 * also says "Linux", so it is asked about first. Windows, Linux and ChromeOS desktops are nothing:
 * pressing an `sms:` link there does nothing, or asks which app to buy. A screen must not offer a
 * button that does that, so it is told here, once, that there is none to offer.
 *
 * The user agent is what the web app already reads to tell a Mac from the rest (`data/keys.ts`).
 * `navigator.userAgentData` would say it more plainly, but Safari and Firefox do not have it, and
 * Safari is the browser that matters most for Messages.
 */
export const composerOf = (userAgent: string): Option.Option<Composer> => {
  if (/Android/u.test(userAgent)) return Option.some('standard')
  if (/Mac|iPhone|iPad|iPod/u.test(userAgent)) return Option.some('apple')
  return Option.none()
}

/**
 * What a first message to Vivid says, already written when a connected channel's app is opened,
 * so the first text is one press on "Send". It is a greeting and nothing more: the Person has not
 * asked for anything yet, and Vivid answers a greeting by saying what it can do.
 */
export const FIRST_TEXT = 'Hi Vivid'

/**
 * The link that opens a channel's own app on a conversation with `textTo`, with `body` already
 * written when there is one. A code is sent as the body so confirming is one press and "Send";
 * a connected channel is opened on `FIRST_TEXT` (`textLink`). With no body the link only opens
 * the conversation.
 *
 * Discord's link cannot carry a body: it opens the Vivid bot's profile, where "Message" starts the
 * conversation, and the code is pasted from the screen.
 */
export const messageLink = (
  channel: Channel,
  composer: Composer,
  textTo: string,
  body: Option.Option<string>,
): string => {
  const written = Option.map(body, encodeURIComponent)
  if (channel === 'Discord') return `https://discord.com/users/${textTo.replace(/^discord:/u, '')}`
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
 * The link that opens a connected channel's app on a first message to Vivid, when this device can
 * be expected to open it; nothing when it cannot, so the screen shows the number to carry to the
 * phone and no button that would do nothing.
 *
 * WhatsApp's and Discord's links are web pages that every browser opens (and that hand over to the
 * app where there is one), so they are always there. An `sms:` link needs a device that reads one
 * (`composerOf`).
 */
export const textLink = (
  channel: Channel,
  device: Option.Option<Composer>,
  textTo: string,
): Option.Option<string> => {
  const body = Option.some(FIRST_TEXT)
  if (channel !== 'iMessage') return Option.some(messageLink(channel, 'standard', textTo, body))
  return Option.map(device, (composer) => messageLink(channel, composer, textTo, body))
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
