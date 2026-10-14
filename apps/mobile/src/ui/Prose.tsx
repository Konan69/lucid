import Markdown from 'react-native-markdown-display'
import { MOBILE_TYPOGRAPHY } from '../data/typography'
import { useTheme } from '../theme'
import { Recover } from './Recover'
import { Label } from './ui'

/**
 * Text as it was written, for when it cannot be formatted. It keeps the reading size and the
 * space a formatted paragraph leaves under it, so nothing jumps if the same text draws properly
 * once more of it has arrived.
 */
function Plain({ text }: { text: string }) {
  return (
    <Label selectable size="reading" style={{ marginBottom: 10 }}>
      {text}
    </Label>
  )
}

export { openWebLink } from '../data/links'

/**
 * Markdown as formatted text, in the app's own type and palette: a reply of Vivid's in a Thread,
 * the steps of a skill. It is the one place the formatter is styled, so prose reads the same
 * wherever it appears.
 *
 * Text the formatter cannot draw is still text: it is shown as it was written (`plain`), and
 * tried again when it changes. One malformed reply must not take the screen with it.
 *
 * A link is handed to `onLink` and never followed by the renderer itself: what a link opens (a
 * Library citation, a web page) is the screen's to decide.
 */
export function Prose({
  text,
  plain,
  onLink,
}: {
  /** The Markdown to draw. */
  text: string
  /** The same words as they were written, shown if `text` cannot be drawn. */
  plain: string
  onLink: (address: string) => void
}) {
  const { colors: c } = useTheme()
  return (
    <Recover from={text} fallback={<Plain text={plain} />}>
      <Markdown
        onLinkPress={(address) => {
          onLink(address)
          // The screen has handled the link; the renderer must not also follow it.
          return false
        }}
        style={{
          body: { color: c.foreground, ...MOBILE_TYPOGRAPHY.reading },
          paragraph: { marginTop: 0, marginBottom: 10 },
          heading1: { ...MOBILE_TYPOGRAPHY.title, marginTop: 6, marginBottom: 8 },
          heading2: { ...MOBILE_TYPOGRAPHY.headline, marginTop: 6, marginBottom: 6 },
          heading3: { ...MOBILE_TYPOGRAPHY.footnote, marginTop: 4, marginBottom: 4 },
          bullet_list: { marginBottom: 10 },
          ordered_list: { marginBottom: 10 },
          code_inline: { backgroundColor: c.subtle, color: c.foreground },
          fence: { backgroundColor: c['md-code-bg'], color: c.foreground, borderColor: c.border },
          code_block: {
            backgroundColor: c['md-code-bg'],
            color: c.foreground,
            borderColor: c.border,
          },
          link: { color: c['primary-text'] },
          blockquote: { backgroundColor: c.subtle, borderColor: c.border },
          hr: { backgroundColor: c.separator },
          table: { borderColor: c.border },
          tr: { borderColor: c.border },
        }}
      >
        {text}
      </Markdown>
    </Recover>
  )
}
