import { describe, expect, it } from 'vitest'
import { Forbidden, type ConversationMessage } from '@vivid/contracts'
import { Following, LiveState } from '@vivid/state'
import { Option } from 'effect'
import { drawnFrom } from './heard'

const message: ConversationMessage = {
  id: 'reply',
  role: 'assistant',
  purpose: 'assistant',
  display: 'visible',
  submissionId: '7',
  parts: [{ type: 'text', text: 'Private answer', state: 'done' }],
}
const kept = Option.some({ messages: [message], settled: ['7'] })

describe('phone conversation recovery', () => {
  it('draws cached words with their endings while opening, without claiming they are current', () => {
    expect(drawnFrom(LiveState.Loading(), kept)).toEqual({
      messages: [message],
      settled: ['7'],
      ready: true,
      live: false,
    })
  })
  it('keeps a disconnected reading visible without using it as admission proof', () => {
    const state = {
      working: false,
      queued: 0,
      messages: [message],
      settlements: [{ submissionId: '7', outcome: 'completed' as const }],
    }
    const behind = drawnFrom(
      LiveState.Ready({ value: Following.Behind({ state: Option.some(state) }) }),
      kept,
    )
    expect(behind).toEqual({ messages: [message], settled: ['7'], ready: true, live: false })
    expect(drawnFrom(LiveState.Ready({ value: Following.Live({ state }) }), kept).live).toBe(true)
  })
  it('withholds cached private words when the server refuses access', () => {
    expect(
      drawnFrom(
        LiveState.Failed({ failure: Forbidden.make({ message: 'No longer shared' }) }),
        kept,
      ),
    ).toEqual({ messages: [], settled: [], ready: false, live: false })
  })
})
