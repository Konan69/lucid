import { describe, expect, it } from '@effect/vitest'
import { AddressDecision, decideAddress, isPageAddress } from './address.ts'

describe('Browser address bar', () => {
  it('normalizes addresses with and without a scheme, preserving paths and ports', () => {
    for (const [input, address] of [
      ['https://example.com/path?q=test#here', 'https://example.com/path?q=test#here'],
      ['http://example.com', 'http://example.com/'],
      ['example.com/path', 'https://example.com/path'],
      ['example.com:8443/path', 'https://example.com:8443/path'],
      ['  EXAMPLE.com  ', 'https://example.com/'],
      ['8.8.8.8', 'https://8.8.8.8/'],
      ['[2001:4860::1]:8443', 'https://[2001:4860::1]:8443/'],
    ] as const) {
      const decision = decideAddress(input)
      expect(AddressDecision.guards.Navigate(decision)).toBe(true)
      if (AddressDecision.guards.Navigate(decision)) expect(decision.address).toBe(address)
    }
  })

  it('turns ordinary text and spaces into an encoded web search', () => {
    for (const input of ['vivid', '  vivid browser  ', 'example.com/some path', 'cats & dogs']) {
      const decision = decideAddress(input)
      expect(AddressDecision.guards.Search(decision)).toBe(true)
      if (AddressDecision.guards.Search(decision)) {
        const url = new URL(decision.address)
        expect(url.origin).toBe('https://duckduckgo.com')
        expect(url.searchParams.get('q')).toBe(input.trim())
      }
    }
  })

  it('refuses localhost and canonical loopback aliases instead of navigating or searching', () => {
    for (const input of [
      'localhost',
      'localhost:3000/path',
      'LOCALHOST:3000',
      'https://localhost./',
      'https://nested.localhost',
      '127.0.0.1:3000',
      'https://127.12.0.9',
      'http://2130706433',
      'http://0x7f000001',
      'http://[::1]',
      'http://[::ffff:127.0.0.1]',
    ])
      expect(decideAddress(input)).toEqual(
        AddressDecision.cases.Refused.make({ reason: 'localhost' }),
      )
  })

  it('refuses explicit executable, file, custom, credential-bearing, and malformed URLs', () => {
    for (const input of [
      'javascript:alert(1)',
      'file:///secret',
      'mailto:person@example.com',
      'data:text/html,hello',
      'vivid://thread/123',
      'about:blank',
      'ftp://example.com',
    ])
      expect(decideAddress(input)).toEqual(AddressDecision.cases.Refused.make({ reason: 'scheme' }))
    expect(decideAddress('https://person:secret@example.com')).toEqual(
      AddressDecision.cases.Refused.make({ reason: 'credentials' }),
    )
    for (const input of ['https://', 'https://example.com:99999', 'example.com:99999'])
      expect(decideAddress(input)).toEqual(
        AddressDecision.cases.Refused.make({ reason: 'malformed' }),
      )
    expect(decideAddress('   ')).toEqual(AddressDecision.cases.Refused.make({ reason: 'empty' }))
  })

  it('applies the same destination policy to page links, popups and redirects', () => {
    expect(isPageAddress('https://example.com/path')).toBe(true)
    expect(isPageAddress('http://example.com/path')).toBe(true)
    for (const address of [
      'https://localhost',
      'http://127.0.0.1',
      'https://person:secret@example.com',
      'file:///secret',
      'about:blank',
      'data:text/html,hello',
      'javascript:alert(1)',
      'vivid://thread/123',
      'example.com',
    ])
      expect(isPageAddress(address)).toBe(false)
  })
})
