import {
  ChannelAddressInvalid,
  ChannelAddressTaken,
  ChannelLimitReached,
  ChannelProviderFailed,
  ChannelStanding,
  ChannelUnavailable,
  NotFound,
  type ChannelListResponse,
} from '@vivid/contracts'
import { Option, Result, Schema } from 'effect'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LiveQuery, LiveResult } from './live.js'
import {
  codeEnding,
  composerOf,
  FIRST_TEXT,
  messageLink,
  channelWords,
  textingRefusal,
  textingSettled,
  textLink,
  typedAddress,
} from './texting.js'

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
      'Vivid cannot text on WhatsApp yet.',
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

/** What real browsers call themselves, one for each kind of device a Person opens Vivid on. */
const AGENT = {
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  android:
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  windows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  linux:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  chromebook:
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
}

describe('which devices open a text', () => {
  it('reads Apple’s form on an iPhone and a Mac, and the standard one on Android', () => {
    expect(composerOf(AGENT.iphone)).toEqual(Option.some('apple'))
    expect(composerOf(AGENT.mac)).toEqual(Option.some('apple'))
    // Android's user agent says "Linux" too; it must not be taken for a desktop.
    expect(composerOf(AGENT.android)).toEqual(Option.some('standard'))
  })

  it('has nothing to open a text with on a Windows, Linux or ChromeOS desktop', () => {
    expect([AGENT.windows, AGENT.linux, AGENT.chromebook].map(composerOf)).toEqual([
      Option.none(),
      Option.none(),
      Option.none(),
    ])
  })
})

describe('the link that opens a first message to Vivid', () => {
  const to = '+14155550100'

  it('is written in the form each device reads: iOS and macOS, Android, the phone app', () => {
    expect(textLink('iMessage', composerOf(AGENT.iphone), to)).toEqual(
      Option.some('sms:+14155550100&body=Hi%20Vivid'),
    )
    expect(textLink('iMessage', composerOf(AGENT.mac), to)).toEqual(
      Option.some('sms:+14155550100&body=Hi%20Vivid'),
    )
    expect(textLink('iMessage', composerOf(AGENT.android), to)).toEqual(
      Option.some('sms:+14155550100?body=Hi%20Vivid'),
    )
    // The phone app knows its platform and builds the same links without a user agent.
    expect(messageLink('iMessage', 'apple', to, Option.some(FIRST_TEXT))).toBe(
      'sms:+14155550100&body=Hi%20Vivid',
    )
    expect(messageLink('iMessage', 'standard', to, Option.some(FIRST_TEXT))).toBe(
      'sms:+14155550100?body=Hi%20Vivid',
    )
  })

  it('is the bare conversation on every device when there is no body', () => {
    expect(messageLink('iMessage', 'apple', to, Option.none())).toBe('sms:+14155550100')
    expect(messageLink('iMessage', 'standard', to, Option.none())).toBe('sms:+14155550100')
  })

  it('is not offered in a desktop browser that has nothing to open a text with', () => {
    expect(textLink('iMessage', composerOf(AGENT.windows), to)).toEqual(Option.none())
    expect(textLink('iMessage', composerOf(AGENT.linux), to)).toEqual(Option.none())
  })

  it('is always there for WhatsApp, whose link is a web page any browser opens', () => {
    expect(textLink('WhatsApp', composerOf(AGENT.windows), to)).toEqual(
      Option.some('https://wa.me/14155550100?text=Hi%20Vivid'),
    )
    expect(textLink('WhatsApp', composerOf(AGENT.iphone), to)).toEqual(
      Option.some('https://wa.me/14155550100?text=Hi%20Vivid'),
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
    ).toEqual(['Not available yet', 'Not connected', 'Waiting for your text', 'Connected'])
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

describe('what a connect or a disconnect came to', () => {
  const before: ChannelListResponse = {
    channels: [
      { channel: 'iMessage', standing: ChannelStanding.cases.NotConnected.make({}) },
      { channel: 'WhatsApp', standing: ChannelStanding.cases.Unavailable.make({}) },
    ],
  }

  /** A live list that records what was laid over it and how each expectation was settled. */
  const listed = () => {
    const shown: Array<ChannelListResponse> = []
    const settledAs: Array<boolean> = []
    const channels: LiveQuery<ChannelListResponse> = {
      atom: Atom.make<LiveResult<ChannelListResponse>>(AsyncResult.success(before)),
      expect: (change) => {
        shown.push(change(before))
        return (accepted) => {
          settledAs.push(accepted)
        }
      },
    }
    return { channels, shown, settledAs }
  }

  it('lays the answer over that channel only, as accepted, and says nothing', () => {
    const { channels, shown, settledAs } = listed()
    const standing = ChannelStanding.cases.Confirming.make({
      address: address('+2348012345678'),
      textTo: address('+14155550100'),
      code: 'VIVID 4821',
      expiresAt: 61_000,
    })
    const said = textingSettled(channels)(Result.succeed({ channel: 'iMessage', standing }))
    expect(Option.isNone(said)).toBe(true)
    expect(shown).toEqual([{ channels: [{ channel: 'iMessage', standing }, before.channels[1]] }])
    expect(settledAs).toEqual([true])
  })

  it('says the refusal and leaves the list as it was', () => {
    const { channels, shown } = listed()
    const said = textingSettled(channels)(
      Result.fail(new ChannelAddressTaken({ channel: 'iMessage' })),
    )
    expect(said).toEqual(
      Option.some('That number is already connected to someone. Use a different number.'),
    )
    expect(shown).toEqual([])
  })
})
