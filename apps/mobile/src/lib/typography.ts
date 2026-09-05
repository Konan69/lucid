import { nativeMetrics as m } from "@konan/design-tokens/native";

// Vivid web's semantic type scale, with native line-height values.
export const MOBILE_TYPOGRAPHY = {
  micro: { fontSize: m["type-meta"], lineHeight: 14 },
  caption: { fontSize: 12, lineHeight: 16 },
  label: { fontSize: m["type-label"], lineHeight: 18 },
  footnote: { fontWeight: m["weight-title"], fontSize: m["type-title"], lineHeight: 20 },
  body: { fontSize: m["type-body"], lineHeight: 23 },
  headline: { fontWeight: m["weight-title"], fontSize: m["type-dialog"], lineHeight: 23 },
  title: { fontWeight: m["weight-title"], fontSize: m["type-section"], lineHeight: 26 },
  largeTitle: { fontWeight: m["weight-title"], fontSize: m["type-page"], lineHeight: 30 },
  display: { fontWeight: m["weight-title"], fontSize: m["type-hero"], lineHeight: 35 },
} as const;

/** Shared geometry for dense, horizontally scrolling code surfaces. */
export const MOBILE_CODE_SURFACE = {
  rowHeight: 22,
  gutterWidth: 46,
  codePadding: 7,
  textVerticalInset: 2,
  fontSize: MOBILE_TYPOGRAPHY.caption.fontSize,
  lineNumberFontSize: MOBILE_TYPOGRAPHY.micro.fontSize,
} as const;
