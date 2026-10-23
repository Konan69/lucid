import { nativeMetrics as m } from '@vivid/tokens/native'
import type { MarkdownStyle } from 'react-native-enriched-markdown'
import type { MOBILE_TYPOGRAPHY } from '../data/typography'
import type { Colors } from '../theme'

/** The steps of the type scale prose is set in: its text, its three headings, its code. */
export type ProseType = Pick<
  typeof MOBILE_TYPOGRAPHY,
  'reading' | 'title' | 'headline' | 'footnote'
>

/** The size and line of a step of the type scale, without its weight. */
const sized = (step: { readonly fontSize: number; readonly lineHeight: number }) => ({
  fontSize: step.fontSize,
  lineHeight: step.lineHeight,
})

/**
 * How Markdown is set on a phone: the native renderer's style for every element it can draw, in
 * the app's type scale and the palette in force.
 *
 * The shape is T3 Code mobile's `enrichedStyle` (`apps/mobile/src/native/EnrichedMarkdownText.tsx`
 * in the T3 Code fork): one body style shared by paragraphs, lists, quotes and tables, a block
 * frame shared by code and tables, and a style for each heading. What differs is where the values
 * come from. T3 Code is handed sizes and colours by each caller; Vivid has one type scale
 * (`MOBILE_TYPOGRAPHY`) and one palette (`useTheme`), and the spacing `Prose` already had (ten
 * points under a paragraph or a list, a heading closer to what follows it than to what precedes
 * it). Both are handed in, so this file draws on nothing of the platform and its output can be
 * checked without a phone.
 *
 * Every colour comes from the palette. The renderer's own defaults are a light palette written
 * into it (`normalizeMarkdownStyle.ts` in the package), so an element left unstyled would be drawn
 * dark on dark; each element that has a colour is given one here, including those a reply rarely
 * uses (a task list, a spoiler, a callout).
 *
 * Left out of T3 Code's style: `syntaxColors`, which are literal GitHub colours there and colour
 * nothing here because syntax colouring is not built in (`apps/mobile/deps/README.md`), and
 * `linkVariants`, which draw T3 Code's file and skill links as pills; Vivid has neither kind of
 * link.
 */
export const typeset = (c: Colors, type: ProseType): MarkdownStyle => {
  const body = {
    ...sized(type.reading),
    color: c.foreground,
    marginTop: 0,
    marginBottom: 10,
  }
  // The renderer takes a weight as text ("600"); the scale holds it as a number.
  const heading = (
    step: { readonly fontWeight: number; readonly fontSize: number; readonly lineHeight: number },
    space: { readonly marginTop: number; readonly marginBottom: number },
  ) => ({ ...sized(step), ...space, fontWeight: String(step.fontWeight), color: c.foreground })
  const small = heading(type.footnote, { marginTop: 4, marginBottom: 4 })
  // The frame of a block that stands apart from the text. The radius stays small: iOS clips a
  // table's square cell borders at the corners without drawing the arcs (T3 Code's note).
  const block = {
    marginTop: 4,
    marginBottom: 12,
    borderRadius: m['radius-row'],
    borderWidth: 1,
    borderColor: c.border,
  }
  return {
    paragraph: body,
    h1: heading(type.title, { marginTop: 6, marginBottom: 8 }),
    h2: heading(type.headline, { marginTop: 6, marginBottom: 6 }),
    h3: small,
    // Markdown has six levels and the scale has three for prose: the lower three read as the third.
    h4: small,
    h5: small,
    h6: small,
    link: { color: c['primary-text'], underline: true },
    // Inline code: the renderer's fixed-width face at the size of the text around it.
    code: { color: c.foreground, backgroundColor: c.subtle, borderColor: c['border-subtle'] },
    codeBlock: {
      ...block,
      ...sized(type.footnote),
      color: c['md-code-text'],
      backgroundColor: c['md-code-bg'],
      padding: 12,
    },
    blockquote: {
      ...body,
      backgroundColor: c.subtle,
      borderColor: c.border,
      borderWidth: 3,
      gapWidth: 12,
      // A callout (`> [!NOTE]`) is a quote in the colour of what it says.
      admonitions: {
        note: { color: c['status-info'], backgroundColor: c['status-info-soft'] },
        tip: { color: c['status-success'], backgroundColor: c['status-success-soft'] },
        important: { color: c['status-attention'], backgroundColor: c['status-attention-soft'] },
        warning: { color: c['status-approve'], backgroundColor: c['status-approve-soft'] },
        caution: { color: c['status-danger'], backgroundColor: c['status-danger-soft'] },
      },
    },
    list: {
      ...body,
      bulletColor: c['foreground-muted'],
      markerColor: c['foreground-muted'],
      gapWidth: 6,
    },
    thematicBreak: { color: c.separator, height: 1, marginTop: 8, marginBottom: 8 },
    table: {
      ...body,
      ...block,
      headerTextColor: c.foreground,
      headerBackgroundColor: c.subtle,
      rowEvenBackgroundColor: 'transparent',
      rowOddBackgroundColor: 'transparent',
      cellPaddingHorizontal: 10,
      cellPaddingVertical: 7,
    },
    taskList: {
      checkedColor: c.primary,
      checkmarkColor: c['primary-foreground'],
      checkedTextColor: c.foreground,
      borderColor: c['foreground-muted'],
      checkedStrikethrough: false,
    },
    strikethrough: { color: c['foreground-muted'] },
    underline: { color: c.foreground },
    spoiler: { color: c['foreground-muted'] },
    image: { borderRadius: m['radius-row'], marginTop: 4, marginBottom: 12 },
  }
}
