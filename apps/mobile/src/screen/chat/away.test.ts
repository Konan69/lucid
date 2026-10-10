import { describe, expect, it } from 'vitest'
import { AWAY, isAway, newestWords } from './away'

describe('isAway', () => {
  it('is not away at the newest words', () => {
    expect(isAway({ offset: 1200, content: 2000, viewport: 800 })).toBe(false)
  })

  it('is not away within the threshold of the newest words', () => {
    expect(isAway({ offset: 1200 - AWAY, content: 2000, viewport: 800 })).toBe(false)
  })

  it('is away once more than the threshold is below the viewport', () => {
    expect(isAway({ offset: 1200 - AWAY - 1, content: 2000, viewport: 800 })).toBe(true)
  })

  it('is not away in a conversation shorter than its viewport', () => {
    expect(isAway({ offset: 0, content: 300, viewport: 800 })).toBe(false)
  })

  it('is not away while the scroller is pulled past its end', () => {
    expect(isAway({ offset: 1260, content: 2000, viewport: 800 })).toBe(false)
  })
})

describe('newestWords', () => {
  it('says only where the button goes when nothing arrived', () => {
    expect(newestWords(0)).toBe('Go to the newest message')
  })

  it('counts one arrival in the singular', () => {
    expect(newestWords(1)).toBe('Go to the newest message, 1 new message')
  })

  it('counts several arrivals', () => {
    expect(newestWords(3)).toBe('Go to the newest message, 3 new messages')
  })
})
