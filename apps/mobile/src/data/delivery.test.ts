import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { deliveryOf, type Unsent } from './delivery.ts'

/** Hands out `key-1`, `key-2`, … so a test can tell a key that was made from one that was kept. */
const counter = () => {
  let made = 0
  return () => {
    made += 1
    return `key-${made}`
  }
}

const lost: Unsent = {
  words: 'Send the invoice to Dami',
  key: 'first-try',
  why: 'That message did not reach Vivid.',
}

describe('which delivery a message is', () => {
  it('gives new words a key of their own', () => {
    const fresh = counter()
    expect(deliveryOf(Option.none(), 'Send the invoice to Dami', fresh)).toEqual({
      words: 'Send the invoice to Dami',
      key: 'key-1',
    })
    // The same words said twice on purpose are two messages while neither is in doubt.
    expect(deliveryOf(Option.none(), 'Send the invoice to Dami', fresh).key).toBe('key-2')
  })

  it('sends words that did not arrive again as the same delivery', () => {
    const fresh = counter()
    expect(deliveryOf(Option.some(lost), lost.words, fresh)).toEqual({
      words: lost.words,
      key: 'first-try',
    })
    // No key was made: a second key is what would let the server run the work twice.
    expect(fresh()).toBe('key-1')
  })

  it('treats different words as a different message, even with one still in doubt', () => {
    const delivery = deliveryOf(Option.some(lost), 'Send the invoice to Ben instead', counter())
    expect(delivery.key).toBe('key-1')
  })
})
