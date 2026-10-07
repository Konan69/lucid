import * as NodeDns from 'node:dns'
import * as NodeNet from 'node:net'
import ipaddr from 'ipaddr.js'
import { Context, Effect, Layer, Schema } from 'effect'

/** Parsing, DNS and transport failures have different public refusals without leaking driver text. */
export class PageFailure extends Schema.TaggedError<PageFailure>()(
  'PageFailure',
  {
    reason: Schema.Literals([
      'not a public web address',
      'could not be reached',
      'not a readable page',
    ] as const),
  },
  { title: 'Public page refusal' },
) {}

export interface PageAddress {
  readonly address: string
  readonly family: 4 | 6
}
export interface PageResolverService {
  readonly resolve: (hostname: string) => Effect.Effect<readonly PageAddress[], PageFailure>
}

/** DNS is checked anew for every redirect. The resulting addresses, not the hostname, authorize I/O. */
export class PageResolver extends Context.Service<PageResolver, PageResolverService>()(
  'vivid/PageResolver',
) {}

/** Only global unicast destinations are accepted; IPv6 is further restricted to its allocated /3. */
export function publicAddress(address: string) {
  if (!ipaddr.isValid(address)) return false
  const parsed = ipaddr.parse(address)
  if (parsed.range() !== 'unicast') return false
  const first = parsed.toByteArray()[0]
  if (parsed.kind() === 'ipv6') {
    const octets = parsed.toByteArray()
    const second = octets[1]
    const third = octets[2]
    // IANA's 2024 documentation allocation is newer than ipaddr.js 2.2's tables. 3ffe was returned.
    if (
      first === 0x3f &&
      (second === 0xfe || (second === 0xff && third !== undefined && (third & 0xf0) === 0))
    )
      return false
    return first !== undefined && (first & 0xe0) === 0x20
  }
  return true
}

/** URL canonicalization also exposes disguised integer/octal loopback addresses before DNS. */
export const pageUrl = Effect.fn('Code.pageUrl')((address: string) =>
  Effect.try({
    try: () => new URL(address),
    catch: () => new PageFailure({ reason: 'not a public web address' }),
  }).pipe(
    Effect.flatMap((url) =>
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.username === '' &&
      url.password === ''
        ? Effect.succeed(url)
        : Effect.fail(new PageFailure({ reason: 'not a public web address' })),
    ),
  ),
)

/** A mixed public/private DNS answer is refused in full; picking just its public record is unsafe. */
export const resolvePage = Effect.fn('Code.resolvePage')(function* (url: URL) {
  const resolver = yield* PageResolver
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const family = NodeNet.isIP(hostname)
  const addresses: readonly PageAddress[] =
    family === 4 || family === 6
      ? [{ address: hostname, family }]
      : yield* resolver.resolve(hostname)
  if (addresses.length === 0) return yield* new PageFailure({ reason: 'could not be reached' })
  if (!addresses.every((item) => publicAddress(item.address)))
    return yield* new PageFailure({ reason: 'not a public web address' })
  const selected = addresses[0]
  if (selected === undefined) return yield* new PageFailure({ reason: 'could not be reached' })
  return selected
})

/** Ignore unexpected DNS families; only parsed IPv4/IPv6 records can authorize a socket. */
function records(addresses: readonly NodeDns.LookupAddress[]): PageAddress[] {
  return addresses.flatMap((item) =>
    item.family === 4 || item.family === 6 ? [{ address: item.address, family: item.family }] : [],
  )
}

/** lookup(all) is cancellable at the Effect boundary even though libc DNS itself is not cancellable. */
const lookup = Effect.fn('Code.lookupPage')((hostname: string) =>
  Effect.callback<readonly PageAddress[], PageFailure>((resume) => {
    NodeDns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error !== null)
        return resume(Effect.fail(new PageFailure({ reason: 'could not be reached' })))
      resume(Effect.succeed(records(addresses)))
    })
  }),
)

export const pageResolverLayer = Layer.succeed(PageResolver, PageResolver.of({ resolve: lookup }))
