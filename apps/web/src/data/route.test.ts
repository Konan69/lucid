import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { decodeSearch } from './route'

describe('the query the app reads', () => {
  it('reads the Settings section a link names', () => {
    expect(decodeSearch({ settings: 'memory' })).toEqual(Option.some({ settings: 'memory' }))
  })

  it('reads a query without the word as Settings shut', () => {
    expect(decodeSearch({})).toEqual(Option.some({}))
  })

  it("leaves out words that are somebody else's, such as a sign-in's mark", () => {
    expect(decodeSearch({ joined: 'google', settings: 'general' })).toEqual(
      Option.some({ settings: 'general' }),
    )
  })

  it('does not read a section this build does not know', () => {
    // The root route turns this into Settings shut, so a link from a newer build opens the app.
    expect(Option.isNone(decodeSearch({ settings: 'billing' }))).toBe(true)
  })
})
