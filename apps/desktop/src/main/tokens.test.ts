import * as NodePath from 'node:path'
import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import { inkFor, loadThemeSurfaces, surfaceFor } from './tokens.ts'

/**
 * The file the app reads at startup, not a fixture: the reader once asked the tokens for a shape
 * they had stopped using, and the installed app closed before its first window. A fixture written
 * beside the reader would have agreed with it and missed that.
 */
const shipped = NodePath.resolve(
  import.meta.dirname,
  '../../../../packages/design/tokens/src/tokens.css',
)

describe('desktop theme tokens', () => {
  it.effect('the shipped tokens give a page, an ink and a face accent for each scheme', () =>
    Effect.gen(function* () {
      const surfaces = yield* loadThemeSurfaces(shipped)
      expect(surfaceFor(surfaces, 'dark')).not.toBe(surfaceFor(surfaces, 'light'))
      expect(inkFor(surfaces, 'dark')).not.toBe(inkFor(surfaces, 'light'))
      // The accent comes from the first two `--primary` declarations; equal values mean the
      // reader took the same declaration for both schemes.
      expect(surfaces.face.dark).not.toBe(surfaces.face.light)
      // The form Windows' title-bar overlay reads; a CSS triplet left the glyphs black.
      expect(inkFor(surfaces, 'dark')).toMatch(/^#[0-9a-f]{6}$/u)
    }),
  )
})
