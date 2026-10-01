import { describe, expect, it } from 'vitest'
import { beats, laptopAssistant, phoneAssistant, phoneCall, teammate, workForTurn } from './script'

/**
 * The demo's story has to hold together on its own: every line Vivid speaks has work the Thread
 * can show, the last line is the one that ends the call, and the phone call carries the news and
 * the job. These are the parts that break silently when the story is edited.
 */

describe('the laptop beats', () => {
  it('shows work for every turn after the greeting, and nothing before or after', () => {
    expect(workForTurn(1)).toEqual([])
    for (const [index, beat] of beats.entries()) expect(workForTurn(index + 2)).toEqual(beat.work)
    expect(workForTurn(beats.length + 2)).toEqual([])
  })

  it('ends on the call to the teammate, which is also what hangs the call up', () => {
    const last = beats.at(-1)
    expect(last?.work.some((work) => work.kind === 'calling')).toBe(true)
    const phrase = laptopAssistant.endCallPhrases?.at(0)
    expect(phrase).toBeDefined()
    expect(last?.line.toLocaleLowerCase()).toContain(phrase)
  })

  it('gives the model every line, in order', () => {
    const prompt = laptopAssistant.model?.messages?.at(0)?.content
    expect(typeof prompt).toBe('string')
    let cursor = 0
    for (const beat of beats) {
      const found = String(prompt).indexOf(beat.line, cursor)
      expect(found, `missing or out of order: ${beat.line}`).toBeGreaterThan(-1)
      cursor = found
    }
  })
})

describe('the call to the teammate', () => {
  it('opens by naming them and carries the approval and the job', () => {
    const call = phoneCall(teammate)
    expect(call.opening).toContain(teammate)
    expect(call.brief).toContain('approved')
    expect(call.brief.toLocaleLowerCase()).toContain('interlink')
  })

  it('speaks first with that opening', () => {
    const call = phoneCall(teammate)
    expect(phoneAssistant(call).firstMessage).toBe(call.opening)
  })
})
