import {
  ChannelAddressInvalid,
  ChannelAddressTaken,
  ChannelLimitReached,
  ChannelProviderFailed,
  ChannelStanding,
  ChannelUnavailable,
  NotFound,
} from '@vivid/contracts'
import { Option, Schema } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { codeEnding, messageLink, channelWords, textingRefusal, typedAddress } from './texting.js'

const address = Schema.decodeSync(ChannelStanding.cases.Connected.fields.address)

describe('the number a Person writes', () => {
  it('is sent without the spacing it was written with', () => {
    expect(typedAddress(' +234 (801) 234-56.78 ')).toBe('+2348012345678')
  })
})

describe('what a refusal says', () => {
  it('names the channel and never the failure', () => {
    const said = [
      new ChannelUnavailable({ channel: 'WhatsApp' }),
      new ChannelAddressInvalid({ channel: 'iMessage' }),
      new ChannelAddressTaken({ channel: 'iMessage' }),
      new ChannelLimitReached({ channel: 'iMessage' }),
      new ChannelProviderFailed({ channel: 'iMessage' }),
    ].map(textingRefusal)
    expect(said).toEqual([
      'WhatsApp is not set up on this Vivid yet.',
      'That is not a phone number iMessage can reach. Write it with its country code, like +234 801 234 5678.',
      'That number is already connected to someone. Use a different number.',
      'No more people can be connected to iMessage right now.',
      'iMessage could not be reached, so nothing was changed. Try again.',
    ])
    for (const sentence of said) expect(sentence).not.toMatch(/Channel[A-Z]/u)
  })

  it('is Vivid not being reached for anything that is not the channel’s own failure', () => {
    expect(textingRefusal(new NotFound({ message: 'gone' }))).toBe(
      'Vivid could not be reached, so nothing was changed. Try again.',
    )
  })
})

describe('the link that opens the messaging app', () => {
  const code = Option.some('VIVID 4821')

  it('writes the code after & for Apple’s Messages and after ? everywhere else', () => {
    expect(messageLink('iMessage', 'apple', '+14155550100', code)).toBe(
      'sms:+14155550100&body=VIVID%204821',
    )
    expect(messageLink('iMessage', 'standard', '+14155550100', code)).toBe(
      'sms:+14155550100?body=VIVID%204821',
    )
  })

  it('only opens the conversation when there is nothing to write', () => {
    expect(messageLink('iMessage', 'apple', '+14155550100', Option.none())).toBe('sms:+14155550100')
  })

  it('addresses WhatsApp by bare digits', () => {
    expect(messageLink('WhatsApp', 'apple', '+14155550100', code)).toBe(
      'https://wa.me/14155550100?text=VIVID%204821',
    )
    expect(messageLink('WhatsApp', 'standard', '+14155550100', Option.none())).toBe(
      'https://wa.me/14155550100',
    )
  })
})

describe('where a channel stands, in a word', () => {
  it('has words for every standing', () => {
    const mine = address('+2348012345678')
    const textTo = address('+14155550100')
    expect(
      [
        ChannelStanding.cases.Unavailable.make({}),
        ChannelStanding.cases.NotConnected.make({}),
        ChannelStanding.cases.Confirming.make({
          address: mine,
          textTo,
          code: 'VIVID 4821',
          expiresAt: 0,
        }),
        ChannelStanding.cases.Connected.make({ address: mine, textTo, since: 0 }),
      ].map(channelWords),
    ).toEqual(['Not set up', 'Not connected', 'Waiting for your text', 'Connected'])
  })
})

describe('a code ending', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('tells its reader once, at the moment it ends', () => {
    vi.useFakeTimers({ now: 1_000 })
    const ending = codeEnding(61_000)
    const heard = vi.fn<() => void>()
    ending.subscribe(heard)
    expect(ending.read()).toBe(false)
    vi.advanceTimersByTime(59_999)
    expect(heard).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(heard).toHaveBeenCalledTimes(1)
    expect(ending.read()).toBe(true)
  })

  it('sets no timer for a code that has already ended, or once nobody reads', () => {
    vi.useFakeTimers({ now: 100_000 })
    codeEnding(61_000).subscribe(() => undefined)
    expect(vi.getTimerCount()).toBe(0)
    const stop = codeEnding(200_000).subscribe(() => undefined)
    expect(vi.getTimerCount()).toBe(1)
    stop()
    expect(vi.getTimerCount()).toBe(0)
  })
})
