import { beforeEach, expect, it } from 'vitest'
import { homeComposer, homeShown, writeAfresh } from './fresh.ts'

/** A composer that counts how often it was given the keyboard. */
const composer = () => {
  const seen = { focused: 0 }
  homeComposer.current = {
    focus: () => {
      seen.focused += 1
    },
    blur: () => undefined,
    setSelection: () => undefined,
  }
  return seen
}

beforeEach(() => {
  // Whatever an earlier case left wanted is granted to nobody.
  homeComposer.current = null
  homeShown()
})

it('gives Home’s composer the keyboard at once when Home is in front', () => {
  const seen = composer()
  writeAfresh(true)
  expect(seen.focused).toBe(1)
  // Nothing was left waiting for Home to come back.
  homeShown()
  expect(seen.focused).toBe(1)
})

it('waits for Home to come back into view when it is covered', () => {
  const seen = composer()
  writeAfresh(false)
  expect(seen.focused).toBe(0)
  homeShown()
  expect(seen.focused).toBe(1)
})

it('grants a wish once: Home coming back again later takes no keyboard', () => {
  const seen = composer()
  writeAfresh(false)
  homeShown()
  homeShown()
  expect(seen.focused).toBe(1)
})

it('does nothing while Home has no composer', () => {
  writeAfresh(true)
  writeAfresh(false)
  expect(() => homeShown()).not.toThrow()
})
