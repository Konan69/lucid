import { afterEach, describe, expect, it, vi } from 'vitest'
import { lasting, QUIET_MS, readingOf, streamSaid } from './stream'

describe('a conversation stream that broke', () => {
  it('is catching up while Flue retries, whatever else the conversation is doing', () => {
    expect(readingOf({ status: 'connecting', broken: true, settledBadly: false })).toBe(
      'CatchingUp',
    )
    expect(readingOf({ status: 'streaming', broken: true, settledBadly: true })).toBe('CatchingUp')
  })

  it('is cut once Flue has stopped trying', () => {
    expect(readingOf({ status: 'error', broken: true, settledBadly: false })).toBe('Cut')
  })

  it('is not the stream when the error is a Run of this client that failed', () => {
    expect(readingOf({ status: 'error', broken: true, settledBadly: true })).toBe('Flowing')
  })

  it('is said at once when the socket is down too, and otherwise only once it has lasted', () => {
    expect(streamSaid('CatchingUp', { socketLost: false, late: false })).toBe(false)
    expect(streamSaid('CatchingUp', { socketLost: true, late: false })).toBe(true)
    expect(streamSaid('CatchingUp', { socketLost: false, late: true })).toBe(true)
    expect(streamSaid('Cut', { socketLost: false, late: false })).toBe(true)
  })
})

describe('something that has lasted', () => {
  afterEach(() => vi.useRealTimers())

  it('answers only after the time has passed, and tells whoever is listening', () => {
    vi.useFakeTimers()
    const held = lasting(true, QUIET_MS)
    const heard = vi.fn()
    held.subscribe(heard)
    vi.advanceTimersByTime(QUIET_MS - 1)
    expect(held.read()).toBe(false)
    vi.advanceTimersByTime(1)
    expect(held.read()).toBe(true)
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('never answers for something that is not so, or that was let go first', () => {
    vi.useFakeTimers()
    const off = lasting(false, QUIET_MS)
    off.subscribe(() => undefined)
    const gone = lasting(true, QUIET_MS)
    gone.subscribe(() => undefined)()
    vi.advanceTimersByTime(QUIET_MS * 2)
    expect(off.read()).toBe(false)
    expect(gone.read()).toBe(false)
  })
})
