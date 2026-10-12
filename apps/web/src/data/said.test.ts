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

    // A key nothing was said under sends nothing away.
    said.withdraw('notice-9')
    expect(shown().map((saying) => saying.leaving)).toEqual([false, false])

    said.withdraw('notice-1')

    expect(shown().map((saying) => [saying.words, saying.leaving])).toEqual([
      ['Budget review is ready', true],
      ['Weekly report ran', false],
    ])
    // The exit is 180 ms: still in the document one millisecond short of it, and gone at it.
    vi.advanceTimersByTime(179)
    expect(shown().map((saying) => saying.words)).toEqual([
      'Budget review is ready',
      'Weekly report ran',
    ])
    vi.advanceTimersByTime(1)
    expect(shown().map((saying) => saying.words)).toEqual(['Weekly report ran'])
  })
})
