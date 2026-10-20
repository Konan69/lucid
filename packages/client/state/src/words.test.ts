import { describe, expect, it } from 'vitest'
import { textOf } from './words'

const text = (words: string) => ({ type: 'text' as const, text: words })
const reasoning = (words: string) => ({ type: 'reasoning' as const, text: words })
const tool = { type: 'dynamic-tool' }

describe("a message's words", () => {
  it('reads text the model broke off to think as one stretch, as the stored reply has it', () => {
    // The parts Flue's client built from production's stream of 16 October 2026.
    const live = {
      parts: [
        reasoning('Just answer: ~500 words, three short headings.'),
        text('**'),
        reasoning('.'),
        text('Why Rivers Meander**\n\nRivers almost never run in straight lines.'),
      ],
    }
    const stored = {
      parts: [
        reasoning('Just answer: ~500 words, three short headings..'),
        text('**Why Rivers Meander**\n\nRivers almost never run in straight lines.'),
      ],
    }
    expect(textOf(live)).toBe(textOf(stored))
    expect(textOf(live)).toBe(
      '**Why Rivers Meander**\n\nRivers almost never run in straight lines.',
    )
  })

  it('starts a new paragraph after a tool', () => {
    const message = { parts: [text('Looking.'), tool, text('Found it.')] }
    expect(textOf(message)).toBe('Looking.\n\nFound it.')
  })

  it('keeps a paragraph break across a tool even when thinking follows it', () => {
    const message = { parts: [text('Looking.'), tool, reasoning('hm'), text('Found it.')] }
    expect(textOf(message)).toBe('Looking.\n\nFound it.')
  })

  it('has no words when a message has no text', () => {
    expect(textOf({ parts: [reasoning('hm'), tool] })).toBe('')
  })
})
