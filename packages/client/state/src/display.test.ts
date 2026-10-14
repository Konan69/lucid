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
    expect(early).toEqual({ kind: 'display', from: 6, text: 'root = Col([a])\na = Tit', whole: false })
    const [, late] = stretches(`${arriving}le("Hi")\n${FENCE}\nDone.`)
    expect(late).toEqual({ kind: 'display', from: 6, text: 'root = Col([a])\na = Title("Hi")\n', whole: true })
  })

  it('shows nothing of a fence line it is still in the middle of', () => {
    expect(stretches(`Look:\n${FENCE}openui`)).toEqual([{ kind: 'words', from: 0, text: 'Look:' }])
    expect(stretches(`Look:\n${FENCE}openui-lang`)).toEqual([
      { kind: 'words', from: 0, text: 'Look:\n' },
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
