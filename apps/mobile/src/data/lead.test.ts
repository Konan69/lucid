import { expect, it } from 'vitest'
import { leadOf, reachOf } from './lead.ts'

const stack = (...names: ReadonlyArray<string>) => names.map((name) => ({ name }))

it('leads Home and a Thread opened from Home with the drawer', () => {
  expect(leadOf(stack('Home'), 0)).toBe('drawer')
  expect(leadOf(stack('Home', 'Chat'), 1)).toBe('drawer')
})

it('keeps the drawer on a Thread beside Home while something covers it', () => {
  // The Computer is pushed over the Thread; coming back, the Thread's bar must not have changed.
  expect(leadOf(stack('Home', 'Chat', 'Computer'), 1)).toBe('drawer')
})

it('leads a Thread opened from another place with the way back', () => {
  expect(leadOf(stack('Home', 'Notifications', 'Chat'), 2)).toBe('back')
  expect(leadOf(stack('Home', 'Projects', 'Project', 'Chat'), 3)).toBe('back')
})

it('leads every other screen with the way back', () => {
  expect(leadOf(stack('Home', 'Settings'), 1)).toBe('back')
  expect(leadOf(stack('Home', 'Chat', 'Computer'), 2)).toBe('back')
})

it('opens the drawer from anywhere on Home and only from the edge of a Thread beside it', () => {
  expect(reachOf(stack('Home'), 0)).toBe('anywhere')
  expect(reachOf(stack('Home', 'Chat'), 1)).toBe('edge')
})

it('gives the drawer no drag on a screen it is not beside', () => {
  expect(reachOf(stack('Home', 'Settings'), 1)).toBe('none')
  expect(reachOf(stack('Home', 'Notifications', 'Chat'), 2)).toBe('none')
  expect(reachOf(stack('Home', 'Chat', 'Computer'), 2)).toBe('none')
})

it('answers for a place the stack does not have', () => {
  expect(leadOf(stack('Home'), 3)).toBe('back')
  expect(reachOf(stack(), 0)).toBe('none')
})
