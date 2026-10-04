import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import { Unresolved, isPublicAddress, mayOpen } from './reach.ts'

/** Names as a resolver would answer them; anything else does not resolve. */
const names = new Map<string, ReadonlyArray<string>>([
  ['example.com', ['93.184.215.14', '2606:2800:21f:cb07:6820:80da:af6b:8b2c']],
  ['intranet.example', ['10.0.0.12']],
  ['both.example', ['93.184.215.14', '192.168.1.1']],
  ['loop.example', ['127.0.0.1']],
])
const resolve = (host: string) => {
  const found = names.get(host)
  return found === undefined ? Effect.fail(new Unresolved({})) : Effect.succeed(found)
}

describe('where Vivid may go from the Person’s computer', () => {
  it('each class of near address is refused, and public ones are not', () => {
    for (const near of [
      '127.0.0.1',
      '127.8.9.10',
      '0.0.0.0',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '100.127.255.254',
      '::1',
      '::',
      'fc00::1',
      'fd12:3456:789a::1',
      'fe80::1',
      '::ffff:10.0.0.1',
      '::ffff:127.0.0.1',
      'not-an-address',
    ])
      expect(isPublicAddress(near), near).toBe(false)
    for (const far of ['93.184.215.14', '172.32.0.1', '100.128.0.1', '8.8.8.8', '2606:4700::1111'])
      expect(isPublicAddress(far), far).toBe(true)
  })

  it.effect('an address is judged by its literal host or by everything its name resolves to', () =>
    Effect.gen(function* () {
      const may = (address: string) => mayOpen(address, resolve)
      expect(yield* may('https://example.com/path')).toBe(true)
      expect(yield* may('https://8.8.8.8/')).toBe(true)
      expect(yield* may('http://192.168.1.1/admin')).toBe(false)
      expect(yield* may('http://[fe80::1]/')).toBe(false)
      expect(yield* may('http://[::ffff:10.0.0.1]/')).toBe(false)
      // A public name that resolves to a near address is a near address.
      expect(yield* may('https://intranet.example/')).toBe(false)
      expect(yield* may('https://loop.example/')).toBe(false)
      // One near address among public ones is enough to refuse.
      expect(yield* may('https://both.example/')).toBe(false)
      // What cannot be resolved cannot be checked.
      expect(yield* may('https://nowhere.example/')).toBe(false)
      expect(yield* may('not a url')).toBe(false)
    }),
  )
})
