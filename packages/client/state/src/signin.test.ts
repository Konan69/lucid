import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { signInPage } from './signin.js'

describe('a provider’s sign-in address', () => {
  it('is a page when it is a web address', () => {
    expect(
      Option.map(
        signInPage('https://accounts.example.com/o/authorize?state=abc'),
        (page) => page.href,
      ),
    ).toEqual(Option.some('https://accounts.example.com/o/authorize?state=abc'))
    expect(Option.isSome(signInPage('http://192.168.1.20:5178/return'))).toBe(true)
  })

  it('is nothing when a browser should not be sent there', () => {
    // A script, another app's scheme (which a phone would hand to that app), and not an address.
    for (const address of [
      'javascript:alert(1)',
      'tel:+2348000000000',
      'otherapp://take-over',
      'not an address',
      '',
    ]) {
      expect(signInPage(address)).toEqual(Option.none())
    }
  })
})
