import { describe, expect, it } from 'vitest'
import { settledAt } from './settle.js'

/** The two parts a screen draws: what is finished, and what is still arriving. */
const parts = (text: string): readonly [string, string] => {
  const at = settledAt(text)
  return [text.slice(0, at), text.slice(at)]
}

describe('settledAt', () => {
  it('has nothing finished while the first paragraph is arriving', () => {
    expect(settledAt('Rivers bend because')).toBe(0)
  })

  it('cuts in front of the paragraph now arriving', () => {
    expect(parts('First.\n\nSecond.\n\nThi')).toEqual(['First.\n\nSecond.\n\n', 'Thi'])
  })

  it('does not cut on a blank line that nothing follows yet', () => {
    expect(parts('First.\n\nSecond.\n\n')).toEqual(['First.\n\n', 'Second.\n\n'])
  })

  it('never cuts inside a code fence', () => {
    const text = 'Intro.\n\n```ts\nconst a = 1\n\nconst b = 2'
    expect(parts(text)).toEqual(['Intro.\n\n', '```ts\nconst a = 1\n\nconst b = 2'])
  })

  it('does not cut in front of the line that closes a fence', () => {
    const text = 'Intro.\n\n```\na\n\n```'
    expect(parts(text)).toEqual(['Intro.\n\n', '```\na\n\n```'])
  })

  it('cuts after a fence that has closed', () => {
    const text = '```\na\n```\n\nAfter'
    expect(parts(text)).toEqual(['```\na\n```\n\n', 'After'])
  })

  it('keeps a list whose items are spaced apart in one part, with the line that leads into it', () => {
    const text = 'Intro.\n\nSteps:\n\n1. One\n\n2. Two\n\n   more of two\n\n3. Thr'
    expect(parts(text)).toEqual(['Intro.\n\n', text.slice('Intro.\n\n'.length)])
  })

  it('cuts where a paragraph follows a list', () => {
    expect(parts('- a\n- b\n\nThen')).toEqual(['- a\n- b\n\n', 'Then'])
  })
})
