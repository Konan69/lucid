import { Option } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { said, sayWith, useSaid } from './said'

const shown = () => useSaid.getState().sayings

describe('withdrawing a sentence', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    // Every sentence times out and leaves, so the store is empty for the next case.
    vi.runAllTimers()
    vi.useRealTimers()
  })

  it('sends away only the sentence said under that key, then takes it out', () => {
    sayWith('Budget review is ready', Option.none(), 'notice-1')
    sayWith('Weekly report ran', Option.none(), 'notice-2')

    said.withdraw('notice-1')

    expect(shown().map((saying) => [saying.words, saying.leaving])).toEqual([
      ['Budget review is ready', true],
      ['Weekly report ran', false],
    ])
    // The exit is 180 ms; after it the sentence is no longer in the document at all.
    vi.advanceTimersByTime(180)
    expect(shown().map((saying) => saying.words)).toEqual(['Weekly report ran'])
  })

  it('does nothing for a key nothing was said under', () => {
    sayWith('Weekly report ran', Option.none(), 'notice-2')

    said.withdraw('notice-9')

    expect(shown().map((saying) => saying.leaving)).toEqual([false])
  })
})
