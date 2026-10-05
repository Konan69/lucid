import * as NodeFS from 'node:fs'
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
  it.effect('the shipped tokens give the native window a page and an ink for each scheme', () =>
    Effect.gen(function* () {
      const surfaces = yield* loadThemeSurfaces(shipped)
      expect(surfaceFor(surfaces, 'dark')).not.toBe(surfaceFor(surfaces, 'light'))
      expect(inkFor(surfaces, 'dark')).not.toBe(inkFor(surfaces, 'light'))
      // The form Windows' title-bar overlay reads; a CSS triplet left the glyphs black.
      expect(inkFor(surfaces, 'dark')).toMatch(/^#[0-9a-f]{6}$/u)
    }),
  )

  it.effect('the shipped tokens give Vivid’s face its accent for each scheme and its eyes', () =>
    Effect.gen(function* () {
      const css = yield* Effect.sync(() => NodeFS.readFileSync(shipped, 'utf8'))
      const { face } = yield* loadThemeSurfaces(shipped)
      // The declarations themselves, not a prefix of a longer name such as `--primary-text`.
      expect(css).toContain(`--primary: ${face.dark};`)
      expect(css).toContain(`--primary: ${face.light};`)
      expect(css).toContain(`--face-eye: ${face.eye};`)
      expect(face.dark).not.toBe(face.light)
    }),
  )
})
