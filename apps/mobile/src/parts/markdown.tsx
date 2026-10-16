import { Fragment, type ReactNode } from 'react'
import { StyleSheet, Text, type StyleProp, type TextStyle } from 'react-native'
import { webUrl, type Skin } from './style'
import { MONO } from '../ui/ui'

/**
 * The vendor's inline Markdown runner (`apps/web/vendor/openui/markdown.tsx`), drawn as React
 * Native text runs instead of DOM elements. The same inline grammar, in the same order of
 * precedence, and it never injects HTML: what the model wrote is read as text and drawn as
 * styled runs.
 *
 * A link opens in the browser, the way the app's own `Prose` opens one
 * (`apps/mobile/src/data/links.ts` `openWebLink`). The URL is checked the same way the web
 * checks it — absolute http(s) only — and a model-written `javascript:` or relative address is
 * drawn as plain text, not a link.
 */
const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*|__[^_\n]+?__)|(~~[^~\n]+?~~)|(\*[^*\s][^*\n]*?\*|_[^_\s][^_\n]*?_)|(\[[^\]\n]+\]\([^)\s]+\))/

export interface RunStyle {
  readonly base: StyleProp<TextStyle>
  readonly code: StyleProp<TextStyle>
  readonly strong: StyleProp<TextStyle>
  readonly strike: StyleProp<TextStyle>
  readonly emphasis: StyleProp<TextStyle>
  readonly link: StyleProp<TextStyle>
  onOpen: (url: string) => void
}

export function inline(text: string, style: RunStyle, key = 'i'): ReactNode {
  const out: ReactNode[] = []
  let rest = text
  let n = 0
  while (rest) {
    const found = INLINE.exec(rest)
    if (!found) {
      out.push(
        <Text key={`${key}-t${n}`} style={style.base}>
          {rest}
        </Text>,
      )
      break
    }
    if (found.index)
      out.push(
        <Text key={`${key}-p${n}`} style={style.base}>
          {rest.slice(0, found.index)}
        </Text>,
      )
    const token = found[0]
    const k = `${key}-${n++}`
    if (found[1])
      out.push(
        <Text key={k} style={[style.base, style.code]}>
          {token.slice(1, -1)}
        </Text>,
      )
    else if (found[2])
      out.push(
        <Text key={k} style={[style.base, style.strong]}>
          {inline(token.slice(2, -2), style, k)}
        </Text>,
      )
    else if (found[3])
      out.push(
        <Text key={k} style={[style.base, style.strike]}>
          {inline(token.slice(2, -2), style, k)}
        </Text>,
      )
    else if (found[4])
      out.push(
        <Text key={k} style={[style.base, style.emphasis]}>
          {inline(token.slice(1, -1), style, k)}
        </Text>,
      )
    else {
      const close = token.indexOf('](')
      const label = token.slice(1, close)
      const href = webUrl(token.slice(close + 2, -1))
      // A link is text that opens, and its press is its own, not a control inside a control: a
      // nested press would answer the wrong target (React Native gives no `closest()`).
      out.push(
        href ? (
          <Text
            key={k}
            style={[style.base, style.link]}
            onPress={() => {
              if (href) style.onOpen(href)
            }}
          >
            {inline(label, style, k)}
          </Text>
        ) : (
          <Fragment key={k}>{inline(label, style, k)}</Fragment>
        ),
      )
    }
    rest = rest.slice(found.index + token.length)
  }
  return out.length === 0 ? null : out
}

/**
 * The runs' own styles, from the skin in force: the colour the part set (or not), a wash of the
 * display's tint behind a run of code in the display's fixed-width face, and Vivid's colour on a
 * link.
 */
export const runStyles = (skin: Skin, onOpen: (url: string) => void): RunStyle => ({
  base: StyleSheet.create({ base: {} }).base,
  code: { backgroundColor: skin.codeBackground, fontFamily: MONO },
  strong: { fontWeight: '600' },
  strike: { textDecorationLine: 'line-through' },
  emphasis: { fontStyle: 'italic' },
  link: { color: skin.accent, textDecorationLine: 'underline' },
  onOpen,
})
