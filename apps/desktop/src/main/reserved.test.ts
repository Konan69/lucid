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
])('allows %s', (address) => {
  expect(isReserved(address)).toBe(false)
})
