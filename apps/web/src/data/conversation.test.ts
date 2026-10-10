import type { AgentConversationObservation, AgentConversationObservationPhase } from '@flue/sdk'
import { ThreadId } from '@vivid/contracts'
import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { makeConversations } from './conversation'

/** What was asked of one Thread's real client: observations begun, refreshed and closed. */
interface Asked {
  begun: number
  refreshed: number
  closed: number
  phase: AgentConversationObservationPhase
  /** Whether the server has answered with the conversation, here one with nothing said in it. */
  read: boolean
}

/**
 * A stand-in for Flue's client that records what the code under test asks of it. Flue itself is
 * not under test; only `observe` exists here, which is all the code under test may use.
 */
const flue = () => {
  const asked = new Map<ThreadId, Asked>()
  /** One Thread's record, made the first time it is named, by a test or by a connection. */
  const of = (id: ThreadId): Asked => {
    const known = asked.get(id)
    if (known !== undefined) return known
    const made: Asked = { begun: 0, refreshed: 0, closed: 0, phase: 'live', read: false }
    asked.set(id, made)
    return made
  }
  const connect = (id: ThreadId) => ({
    observe: (): AgentConversationObservation => {
      const seen = of(id)
      seen.begun += 1
      // One object for as long as nothing changes, as the real observation gives: it makes a
      // new snapshot only when it has something new to say.
      const make = () => ({
        phase: seen.phase,
        read: seen.read,
        snapshot: {
          conversation: seen.read
            ? { conversationId: id, messages: [], settlements: [] }
            : undefined,
          offset: undefined,
          phase: seen.phase,
          error: undefined,
        },
      })
      let last = make()
      return {
        getSnapshot: () => {
          if (last.phase !== seen.phase || last.read !== seen.read) last = make()
          return last.snapshot
        },
        subscribe: () => () => undefined,
        refresh: () => {
          seen.refreshed += 1
        },
        close: () => {
          seen.closed += 1
        },
      }
    },
  })
  return { connect, of }
}

const a = ThreadId.make('a')
const b = ThreadId.make('b')
const c = ThreadId.make('c')

describe('the conversations a page holds open', () => {
  it('hands a Thread the same client on every ask, over one observation', () => {
    const real = flue()
    const conversations = makeConversations(0, real.connect)
    const first = conversations.of(a)
    // A screen asks for its client on every render; a new one each time would rebuild its session
    // on every render, which is the loop this guards against.
    expect(conversations.of(a)).toBe(first)
    first.observe().close()
    first.observe()
    expect(real.of(a).begun).toBe(1)
  })

  it('keeps the conversation used last open even when none are kept', () => {
    const real = flue()
    const conversations = makeConversations(0, real.connect)
    conversations.of(a)
    expect(real.of(a).closed).toBe(0)
    conversations.of(b)
    expect(real.of(a).closed).toBe(1)
    expect(real.of(b).closed).toBe(0)
  })

  it('never lets go of one a screen is reading', () => {
    const real = flue()
    const conversations = makeConversations(0, real.connect)
    const reading = conversations.of(a).observe()
    conversations.warm(b)
    conversations.warm(c)
    expect(real.of(a).closed).toBe(0)
    // The reader leaves; the conversation is now idle and older than the last used.
    reading.close()
    expect(real.of(a).closed).toBe(1)
  })

  it('keeps as many idle conversations as it is told, letting the oldest go first', () => {
    const real = flue()
    const conversations = makeConversations(1, real.connect)
    conversations.warm(a)
    conversations.warm(b)
    conversations.warm(c)
    expect(real.of(a).closed).toBe(1)
    expect(real.of(b).closed).toBe(0)
    expect(real.of(c).closed).toBe(0)
  })

  it('asks again when a screen opens a conversation the server did not have yet', () => {
    const real = flue()
    const conversations = makeConversations(3, real.connect)
    conversations.warm(a)
    const seen = real.of(a)
    seen.phase = 'absent'
    const reader = conversations.of(a).observe()
    expect(seen.refreshed).toBe(1)
    // Until the answer is back the observation still says "absent"; the reader is told it is
    // being read, so its screen does not draw a conversation with nothing in it.
    expect(reader.getSnapshot().phase).toBe('loading')
    seen.phase = 'live'
    expect(reader.getSnapshot().phase).toBe('live')
    seen.phase = 'live'
    conversations.of(a).observe()
    expect(seen.refreshed).toBe(1)
  })

  it('tries again when a screen opens a conversation that had given up with an error', () => {
    const real = flue()
    const conversations = makeConversations(3, real.connect)
    conversations.warm(a)
    real.of(a).phase = 'error'
    const reader = conversations.of(a).observe()
    expect(real.of(a).refreshed).toBe(1)
    expect(reader.getSnapshot().phase).toBe('loading')
  })

  it('says what is already known of a conversation, once it has been read', () => {
    const real = flue()
    const conversations = makeConversations(3, real.connect)
    // Not open here: nothing is known, and asking opens nothing.
    expect(Option.isNone(conversations.heard(a))).toBe(true)
    expect(real.of(a).begun).toBe(0)
    conversations.warm(a)
    expect(Option.isNone(conversations.heard(a))).toBe(true)
    real.of(a).read = true
    expect(conversations.heard(a)).toEqual(Option.some([]))
  })

  it('ends everything when the session ends', () => {
    const real = flue()
    const conversations = makeConversations(3, real.connect)
    conversations.of(a).observe()
    conversations.warm(b)
    conversations.forget()
    expect(real.of(a).closed).toBe(1)
    expect(real.of(b).closed).toBe(1)
  })
})
