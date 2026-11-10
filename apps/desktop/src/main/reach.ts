import * as NodeDns from 'node:dns'
import * as NodeNet from 'node:net'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

/** The name could not be turned into addresses, so where it leads cannot be checked. */
export class Unresolved extends Schema.TaggedError<Unresolved>()(
  'Unresolved',
  {},
  { title: 'The name could not be resolved' },
) {}

/**
 * Addresses that are this computer or the network it sits on, not the public internet: loopback,
 * the private ranges, link-local, carrier-grade NAT, the unspecified address, and for IPv6 the
 * loopback, unique-local and link-local ranges. An IPv4 address written inside an IPv6 one
 * (`::ffff:10.0.0.1`) is unwrapped first, so it cannot slip past as IPv6.
 */
const NEAR = new NodeNet.BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const)
  NEAR.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
] as const)
  NEAR.addSubnet(network, prefix, 'ipv6')

/** `::ffff:a.b.c.d`, in either spelling Node prints it. */
const MAPPED = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu

/** Whether an address literal is on the public internet. Anything that is not an address is not. */
function isPublicAddress(address: string): boolean {
  const mapped = MAPPED.exec(address)
  const literal = mapped === null || mapped[1] === undefined ? address : mapped[1]
  const family = NodeNet.isIP(literal)
  if (family === 0) return false
  // A mapped address Node prints in hexadecimal (`::ffff:a00:1`) is matched by the IPv4 rules too:
  // `BlockList` unwraps it itself (node:net, BlockList.check).
  return !NEAR.check(literal, family === 4 ? 'ipv4' : 'ipv6')
}

/**
 * Whether Vivid may open this address on the Person's computer.
 *
 * Vivid acts from the Person's own machine, inside their network: an address that is harmless
 * from Vivid's own Computer can here be the Person's router, a printer or a service on the
 * machine itself. So a navigation Vivid starts is allowed only to the public internet: the host
 * is resolved first and every address it resolves to must be public. A name that cannot be
 * resolved is refused, because where it leads cannot be checked. The Person's own typing in the
 * address bar does not come through here and is not changed.
 *
 * What this does not close: Chromium resolves the name again when it connects. A name that
 * answers with a public address here and a private one a moment later (DNS rebinding) passes
 * this check and reaches the private address. Closing that needs the connection itself pinned to
 * the checked address, which this does not do.
 */
const mayOpen = Effect.fn('DesktopReach.mayOpen')(function* (
  address: string,
  resolve: (host: string) => Effect.Effect<ReadonlyArray<string>, Unresolved>,
) {
  if (!URL.canParse(address)) return false
  // WHATWG URLs keep the brackets on an IPv6 host.
  const host = new URL(address).hostname.replace(/^\[|\]$/gu, '')
  if (NodeNet.isIP(host) !== 0) return isPublicAddress(host)
  const addresses = yield* resolve(host).pipe(
    Effect.catchTag('Unresolved', () => Effect.succeed<ReadonlyArray<string>>([])),
  )
  return addresses.length > 0 && addresses.every(isPublicAddress)
})

/** What the system resolver says a name leads to; failure is its own answer, not an empty list. */
export const resolveHost = (host: string) =>
  Effect.tryPromise({
    try: () => NodeDns.promises.lookup(host, { all: true }),
    catch: () => new Unresolved({}),
  }).pipe(Effect.map((found) => found.map((entry) => entry.address)))

/** Whether Vivid may open an address from this computer: the public internet only. */
export const vividMayOpen = (address: string) => mayOpen(address, resolveHost)
