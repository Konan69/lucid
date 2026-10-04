import { describe, expect, it } from 'vitest'
import { Option } from 'effect'
import {
  buildThreadTitlePrompt,
  canReplaceThreadTitle,
  formatThreadTitleContext,
  sanitizeThreadTitle,
} from './title.ts'

describe('Thread titles', () => {
  it.each([
    [
      '  "Reconnect failures after restart because the session state does not recover"  ',
      'Reconnect failures after restart because the se...',
    ],
    ['  `Plan   a\tweekend away`\nsecond line', 'Plan a weekend away'],
    [" 'Find flights'\r\nignored", 'Find flights'],
    ['  \n  ', 'New thread'],
    ['`"\'`', 'New thread'],
    ['a'.repeat(50), 'a'.repeat(50)],
    ['a'.repeat(51), `${'a'.repeat(47)}...`],
  ])('sanitizes %j', (raw, expected) => expect(sanitizeThreadTitle(raw)).toBe(expected))

  it('only replaces Seed titles regardless of the actual title words', () => {
    expect(canReplaceThreadTitle('Seed')).toBe(true)
    expect(canReplaceThreadTitle('Person')).toBe(false)
    expect(canReplaceThreadTitle('Generated')).toBe(false)
  })

  it('keeps chronological Person and Vivid text, omitting system and blank messages', () => {
    expect(
      formatThreadTitleContext([
        { role: 'system', text: 'Secret instructions' },
        { role: 'user', text: '  Plan a holiday  ' },
        { role: 'assistant', text: 'Where would you like to go?' },
        { role: 'user', text: ' ' },
      ]),
    ).toBe('USER:\nPlan a holiday\n\nASSISTANT:\nWhere would you like to go?')
    expect(formatThreadTitleContext([])).toBe('')
  })

  it('ports T3’s pinned opening goal and newest suffix under the 8,000 character budget', () => {
    const context = formatThreadTitleContext([
      { role: 'user', text: `Plan a holiday. ${'Opening context. '.repeat(200)}` },
      { role: 'assistant', text: 'Temporary details.' },
      { role: 'user', text: `Latest request ${'recent details '.repeat(600)} END` },
    ])
    expect(context.length).toBe(8000)
    expect(context).toMatch(/^USER:\nPlan a holiday/)
    const pinned = context.split('\n\n[Earlier content truncated]')[0]
    expect(pinned).toHaveLength(2000)
    expect(pinned).toContain('[First user message truncated]')
    expect(context).toContain('[Earlier content truncated]')
    expect(context.endsWith(' END')).toBe(true)
    expect(context).not.toContain('Temporary details.')
  })

  it('retains all text that fits, without unnecessary truncation markers', () => {
    const text = 'a'.repeat(7994)
    expect(formatThreadTitleContext([{ role: 'user', text }])).toBe(`USER:\n${text}`)
  })

  it('caps initial input and preserves the end when regenerating, with one marker', () => {
    const message = `${'old '.repeat(3000)}Latest goal`
    expect(buildThreadTitlePrompt(message, Option.none()).prompt).toContain(
      `${message.slice(0, 8000)}\n\n[truncated]`,
    )
    const prompt = buildThreadTitlePrompt(message, Option.some('Old title')).prompt
    expect(prompt).toContain(`The previous title was "Old title"`)
    expect(prompt).toContain(`[Earlier content truncated]\n\n${message.slice(-8000)}`)
    expect(prompt).toContain('meaningfully improved title')
    const already = buildThreadTitlePrompt(
      `[Earlier content truncated]\n\n${message}`,
      Option.some('Old title'),
    ).prompt
    expect(already.match(/\[Earlier content truncated\]/gu)).toHaveLength(1)
  })
})
