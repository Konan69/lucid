import { describe, expect, it } from 'vitest'
import { KEYBOARD_RESERVE, keyboardRoomOf, tallestOf } from './asked'

describe('tallestOf', () => {
  const phone = { window: 844, keyboard: KEYBOARD_RESERVE, bar: 147, composer: 60 }

  it('is what is left between the bar and the composer over the keyboard', () => {
    expect(tallestOf(phone)).toBe(844 - 336 - 147 - 60 - 12)
  })

  it('gives the room of the keyboard back while the keyboard is down', () => {
    const down = tallestOf({ ...phone, keyboard: keyboardRoomOf(false) })
    const up = tallestOf({ ...phone, keyboard: keyboardRoomOf(true) })
    expect(down).toBe(Math.min(560, 844 - 147 - 60 - 12))
    expect(down - up).toBeGreaterThan(200)
  })

  it('is never more than its ceiling on a large screen', () => {
    expect(tallestOf({ ...phone, window: 1366 })).toBe(560)
  })

  it('is never squeezed under its floor on a small one', () => {
    expect(tallestOf({ ...phone, window: 568 })).toBe(160)
  })

  it('counts a negative measure as none', () => {
    expect(tallestOf({ ...phone, keyboard: -40, window: 700 })).toBe(700 - 147 - 60 - 12)
  })
})
