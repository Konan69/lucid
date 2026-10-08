import { Platform } from 'react-native'
import { nativeMetrics as m } from '@vivid/tokens/native'

/**
 * The phone's type scale: 11, 12, 13, 14, 16, 18, 21, 26, 30, each with its own line height.
 *
 * Ported from T3 Code mobile `global.css` (`--text-3xs` to `--text-3xl` and their line heights).
 * The steps keep Vivid's names, which say what the text is for and not how large it is.
 */
export const MOBILE_TYPOGRAPHY = {
  micro: { fontSize: 11, lineHeight: 14 },
  caption: { fontSize: 12, lineHeight: 16 },
  label: { fontSize: 13, lineHeight: 17 },
  footnote: { fontWeight: m['weight-title'], fontSize: 14, lineHeight: 19 },
  body: { fontSize: 16, lineHeight: 23 },
  /**
   * Long-form text read at arm's length: a conversation's words and what a Person types. The
   * same size as `body` on a 24-point line, which is the line the composer's height is built on.
   */
  reading: { fontSize: 16, lineHeight: 24 },
  /**
   * What is typed into a field. On an iPhone it is the reading size on a 20-point line, not 24.
   * UIKit puts a line's spare height above its letters, so 16-point text on a 24-point line is
   * typed two and a half points below the middle of its field, and below the placeholder, which
   * is centred: the owner's iPhone showed every field's text off-centre (7 October 2026). The
   * system font's own line at 16 points is 19.1, so on 20 the text is under half a point from
   * the middle. Android centres a line in its box and keeps the reading line.
   */
  typing: { fontSize: 16, lineHeight: Platform.OS === 'ios' ? 20 : 24 },
  headline: { fontWeight: m['weight-strong'], fontSize: 18, lineHeight: 23 },
  /** A screen's own name in its bar: the reference's heavy 18 (`GLASS_HEADER_OPTIONS`). */
  heading: { fontWeight: '800', fontSize: 18, lineHeight: 23 },
  title: { fontWeight: m['weight-strong'], fontSize: 21, lineHeight: 28 },
  largeTitle: { fontWeight: '700', fontSize: 26, lineHeight: 32, letterSpacing: -0.3 },
  display: { fontWeight: '700', fontSize: 30, lineHeight: 36, letterSpacing: -0.5 },
  /** The one line a screen opens with: the greeting. The top of the scale, heavy and drawn close. */
  opening: { fontWeight: '800', fontSize: 30, lineHeight: 36, letterSpacing: -0.6 },
} as const
