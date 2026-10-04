import { ChannelStanding, type ChannelLink } from '@vivid/contracts'
import { Option, Schema } from 'effect'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TextingActs } from '../../data/texting'
import { TextingChannels } from './Channel'

const address = Schema.decodeSync(ChannelStanding.cases.Connected.fields.address)
const mine = address('+2348012345678')
const textTo = address('+14155550100')

/** Nothing is pressed in a static render; the control only needs something to hold. */
const acts: TextingActs = {
  connect: () => Promise.resolve(Option.none()),
  disconnect: () => Promise.resolve(Option.none()),
}

const drawn = (standing: ChannelStanding) => {
  const links: ReadonlyArray<ChannelLink> = [{ channel: 'iMessage', standing }]
  return renderToStaticMarkup(createElement(TextingChannels, { links, acts }))
}

describe('the control for texting Vivid', () => {
  it('shows a channel this Vivid is not set up for, with nothing to press or fill in', () => {
    const html = drawn(ChannelStanding.cases.Unavailable.make({}))
    expect(html).toContain('This Vivid is not set up for iMessage yet.')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Connect<\/button>/u)
    expect(html).not.toContain('<input')
  })

  it('asks for the Person’s own number as a phone number', () => {
    const html = drawn(ChannelStanding.cases.NotConnected.make({}))
    expect(html).toMatch(/<input[^>]*type="tel"/u)
    expect(html).toMatch(/<input[^>]*autoComplete="tel"/iu)
    expect(html).toContain('Your phone number for iMessage')
  })

  it('offers the code to copy and to send while it still works', () => {
    const html = drawn(
      ChannelStanding.cases.Confirming.make({
        address: mine,
        textTo,
        code: 'VIVID 4821',
        expiresAt: Date.now() + 600_000,
      }),
    )
    expect(html).toContain('VIVID 4821')
    expect(html).toContain('Copy: This code')
    expect(html).toMatch(/href="sms:\+14155550100[&?](amp;)?body=VIVID%204821"/u)
    expect(html).toContain('The code works until')
  })

  it('takes an ended code out of reach and leads with getting a new one', () => {
    const html = drawn(
      ChannelStanding.cases.Confirming.make({
        address: mine,
        textTo,
        code: 'VIVID 4821',
        expiresAt: Date.now() - 1,
      }),
    )
    expect(html).toContain('This code ended at')
    expect(html).not.toContain('Copy: This code')
    expect(html).not.toContain('href="sms:')
    // The number to text is still good; only the code is spent.
    expect(html).toContain('Copy: Text this number')
    expect(html).toContain('Get a new code')
  })
})

describe('a connected channel', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** The control as the browser on one kind of device draws it. */
  const on = (userAgent: string, channel: ChannelLink['channel'] = 'iMessage') => {
    vi.stubGlobal('navigator', { userAgent })
    const standing = ChannelStanding.cases.Connected.make({ address: mine, textTo, since: 0 })
    return renderToStaticMarkup(
      createElement(TextingChannels, { links: [{ channel, standing }], acts }),
    )
  }
  const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.5 Safari/605.1.15'
  const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/140.0.0.0 Mobile Safari/537.36'
  const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0 Safari/537.36'

  it('shows the number to text with its copy, the Person’s own number and a way out', () => {
    const html = on(MAC)
    expect(html).toContain('+14155550100')
    expect(html).toContain('Copy: Vivid’s number')
    expect(html).toContain('+2348012345678')
    expect(html).toMatch(/<button[^>]*>Disconnect<\/button>/u)
  })

  it('opens Messages on a greeting, in the form the device reads', () => {
    expect(on(MAC)).toMatch(
      /<a href="sms:\+14155550100&amp;body=Hi%20Vivid"[^>]*>Open Messages<\/a>/u,
    )
    expect(on(ANDROID)).toMatch(
      /<a href="sms:\+14155550100\?body=Hi%20Vivid"[^>]*>Open Messages<\/a>/u,
    )
  })

  it('offers no button that would do nothing on a desktop without Messages, and says what to do', () => {
    const html = on(WINDOWS)
    expect(html).not.toContain('href="sms:')
    expect(html).not.toContain('Open Messages')
    expect(html).toContain('Text this number from your phone.')
    expect(html).toContain('Copy: Vivid’s number')
  })

  it('opens WhatsApp from any browser', () => {
    expect(on(WINDOWS, 'WhatsApp')).toMatch(
      /<a href="https:\/\/wa\.me\/14155550100\?text=Hi%20Vivid"[^>]*>Open WhatsApp<\/a>/u,
    )
  })
})
