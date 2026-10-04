import { ChannelStanding, type ChannelLink } from '@vivid/contracts'
import type { TextingActs } from '@vivid/state'
import { Option, Schema } from 'effect'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
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

  it('shows a connected channel with both numbers, a way to write and a way out', () => {
    const html = drawn(ChannelStanding.cases.Connected.make({ address: mine, textTo, since: 0 }))
    expect(html).toContain('+14155550100')
    expect(html).toContain('+2348012345678')
    expect(html).toContain('href="sms:+14155550100"')
    expect(html).toContain('Disconnect')
  })
})
