import { describe, expect, it } from 'vitest'
import {
  AWAY,
  anchorAt,
  arrivedSince,
  isAway,
  newestOf,
  newestWords,
  offsetFor,
  type Laid,
} from './away'
import { Option } from 'effect'

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

describe('arrivedSince', () => {
  const said = (...ids: ReadonlyArray<string>) => ids.map((id) => ({ id }))

  it('counts what came after the newest message the Person had seen', () => {
    expect(arrivedSince(said('a', 'b', 'c', 'd'), 'b')).toBe(2)
  })

  it('counts nothing for older history that loads in above it', () => {
    expect(arrivedSince(said('older', 'old', 'a', 'b'), 'b')).toBe(0)
  })

  it('counts nothing when that message is no longer there', () => {
    expect(arrivedSince(said('a', 'b'), 'gone')).toBe(0)
  })

  it('is taken from the newest message, and from nothing in an empty conversation', () => {
    expect(newestOf(said('a', 'b'))).toEqual(Option.some('b'))
    expect(newestOf([])).toEqual(Option.none())
  })
})

describe('the place a Person is reading', () => {
  const laid = (...rows: ReadonlyArray<[string, number, number]>) =>
    new Map<string, Laid>(rows.map(([key, y, height]) => [key, { y, height }]))

  it('is the first row whose foot is below the top of the viewport, and how far into it', () => {
    const rows = laid(['c', 400, 300], ['a', 0, 200], ['b', 222, 156])
    expect(anchorAt(rows, 300)).toEqual(Option.some({ key: 'b', offset: 78 }))
  })

  it('is the last row above the top when what the viewport starts in is not a message row', () => {
    expect(anchorAt(laid(['a', 0, 200]), 500)).toEqual(Option.some({ key: 'a', offset: 500 }))
  })

  it('is nowhere when no row is laid out', () => {
    expect(anchorAt(laid(), 500)).toEqual(Option.none())
  })

  it('follows its row when older history loads in above it', () => {
    const anchor = { key: 'b', offset: 78 }
    expect(offsetFor(anchor, laid(['a', 0, 200], ['b', 222, 156]))).toEqual(Option.some(300))
    expect(offsetFor(anchor, laid(['old', 0, 900], ['a', 922, 200], ['b', 1144, 156]))).toEqual(
      Option.some(1222),
    )
  })

  it('does not move when a reply arrives below it', () => {
    const anchor = { key: 'b', offset: 78 }
    expect(offsetFor(anchor, laid(['b', 222, 156], ['reply', 400, 600]))).toEqual(Option.some(300))
  })

  it('cannot be found when its row is not laid out', () => {
    expect(offsetFor({ key: 'gone', offset: 0 }, laid(['a', 0, 200]))).toEqual(Option.none())
  })
})
