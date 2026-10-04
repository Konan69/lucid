import { describe, expect, it } from 'vitest'
import { ChannelTextLimit, channelText, splitChannelText } from './text.ts'

describe('channel reply text', () => {
  it('keeps words and destinations readable without Markdown presentation', () => {
    expect(
      channelText(
        '# Result\n\n**Done**: [report](https://example.test/report)\n- _Review_ `item_id`\n> Approved',
      ),
    ).toBe('Result\n\nDone: report (https://example.test/report)\n• Review item_id\nApproved')
  })

  it('preserves code and underscores in identifiers', () => {
    expect(channelText('```ts\nconst item_id = 1\n```\n\nUse item_id.')).toBe(
      'const item_id = 1\n\nUse item_id.',
    )
  })

  it('splits a reply at paragraph boundaries when they fit', () => {
    expect(
      splitChannelText(
        'First paragraph.\n\nSecond paragraph.\n\nThird.',
        ChannelTextLimit.make(34),
      ),
    ).toEqual(['First paragraph.', 'Second paragraph.\n\nThird.'])
  })

  it('bounds oversized paragraphs without losing words', () => {
    const text = 'Vivid finished the report and saved the result for review.'
    const parts = splitChannelText(text, ChannelTextLimit.make(20))
    expect(parts.join(' ')).toBe(text)
    expect(parts.every((part) => new TextEncoder().encode(part).length <= 20)).toBe(true)
  })

  it('bounds long Unicode words without splitting emoji', () => {
    const text = '🙂'.repeat(12)
    const parts = splitChannelText(text, ChannelTextLimit.make(13))
    expect(parts.join('')).toBe(text)
    expect(parts.every((part) => new TextEncoder().encode(part).length <= 13)).toBe(true)
    expect(parts).toHaveLength(4)
  })

  it('sends no empty reply', () => {
    expect(splitChannelText(' \n\n ', ChannelTextLimit.make(100))).toEqual([])
  })
})
