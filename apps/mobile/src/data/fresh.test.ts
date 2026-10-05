import { expect, it } from 'vitest'
import { homeComposer, homeShown, writeAfresh } from './fresh.ts'

/**
 * A mounted composer that counts how often it was given the keyboard. `gone` is what React calls
 * when it unmounts.
 */
const mounted = () => {
  const seen = { focused: 0 }
  const gone = homeComposer({
    focus: () => {
      seen.focused += 1
    },
    blur: () => undefined,
    setSelection: () => undefined,
  })
  return { seen, gone }
}

it('gives Home’s composer the keyboard at once when Home is in front', () => {
  const { seen, gone } = mounted()
  writeAfresh(true)
  expect(seen.focused).toBe(1)
  // Nothing was left waiting for Home to come back.
  homeShown()
  expect(seen.focused).toBe(1)
  gone()
})

it('waits for Home to come back into view when it is covered', () => {
  const { seen, gone } = mounted()
  writeAfresh(false)
  expect(seen.focused).toBe(0)
  homeShown()
  expect(seen.focused).toBe(1)
  gone()
})

it('grants a wish once: Home coming back again later takes no keyboard', () => {
  const { seen, gone } = mounted()
  writeAfresh(false)
  homeShown()
  homeShown()
  expect(seen.focused).toBe(1)
  gone()
})

it('drops a wish with the Home it was for', () => {
  // Asked for from a Thread, then the Person signed out before Home came back.
  const first = mounted()
  writeAfresh(false)
  first.gone()
  // The Home drawn for whoever signs in next comes into view: it was promised nothing.
  const next = mounted()
  homeShown()
  expect(first.seen.focused).toBe(0)
  expect(next.seen.focused).toBe(0)
  next.gone()
})

it('does nothing while Home has no composer', () => {
  writeAfresh(true)
  writeAfresh(false)
  expect(() => homeShown()).not.toThrow()
})
