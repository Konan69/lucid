import { describe, expect, it } from 'vitest'
import { Tab } from '../shared/pages.ts'
import {
  EXPECTED_INPUT_MILLIS,
  InputSignal,
  Touch,
  consumeExpected,
  signalsMatch,
} from './touch.ts'

const page = Tab.make('7b0c7f0a-6c0e-4f61-9a55-0d8f6f1f2a10')
const other = Tab.make('1d1b7c1e-9a55-4c0e-8f61-2a100d8f6f1f')
const click = InputSignal.cases.Pointer.make({ x: 120, y: 48, button: 'left' })
const enter = InputSignal.cases.Key.make({ key: 'Enter', code: 'Enter' })

describe('telling Vivid’s presses from the Person’s', () => {
  it('a pointer may land one pixel off; a different button or a far point is another press', () => {
    expect(
      signalsMatch(click, InputSignal.cases.Pointer.make({ x: 121, y: 47, button: 'left' })),
    ).toBe(true)
    expect(
      signalsMatch(click, InputSignal.cases.Pointer.make({ x: 122, y: 48, button: 'left' })),
    ).toBe(false)
    expect(
      signalsMatch(click, InputSignal.cases.Pointer.make({ x: 120, y: 48, button: 'right' })),
    ).toBe(false)
    expect(signalsMatch(click, enter)).toBe(false)
    expect(
      signalsMatch(enter, InputSignal.cases.Key.make({ key: 'Enter', code: 'NumpadEnter' })),
    ).toBe(false)
  })

  it('an announcement excuses exactly one press and nothing after it has run out', () => {
    const pending = [
      { signal: click, expiresAt: 1_000 },
      { signal: click, expiresAt: 1_000 },
    ]
    const first = consumeExpected(pending, click, 500)
    expect(first.matched).toBe(true)
    expect(first.pending).toHaveLength(1)
    expect(consumeExpected(first.pending, click, 1_000)).toEqual({ matched: false, pending: [] })
  })

  it('Vivid’s announced press goes through and the action carries on', () => {
    const touch = new Touch()
    let taken = 0
    touch.begin(page, () => taken++)
    touch.expect(enter, 10)
    expect(touch.judge(page, enter, 20)).toBe('Vivid')
    expect(taken).toBe(0)
    expect(touch.drives(page)).toBe(true)
  })

  it('a press nobody announced ends the action once, and later presses are the Person’s own', () => {
    const touch = new Touch()
    let taken = 0
    touch.begin(page, () => taken++)
    touch.expect(enter, 10)
    expect(touch.judge(page, click, 20)).toBe('Person')
    expect(taken).toBe(1)
    expect(touch.drives(page)).toBe(false)
    expect(touch.judge(page, click, 30)).toBe('Nobody')
    expect(taken).toBe(1)
  })

  it('an announced press that arrives too late is the Person’s', () => {
    const touch = new Touch()
    let taken = 0
    touch.begin(page, () => taken++)
    touch.expect(click, 0)
    expect(touch.judge(page, click, EXPECTED_INPUT_MILLIS)).toBe('Person')
    expect(taken).toBe(1)
  })

  it('a press on a page Vivid is not acting on changes nothing', () => {
    const touch = new Touch()
    let taken = 0
    touch.begin(page, () => taken++)
    expect(touch.judge(other, click, 5)).toBe('Nobody')
    expect(taken).toBe(0)
    touch.end()
    expect(touch.judge(page, click, 6)).toBe('Nobody')
  })
})
