import { nativeMetrics as m } from '@vivid/tokens/native'
import type { MarkdownStyle } from 'react-native-enriched-markdown'
import type { MOBILE_TYPOGRAPHY } from '../data/typography'
import type { Colors } from '../theme'

/** The steps of the type scale prose is set in: its text, its three headings, its code. */
/** T3 Code mobile's code colours on a dark ground (GitHub's dark theme). */
const SYNTAX_DARK = {
  keyword: '#ff7b72',
  string: '#a5d6ff',
  number: '#79c0ff',
  constant: '#79c0ff',
  comment: '#8b949e',
  function: '#d2a8ff',
  type: '#ffa657',
  property: '#79c0ff',
  tag: '#7ee787',
  attribute: '#79c0ff',
}

/** T3 Code mobile's code colours on a light ground (GitHub's light theme). */
const SYNTAX_LIGHT = {
  keyword: '#cf222e',
  string: '#0a3069',
  number: '#0550ae',
  constant: '#0550ae',
  comment: '#6e7781',
  function: '#8250df',
  type: '#953800',
  property: '#0550ae',
  tag: '#116329',
  attribute: '#0550ae',
}

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
 * Code blocks are coloured by the renderer's own highlighter (`cpp/highlight/CodeBlockHighlighter.cpp`
 * in the package, there since 1.2.0-t3.11), in T3 Code mobile's colours (`syntaxColors` in
 * `apps/mobile/src/native/EnrichedMarkdownText.tsx`): GitHub's, one set for light and one for
 * dark. Until 26 October 2026 this file left them out on the belief that the package had no
 * highlighter, and every code block was one colour.
 *
 * Left out of T3 Code's style: `linkVariants`, which draw T3 Code's file and skill links as pills;
 * Vivid has neither kind of link.
 */
export const typeset = (c: Colors, dark: boolean, type: ProseType): MarkdownStyle => {
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
    // Inline code: the renderer's fixed-width face at the size of the text around it, on a pill of
    // ink at a seventh of its strength. `subtle` was all but the screen's own colour (#111 on #070707
    // in graphite dark, #f4ede9 on #f9f7f5 in ember light), so a pill could not be seen.
    code: {
      color: c.foreground,
      backgroundColor: c['wash-pressed'],
      borderColor: c['border-subtle'],
    },
    codeBlock: {
      ...block,
      ...sized(type.footnote),
      color: c['md-code-text'],
      backgroundColor: c['md-code-bg'],
      padding: 12,
      syntaxColors: dark ? SYNTAX_DARK : SYNTAX_LIGHT,
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
