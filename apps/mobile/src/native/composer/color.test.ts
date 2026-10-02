import { expect, it } from 'vitest'
import { composerColor } from './color.ts'
import { nativeTokens } from '../../../../../packages/design/tokens/src/native.ts'

it('writes an opaque color as the hex both native parsers read', () => {
  for (const platform of ['android', 'ios']) {
    expect(composerColor('rgb(252, 252, 252)', platform)).toBe('#fcfcfc')
    expect(composerColor('#6a5aff', platform)).toBe('#6a5aff')
  }
})

it("keeps a color's alpha, in each platform's own byte order", () => {
  // Android reads AARRGGBB; the iOS parser reads RRGGBBAA.
  expect(composerColor('rgba(252, 252, 252, 0.5)', 'android')).toBe('#80fcfcfc')
  expect(composerColor('rgba(252, 252, 252, 0.5)', 'ios')).toBe('#fcfcfc80')
  expect(composerColor('#11223344', 'android')).toBe('#44112233')
  expect(composerColor('#11223344', 'ios')).toBe('#11223344')
})

it('can write every ink the composer is painted in, in both appearances', () => {
  // The palette is free to change its colors; what must hold is that whatever it holds for the
  // composer's text, placeholder and accent is something the native editor can be handed. It used
  // to pin the palette's own values here, so a change of palette failed a test about hex.
  for (const palette of [nativeTokens.dark, nativeTokens.light]) {
    for (const ink of [palette.ink, palette['ink-3'], palette.accent]) {
      for (const platform of ['android', 'ios']) {
        expect(composerColor(ink, platform)).toMatch(/^#(?:[\da-f]{6}|[\da-f]{8})$/u)
      }
    }
  }
})
