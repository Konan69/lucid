import { nativeThemes } from '@vivid/tokens/native'
import { describe, expect, it } from 'vitest'
import { typeset, type ProseType } from './typeset'

/** The four steps prose is set in, as the phone's scale has them (`data/typography.ts`). */
const type: ProseType = {
  reading: { fontSize: 16, lineHeight: 24 },
  title: { fontWeight: 600, fontSize: 21, lineHeight: 28 },
  headline: { fontWeight: 600, fontSize: 18, lineHeight: 23 },
  footnote: { fontWeight: 500, fontSize: 14, lineHeight: 19 },
}

const palettes = Object.values(nativeThemes).flatMap((family) => [family.dark, family.light])

/** Every colour written in a style, at any depth: the values of its `color` and `...Color` keys. */
const coloursIn = (written: string): ReadonlyArray<string> =>
  Array.from(written.matchAll(/"\w*color":"([^"]*)"/giu), ([, colour]) => String(colour))

describe('typeset', () => {
  it('takes every colour from the palette in force', () => {
    for (const palette of palettes) {
      const allowed = new Set([...Object.values(palette), 'transparent'])
      const written = coloursIn(JSON.stringify(typeset(palette, type)))
      expect(written.length).toBeGreaterThan(0)
      expect(written.filter((colour) => !allowed.has(colour))).toEqual([])
    }
  })

  // The renderer's own defaults are a light palette: an element with no colour of ours is drawn
  // in it, dark on dark. These are the elements whose default names a colour.
  it('colours every element the renderer would draw in its own palette', () => {
    const style = typeset(nativeThemes.graphite.dark, type)
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
    ).filter((element) => coloursIn(String(JSON.stringify(style[element]))).length === 0)
    expect(uncoloured).toEqual([])
  })
})
