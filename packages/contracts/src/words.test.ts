import { describe, expect, it } from 'vitest'
import { textOf } from './words'
import type { FlueConversationPart } from '@flue/sdk'

const text = (words: string): FlueConversationPart => ({ type: 'text', text: words, state: 'done' })
const reasoning = (words: string): FlueConversationPart => ({
  type: 'reasoning',
  text: words,
  state: 'done',
})
const tool: FlueConversationPart = {
  type: 'dynamic-tool',
  toolName: 'search',
  toolCallId: 'call',
  state: 'input-available',
  input: {},
}

describe("a message's words", () => {
  it('keeps a canonical text block whole alongside reasoning', () => {
    expect(textOf({ parts: [text('**Why Rivers Meander**'), reasoning('.')] })).toBe(
      '**Why Rivers Meander**',
    )
  })

  it('keeps distinct text blocks as paragraphs when reasoning stands between them', () => {
    expect(
      textOf({ parts: [text('First is done.'), reasoning('.'), text('Next topic begins.')] }),
    ).toBe('First is done.\n\nNext topic begins.')
  })

  it('keeps adjacent text blocks as paragraphs', () => {
    expect(textOf({ parts: [text('First.'), text('Second.')] })).toBe('First.\n\nSecond.')
  })

  it('starts a new paragraph after a tool', () => {
    expect(textOf({ parts: [text('Looking.'), tool, text('Found it.')] })).toBe(
      'Looking.\n\nFound it.',
    )
  })

  it('has no words when a message has no text', () => {
    expect(textOf({ parts: [reasoning('hm'), tool] })).toBe('')
  })
})
