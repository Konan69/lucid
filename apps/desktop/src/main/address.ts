import * as Schema from 'effect/Schema'
import { AddressRefusal } from '../shared/pages.ts'

/** Loopback aliases must not turn the Browser into a local service launcher. */
function isLocalhost(hostname: string): boolean {
  const host = hostname.replace(/\.$/u, '')
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '[::1]' ||
    host.startsWith('[::ffff:7f') ||
    host.startsWith('127.') ||
    host === '0.0.0.0' ||
    host === '[::]'
  )
}

/** Return a precise refusal for a URL, including canonicalized loopback IPv4 forms. */
function refusalFor(value: string): AddressRefusal | false {
  if (!URL.canParse(value)) return 'malformed'
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'scheme'
  if (isLocalhost(url.hostname)) return 'localhost'
  if (url.username !== '' || url.password !== '') return 'credentials'
  return false
}

/** The same policy guards typed navigation, links, redirects, popups, and guest frame loads. */
export const PageAddress = Schema.String.check(
  Schema.makeFilter((value) => refusalFor(value) === false, {
    message: 'Expected a non-local HTTP(S) page address without credentials',
  }),
).pipe(Schema.brand('DesktopPageAddress'))
export type PageAddress = typeof PageAddress.Type

/** This policy is reusable at synchronous Electron callbacks without compiling another decoder. */
export const isPageAddress = Schema.is(PageAddress)

/** Search and navigation are explicit decisions; unsafe URLs never become search queries. */
export const AddressDecision = Schema.TaggedUnion({
  Navigate: { address: PageAddress },
  Search: { address: PageAddress },
  Refused: { reason: AddressRefusal },
})
export type AddressDecision = typeof AddressDecision.Type

/** Bare hosts need a dot, loopback name, or IPv6 brackets; ordinary words stay search terms. */
function looksLikeHost(value: string): boolean {
  const host = value.split(/[/?#]/u)[0]
  return (
    host !== undefined &&
    (/^[^\s:]+\.[^\s:]+(?::\d+)?$/u.test(host) ||
      /^localhost(?::\d+)?$/iu.test(host) ||
      /^\[[\da-f:]+\](?::\d+)?$/iu.test(host))
  )
}

/**
 * Resolve trimmed address-bar text deterministically. Missing schemes use HTTPS; text containing
 * spaces becomes a DuckDuckGo search. Explicit schemes are checked before search to refuse code,
 * files and custom protocols. A bare hostname with a port is not mistaken for a custom scheme.
 */
export function decideAddress(input: string): AddressDecision {
  const text = input.trim()
  if (text.length === 0) return AddressDecision.cases.Refused.make({ reason: 'empty' })
  const host = looksLikeHost(text)
  const scheme = /^[a-z][a-z\d+.-]*:/iu.test(text) && !host
  if (!scheme && (!host || /\s/u.test(text))) {
    const url = new URL('https://duckduckgo.com/')
    url.searchParams.set('q', text)
    return AddressDecision.cases.Search.make({ address: PageAddress.make(url.href) })
  }
  const candidate = scheme ? text : `https://${text}`
  const reason = refusalFor(candidate)
  if (reason !== false) return AddressDecision.cases.Refused.make({ reason })
  return AddressDecision.cases.Navigate.make({
    address: PageAddress.make(new URL(candidate).href),
  })
}
