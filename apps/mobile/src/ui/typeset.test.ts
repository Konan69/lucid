import { nativeThemes } from '@vivid/tokens/native'
import { Predicate } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { typeset } from './typeset'

// The type scale reads the platform for one step (`typing`); nothing here draws.
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))

const palettes = Object.values(nativeThemes).flatMap((family) => [family.dark, family.light])

/** Every colour a style names, at any depth: the values of its `color` and `...Color` keys. */
const coloursIn = (style: object): ReadonlyArray<string> =>
  Object.entries(style).flatMap(([key, held]) => {
    if (Predicate.isObject(held)) return coloursIn(held)
    return Predicate.isString(held) && /color$/iu.test(key) ? [held] : []
  })

describe('typeset', () => {
  it('takes every colour from the palette in force', () => {
    for (const palette of palettes) {
      const allowed = new Set([...Object.values(palette), 'transparent'])
      const foreign = coloursIn(typeset(palette)).filter((colour) => !allowed.has(colour))
      expect(foreign).toEqual([])
    }
  })

  // The renderer's own defaults are a light palette: an element with no colour of ours is drawn
  // in it, dark on dark. These are the elements whose default names a colour.
  it('colours every element the renderer would draw in its own palette', () => {
    const style = typeset(nativeThemes.graphite.dark)
    const uncoloured = (
      [
        'paragraph',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'blockquote',
        'list',
        'codeBlock',
        'link',
        'code',
        'thematicBreak',
        'table',
        'taskList',
        'strikethrough',
        'underline',
        'spoiler',
      ] as const
    ).filter((element) => coloursIn(style[element] ?? {}).length === 0)
    expect(uncoloured).toEqual([])
  })
})
