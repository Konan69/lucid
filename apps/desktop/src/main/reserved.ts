import * as NodeNet from 'node:net'
import * as Option from 'effect/Option'

/**
 * Addresses the Computer's browsing is never carried to through a Person's computer.
 *
 * Egress dials from inside the Person's own network (`egress.ts`). A page on the Computer could
 * otherwise name the Person's router, a printer, or a service on this machine and have this app
 * connect to it. So a target must be on the public internet: not this machine, not the networks
 * it sits on, and not a range no public host can have.
 *
 * The IPv4 ranges are the reference's own (`ea2-window-lifecycle.ts`: `isBlockedV4`,
 * `isSharedCgnat`, `isReservedV4`), with two made wider: the reference refuses `0.0.0.0` alone
 * and this refuses all of `0.0.0.0/8`, which is "this network" and is equally never a public
 * host, and the retired 6to4 relay range is refused too.
 *
 * For IPv6 this goes beyond the reference, on purpose. The reference's `isBlockedV6` lists what
 * it refuses (`::`, `::1`, `fc00::/7`, `fe80::/10`, `ff00::/8`) and lets everything else through.
 * A review showed two local ranges that list misses: deprecated site-local `fec0::/10`
 * (RFC 3879), which an old network may still route inside itself, and the local-use NAT64 prefix
 * `64:ff9b:1::/48` (RFC 8215), which a network uses to reach its own IPv4 hosts. A list of what
 * to refuse fails open: whatever it does not name is dialled. So the rule here is the other way
 * round: an IPv6 address is dialled only when it is one a public host can have. The whole of
 * public IPv6 is `2000::/3` (IANA's IPv6 address space registry gives nothing else out as global
 * unicast), so anything outside it is refused without being named, the two ranges above and
 * whatever is set aside next included. Inside it, the IANA special-purpose registry's ranges
 * that are not public hosts are refused by name (`PROTOCOL_V6`). The one way through outside
 * `2000::/3` is an IPv4 address written inside an IPv6 one (`embedded`), which is judged as that
 * IPv4 address.
 */
const RESERVED = new NodeNet.BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  // Private networks.
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  // Carrier-grade NAT: the provider's network, shared with its other customers.
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  // Protocol assignments, the three documentation ranges and benchmarking.
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['198.18.0.0', 15],
  // The 6to4 relay anycast range, retired by RFC 7526: nothing public answers there.
  ['192.88.99.0', 24],
  // Multicast, then everything reserved above it, the broadcast address included.
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  RESERVED.addSubnet(network, prefix, 'ipv4')

/** All of public IPv6. An address outside it is not one a site on the internet can have. */
const PUBLIC_V6 = new NodeNet.BlockList()
PUBLIC_V6.addSubnet('2000::', 3, 'ipv6')

/**
 * Inside public IPv6, what is still not a public host (IANA IPv6 special-purpose registry):
 *
 * - `2001::/23`, the IETF's protocol block: Teredo (`2001::/32`, which wraps an IPv4 address a
 *   page could choose), benchmarking, ORCHID and the rest. Its few addresses that are reachable
 *   from anywhere are anycast services for networks, not sites, so the block is refused whole.
 * - `2001:db8::/32` and `3fff::/20`: documentation.
 * - `2002::/16`, 6to4: every address wraps an IPv4 one and is delivered to it by whichever relay
 *   is near, so `2002:c0a8:0101::` is a way to name `192.168.1.1`. The scheme is retired
 *   (RFC 7526) and no site is reachable only through it, so it is refused whole, not unwrapped.
 */
const PROTOCOL_V6 = new NodeNet.BlockList()
for (const [network, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const)
  PROTOCOL_V6.addSubnet(network, prefix, 'ipv6')

/**
 * An IPv6 address as its eight 16-bit groups, or nothing when it is not one. A zone (`%eth0`) is
 * dropped and a dotted IPv4 tail is read as two groups (the reference's `expandV6`).
 */
const groups = (address: string): Option.Option<ReadonlyArray<number>> => {
  const [bare = ''] = address.split('%')
  if (!NodeNet.isIPv6(bare)) return Option.none()
  const dotted = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/u.exec(bare)
  const tail =
    dotted === null
      ? []
      : [(Number(dotted[2]) << 8) | Number(dotted[3]), (Number(dotted[4]) << 8) | Number(dotted[5])]
  const [left = '', right] = (dotted === null ? bare : String(dotted[1])).split('::')
  const parsed = (part: string) =>
    part
      .split(':')
      .filter((group) => group !== '')
      .map((group) => Number.parseInt(group, 16))
  const head = parsed(left)
  if (right === undefined) return Option.some([...head, ...tail])
  const rest = [...parsed(right), ...tail]
  const gap = Array.from({ length: 8 - head.length - rest.length }, () => 0)
  return Option.some([...head, ...gap, ...rest])
}

const zeros = (parts: ReadonlyArray<number>) => parts.every((part) => part === 0)

/**
 * The IPv4 address written inside an IPv6 one, when there is one: IPv4-mapped (`::ffff:a.b.c.d`),
 * the well-known NAT64 prefix (`64:ff9b::/96`, which is how every name resolves on an IPv6-only
 * network), and the old IPv4-compatible form (`::a.b.c.d`, but not `::` or `::1`). The rule for
 * the inner address is the one that counts, so a private address cannot pass by being wrapped,
 * and a public one reached through NAT64 is not refused (the reference's `embeddedV4`). The
 * prefix is matched over all ninety-six bits: `64:ff9b:1::/48` is a different, local range.
 */
const embedded = (parts: ReadonlyArray<number>): Option.Option<string> => {
  const [high = 0, low = 0] = parts.slice(6)
  const mapped = zeros(parts.slice(0, 5)) && parts[5] === 0xffff
  const translated = parts[0] === 0x64 && parts[1] === 0xff9b && zeros(parts.slice(2, 6))
  const compatible = zeros(parts.slice(0, 6)) && !(high === 0 && low <= 1)
  return mapped || translated || compatible
    ? Option.some(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`)
    : Option.none()
}

/**
 * Whether an address literal is one egress must not dial. Anything that is not an address is:
 * what cannot be read cannot be checked.
 */
export const isReserved = (address: string): boolean => {
  if (NodeNet.isIPv4(address)) return RESERVED.check(address, 'ipv4')
  return Option.match(groups(address), {
    onNone: () => true,
    onSome: (parts) =>
      Option.match(embedded(parts), {
        onNone: () => {
          const whole = parts.map((part) => part.toString(16)).join(':')
          return !PUBLIC_V6.check(whole, 'ipv6') || PROTOCOL_V6.check(whole, 'ipv6')
        },
        onSome: (inner) => RESERVED.check(inner, 'ipv4'),
      }),
  })
}
