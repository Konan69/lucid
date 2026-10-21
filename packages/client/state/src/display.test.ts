import { describe, expect, it } from 'vitest'
import { said, stretches } from './display.ts'

const FENCE = '```'

describe('a reply with displays in it', () => {
  it('is only words when it holds no display', () => {
    expect(stretches('Revenue is up 12%.')).toEqual([
      { kind: 'words', from: 0, text: 'Revenue is up 12%.' },
    ])
  })

  it('is words, the display between its fences, then the words after it', () => {
    const reply = `Here it is:\n\n${FENCE}openui-lang\nroot = Title("Hi")\n${FENCE}\n\nSay if it is wrong.`
    expect(stretches(reply)).toEqual([
      { kind: 'words', from: 0, text: 'Here it is:\n\n' },
      { kind: 'display', from: 13, text: 'root = Title("Hi")\n', whole: true },
      { kind: 'words', from: 50, text: '\n\nSay if it is wrong.' },
    ])
  })

  it('draws a display that is still arriving, and keeps its place when the rest lands', () => {
    const arriving = `Look:\n${FENCE}openui-lang\nroot = Col([a])\na = Tit`
    const [, early] = stretches(arriving)
    expect(early).toEqual({
      kind: 'display',
      from: 6,
      text: 'root = Col([a])\na = Tit',
      whole: false,
    })
    const [, late] = stretches(`${arriving}le("Hi")\n${FENCE}\nDone.`)
    expect(late).toEqual({
      kind: 'display',
      from: 6,
      text: 'root = Col([a])\na = Title("Hi")\n',
      whole: true,
    })
  })

  it('shows nothing of a fence line it is still in the middle of', () => {
    expect(stretches(`Look:\n${FENCE}openui`)).toEqual([{ kind: 'words', from: 0, text: 'Look:' }])
    expect(stretches(`Look:\n${FENCE}openui-lang`)).toEqual([
      { kind: 'words', from: 0, text: 'Look:' },
    ])
  })

  it('keeps each of two displays apart', () => {
    const reply = `${FENCE}openui-lang\nroot = Title("A")\n${FENCE}\n${FENCE}openui-lang\nroot = Title("B")\n${FENCE}`
    expect(stretches(reply).map((stretch) => stretch.text)).toEqual([
      'root = Title("A")\n',
      'root = Title("B")\n',
    ])
  })
})

describe('a program written the other ways OpenUI recognises', () => {
  it('draws a fence tagged openui', () => {
    const reply = `Here:\n${FENCE}openui\nroot = Title("Hi")\n${FENCE}\nDone.`
    expect(stretches(reply).map((stretch) => stretch.kind)).toEqual(['words', 'display', 'words'])
  })

  it('draws an untagged fence whose body is a program', () => {
    const reply = `Open slots:\n\n${FENCE}\nroot = Col([head], 2)\nhead = Title("Slots")\n${FENCE}\n\npick one`
    expect(stretches(reply)).toEqual([
      { kind: 'words', from: 0, text: 'Open slots:\n\n' },
      {
        kind: 'display',
        from: 13,
        text: 'root = Col([head], 2)\nhead = Title("Slots")\n',
        whole: true,
      },
      { kind: 'words', from: 64, text: '\n\npick one' },
    ])
  })

  it('leaves code in another language as words, even when it assigns root', () => {
    const reply = `Try:\n${FENCE}ts\nroot = 1\n${FENCE}\nThen run it.`
    expect(stretches(reply)).toEqual([{ kind: 'words', from: 0, text: reply }])
  })

  it('draws a bare program and the words after it', () => {
    const reply =
      'root = Col([head, slot1], 2)\nhead = Title("Open slots")\nslot1 = Card([Title("Wed"),\n  Text("9:00")], "soft")\n\ntell me the slot.'
    expect(stretches(reply)).toEqual([
      {
        kind: 'display',
        from: 0,
        text: 'root = Col([head, slot1], 2)\nhead = Title("Open slots")\nslot1 = Card([Title("Wed"),\n  Text("9:00")], "soft")\n',
        whole: true,
      },
      { kind: 'words', from: 109, text: '\ntell me the slot.' },
    ])
  })

  it('keeps a bare program arriving while a statement is still open', () => {
    expect(stretches('Here:\nroot = Col([a,')).toEqual([
      { kind: 'words', from: 0, text: 'Here:\n' },
      { kind: 'display', from: 6, text: 'root = Col([a,', whole: false },
    ])
  })
})

describe('a reply that only looks like a program', () => {
  it('is words when root is compared, not assigned', () => {
    expect(stretches('root == 1')).toEqual([{ kind: 'words', from: 0, text: 'root == 1' }])
  })

  it('leaves a fence with any other tag as words', () => {
    const reply = `${FENCE}json5\nroot = 1\n${FENCE}`
    expect(stretches(reply)).toEqual([{ kind: 'words', from: 0, text: reply }])
  })
})

describe('a program read as OpenUI reads it', () => {
  it('ignores brackets inside single-quoted strings', () => {
    expect(stretches("root = Text('Use ( here')\n\nDone.")).toEqual([
      { kind: 'display', from: 0, text: "root = Text('Use ( here')\n", whole: true },
      { kind: 'words', from: 26, text: '\nDone.' },
    ])
  })

  it('keeps a string that runs across lines in the program', () => {
    expect(stretches('root = Text("a\n(b")\nDone.').map((stretch) => stretch.kind)).toEqual([
      'display',
      'words',
    ])
  })

  it('keeps statements after a comment', () => {
    const [display] = stretches('root = Col([head])\n// title\nhead = Text("Hi")\n\nDone.')
    expect(display).toEqual({
      kind: 'display',
      from: 0,
      text: 'root = Col([head])\n// title\nhead = Text("Hi")\n',
      whole: true,
    })
  })

  it('does not close a fence on a fence line inside a string', () => {
    const reply = `${FENCE}openui-lang\nroot = Text("a\n${FENCE}\nb")\n${FENCE}\nDone.`
    expect(stretches(reply).map((stretch) => stretch.kind)).toEqual(['display', 'words'])
    expect(stretches(reply)[0]?.text).toBe(`root = Text("a\n${FENCE}\nb")\n`)
  })

  it('draws an indented bare program', () => {
    expect(stretches('  root = Title("Hi")')).toEqual([
      { kind: 'display', from: 0, text: '  root = Title("Hi")', whole: true },
    ])
  })
})

describe('what a press says', () => {
  it('is the Button’s words alone when no form was filled', () => {
    expect(said('Book Arik Air at 7:10', { $flight: 'Arik Air at 7:10' })).toBe(
      'Book Arik Air at 7:10',
    )
  })

  it('adds each filled field as a line and skips empty and unticked ones', () => {
    const state = {
      $pace: 'Relaxed',
      trip: {
        city: { value: 'Abuja', componentType: 'Input' },
        nights: { value: 2, componentType: 'Input' },
        notes: { value: '  ', componentType: 'TextArea' },
        window: { value: true, componentType: 'Checkbox' },
        late: { value: false, componentType: 'Checkbox' },
      },
    }
    expect(said('Plan my trip', state)).toBe('Plan my trip\ncity: Abuja\nnights: 2\nwindow: yes')
  })
})
