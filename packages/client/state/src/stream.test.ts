import { describe, expect, it } from 'vitest'
import { readingOf, streamSaid } from './stream'

describe('a conversation stream that broke', () => {
  it('is catching up while Flue retries, whatever else the conversation is doing', () => {
    expect(readingOf({ status: 'connecting', broken: true })).toBe('CatchingUp')
    expect(readingOf({ status: 'streaming', broken: true })).toBe('CatchingUp')
  })

  it('is cut once Flue has stopped trying', () => {
    expect(readingOf({ status: 'error', broken: true })).toBe('Cut')
  })

  it('is not said while the app can still reach its server', () => {
    expect(streamSaid('CatchingUp', false)).toBe(false)
    expect(streamSaid('CatchingUp', true)).toBe(true)
    expect(streamSaid('Cut', false)).toBe(true)
    expect(streamSaid('Flowing', true)).toBe(false)
  })
})
