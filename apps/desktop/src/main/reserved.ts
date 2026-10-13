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
 * The ranges are the reference's own (`ea2-window-lifecycle.ts`: `isBlockedV4`, `isSharedCgnat`,
 * `isReservedV4`, `isBlockedV6`, `embeddedV4`), with one made wider: the reference refuses
 * `0.0.0.0` alone and this refuses all of `0.0.0.0/8`, which is "this network" and is equally
 * never a public host.
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
  // Multicast, then everything reserved above it, the broadcast address included.
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  RESERVED.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  RESERVED.addSubnet(network, prefix, 'ipv6')

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
 * the NAT64 prefix (`64:ff9b::/96`, which is how every name resolves on an IPv6-only network),
 * and the old IPv4-compatible form (`::a.b.c.d`, but not `::` or `::1`). The rule for the inner
 * address is the one that counts, so a private address cannot pass by being wrapped, and a public
 * one reached through NAT64 is not refused (the reference's `embeddedV4`).
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
        onNone: () => RESERVED.check(parts.map((part) => part.toString(16)).join(':'), 'ipv6'),
        onSome: (inner) => RESERVED.check(inner, 'ipv4'),
      }),
  })
}
