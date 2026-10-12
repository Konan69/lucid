import { describe, expect, it } from 'vitest'
import { Option } from 'effect'
import { buildThreadTitlePrompt, formatThreadTitleContext, sanitizeThreadTitle } from './title.ts'

describe('Thread titles', () => {
  it('sanitizes authored title inputs at whitespace, quote and length boundaries', () => {
    const inputs = [
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
    ] as const
    for (const [raw, expected] of inputs) expect(sanitizeThreadTitle(raw)).toBe(expected)
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

  it('bounds conversation data separately from system instructions and prior title', () => {
    const message = `${'old '.repeat(3000)}Latest goal`
    const initial = buildThreadTitlePrompt(message, Option.none())
    expect(initial.content.conversation).toBe(
      `Thread contents:\n${message.slice(0, 8000)}\n\n[truncated]`,
    )
    expect(initial.prompt).not.toContain('Latest goal')
    const regenerated = buildThreadTitlePrompt(message, Option.some('Old title'))
    expect(regenerated.content).toEqual({
      previousTitle: 'Old title',
      conversation: `Thread contents:\n[Earlier content truncated]\n\n${message.slice(-8000)}`,
    })
    expect(regenerated.prompt).not.toContain('Old title')
    expect(regenerated.prompt).not.toContain('Latest goal')
    const already = buildThreadTitlePrompt(
      `[Earlier content truncated]\n\n${message}`,
      Option.some('Old title'),
    ).content.conversation
    expect(already.match(/\[Earlier content truncated\]/gu)).toHaveLength(1)
  })
})
