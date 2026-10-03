import { expect, it } from 'vitest'
import { collapseAt, RESTING } from './collapse.ts'

const scrolled = (offsets: ReadonlyArray<number>, furthest = 2000) =>
  offsets.reduce((state, offset) => collapseAt(state, offset, furthest), RESTING)

it('collapses once the list has moved down past the wobble threshold', () => {
  expect(scrolled([4, 10, 14]).expanded).toBe(true)
  expect(scrolled([4, 10, 18]).expanded).toBe(false)
})

it('expands again when the list moves back up, and always at the top', () => {
  expect(scrolled([40, 200, 195]).expanded).toBe(false)
  expect(scrolled([40, 200, 180]).expanded).toBe(true)
  expect(scrolled([40, 200, 6]).expanded).toBe(true)
})

it('ignores overscroll past the end of the list', () => {
  // The list ends at 300; a bounce to 340 and back is not a change of direction.
  expect(scrolled([40, 300, 340, 300], 300).expanded).toBe(false)
})
