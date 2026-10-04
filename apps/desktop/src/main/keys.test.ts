import * as Option from 'effect/Option'
import { describe, expect, it } from 'vitest'
import { keySequence } from './keys.ts'
import { InputSignal } from './touch.ts'

const linux = { mac: false }
const mac = { mac: true }

describe('the keys Vivid may press on a page', () => {
  it('Enter types a carriage return and is heard as Enter', () => {
    const sequence = Option.getOrThrow(keySequence('Enter', linux))
    expect(sequence.keyDown).toMatchObject({
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      text: '\r',
      modifiers: 0,
    })
    expect(sequence.keyUp).toMatchObject({ type: 'keyUp', key: 'Enter', code: 'Enter' })
    expect(sequence.signal).toEqual(InputSignal.cases.Key.make({ key: 'Enter', code: 'Enter' }))
  })

  it('a key that types nothing is a raw key down with no text', () => {
    const sequence = Option.getOrThrow(keySequence('ArrowDown', linux))
    expect(sequence.keyDown).toMatchObject({ type: 'rawKeyDown', windowsVirtualKeyCode: 40 })
    expect(sequence.keyDown).not.toHaveProperty('text')
  })

  it('Shift with a letter types the capital, and Shift with a digit its symbol', () => {
    expect(Option.getOrThrow(keySequence('Shift+a', linux)).keyDown).toMatchObject({
      key: 'A',
      code: 'KeyA',
      text: 'A',
      modifiers: 8,
    })
    expect(Option.getOrThrow(keySequence('Shift+1', linux)).keyDown).toMatchObject({
      key: '!',
      code: 'Digit1',
      text: '!',
    })
  })

  it('a chord types no text', () => {
    const sequence = Option.getOrThrow(keySequence('Control+a', linux))
    expect(sequence.keyDown).toMatchObject({ type: 'rawKeyDown', code: 'KeyA', modifiers: 2 })
    expect(sequence.keyDown).not.toHaveProperty('text')
    expect(sequence.keyDown.commands).toEqual([])
  })

  it('on a Mac, Control means Command and names the editing command', () => {
    expect(Option.getOrThrow(keySequence('Control+a', mac)).keyDown).toMatchObject({
      modifiers: 4,
      commands: ['selectAll'],
    })
    expect(Option.getOrThrow(keySequence('Control+Shift+v', mac)).keyDown).toMatchObject({
      modifiers: 12,
      key: 'V',
    })
  })

  it('the plus key is a key, not a separator', () => {
    expect(Option.getOrThrow(keySequence('+', linux)).keyDown).toMatchObject({
      key: '+',
      code: 'Equal',
      text: '+',
    })
    expect(Option.getOrThrow(keySequence('Shift++', linux)).keyDown).toMatchObject({
      key: '+',
      modifiers: 8,
    })
  })

  it('keys that close tabs, drive the browser or are not keys at all are refused', () => {
    for (const key of ['Control+w', 'Control+t', 'Alt+F4', 'F5', 'Meta+q', 'Control+Shift+i', ''])
      expect(Option.isNone(keySequence(key, linux))).toBe(true)
  })
})
