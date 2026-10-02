import { nativeMetrics as m } from '@vivid/tokens/native'

// Vivid web's semantic type scale, with native line-height values.
export const MOBILE_TYPOGRAPHY = {
  micro: { fontSize: m['type-meta'], lineHeight: 14 },
  caption: { fontSize: 12, lineHeight: 16 },
  label: { fontSize: m['type-label'], lineHeight: 18 },
  footnote: { fontWeight: m['weight-title'], fontSize: m['type-title'], lineHeight: 20 },
  body: { fontSize: m['type-body'], lineHeight: 23 },
  /** Long-form text read at arm's length: a conversation's words and what a Person types. */
  reading: { fontSize: 16, lineHeight: 24 },
  headline: { fontWeight: m['weight-title'], fontSize: m['type-dialog'], lineHeight: 23 },
  title: { fontWeight: m['weight-title'], fontSize: m['type-section'], lineHeight: 26 },
  largeTitle: { fontWeight: m['weight-title'], fontSize: m['type-page'], lineHeight: 30 },
  display: { fontWeight: m['weight-title'], fontSize: m['type-hero'], lineHeight: 35 },
  /**
   * The one line a screen opens with: the greeting. The web sets it in its display face at 40;
   * a phone sets it in the system's own face at the size the platform uses for a large title,
   * heavier and drawn a little closer together, the way large type wants to be.
   */
  opening: { fontWeight: m['weight-strong'], fontSize: 34, lineHeight: 40, letterSpacing: -0.6 },
} as const
