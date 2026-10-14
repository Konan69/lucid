import { expect, it } from 'vitest'
import { isReserved } from './reserved.ts'

it.each([
  '10.1.2.3',
  '172.16.0.1',
  '172.31.255.255',
  '192.168.1.1',
  '127.0.0.1',
  '169.254.169.254',
  '100.64.0.1',
  '0.0.0.0',
  '192.0.2.7',
  '198.18.0.1',
  '224.0.0.251',
  '255.255.255.255',
  '::1',
  '::',
  'fe80::1',
  'fe80::1%eth0',
  'fd00::1',
  'ff02::1',
  // A private address wrapped in IPv6, each way it can be written.
  '::ffff:10.0.0.1',
  '::ffff:a00:1',
  '64:ff9b::192.168.0.1',
  '::127.0.0.1',
  'not an address',
  // Deprecated site-local (RFC 3879) and the local-use NAT64 prefix (RFC 8215): both are
  // networks of the Person's own, and neither is in the reference's list.
  'fec0::1',
  'feff::1',
  '64:ff9b:1::a00:1',
  '64:ff9b:1::8.8.8.8',
  // Ranges no public site has: documentation, discard, the IETF's protocol block (Teredo,
  // benchmarking, ORCHID), 6to4 whatever it wraps, and segment identifiers.
  '2001:db8::1',
  '3fff::1',
  '100::1',
  '100:0:0:1::1',
  '2001::1',
  '2001:0:a00:1::1',
  '2001:2::1',
  '2001:10::1',
  '2002:a00:1::1',
  '2002:808:808::1',
  '5f00::1',
  // Space the IETF has not given to anyone: outside `2000::/3` nothing is a public host.
  '4000::1',
  '8000::1',
  'e000::1',
  '::ffff:0:8.8.8.8',
  // The retired 6to4 relay anycast range.
  '192.88.99.1',
])('refuses %s', (address) => {
  expect(isReserved(address)).toBe(true)
})

it.each([
  '8.8.8.8',
  '172.32.0.1',
  '100.128.0.1',
  '2606:4700:4700::1111',
  // A public address reached through NAT64 on an IPv6-only network, and one written as mapped.
  '64:ff9b::8.8.8.8',
  '::ffff:8.8.8.8',
  // The first and last addresses of public IPv6 on either side of the protocol block.
  '2000::1',
  '2001:200::1',
  '2a00:1450:4001:81b::200e',
  '3ffe::1',
  // Special-purpose, and reachable from anywhere: the AS112 name servers.
  '192.175.48.1',
  '2620:4f:8000::1',
])('allows %s', (address) => {
  expect(isReserved(address)).toBe(false)
})
