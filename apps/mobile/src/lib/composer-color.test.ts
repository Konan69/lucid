import { expect, it } from 'vitest'
import { composerColor } from '../native/composerColor.ts'
import { nativeTokens } from '../../../../packages/design-tokens/src/native.ts'

it('native composer gets readable Vivid text in both appearances', () => {
  for (const platform of ['android', 'ios']) {
    expect(composerColor(nativeTokens.dark.ink, platform)).toBe('#fcfcfc')
    expect(composerColor(nativeTokens.light.ink, platform)).toBe('#141414')
    expect(composerColor(nativeTokens.dark.accent, platform)).toBe('#7c6cff')
  }
})

it("native placeholder preserves alpha with each platform's hex byte order", () => {
  expect(composerColor(nativeTokens.dark['ink-3'], 'android')).toBe('#6bfcfcfc')
  expect(composerColor(nativeTokens.dark['ink-3'], 'ios')).toBe('#fcfcfc6b')
  expect(composerColor('#11223344', 'android')).toBe('#44112233')
  expect(composerColor('#11223344', 'ios')).toBe('#11223344')
})
