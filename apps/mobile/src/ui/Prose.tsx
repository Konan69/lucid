import { useMemo } from 'react'
import { Linking } from 'react-native'
import { EnrichedMarkdownText } from 'react-native-enriched-markdown'
import { useTheme } from '../theme'
import { Recover } from './Recover'
import { typeset } from './typeset'
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

/**
 * Opens a link in the phone's browser, and answers whether it could be. Only a web page is ever
 * handed over: Markdown is written by Vivid or pasted in by a Person, and a link in it to another
 * app's scheme would open that app.
 */
export const openWebLink = (address: string): Promise<boolean> =>
  /^https?:\/\//iu.test(address)
    ? Linking.openURL(address).then(
        () => true,
        () => false,
      )
    : Promise.resolve(false)

/**
 * How the Markdown is read. Maths is not built into the app (`enriched-markdown` in
 * `package.json`), so a dollar sign is a dollar sign. One newline is a space, as Markdown has
 * it and as the web draws the same reply. A callout (`> [!NOTE]`) is drawn as one.
 */
const READING = { latexMath: false, hardSoftBreaks: false, admonitions: true } as const

/**
 * Markdown as formatted text, in the app's own type and palette: a reply of Vivid's in a Thread,
 * the steps of a skill. It is the one place the formatter is styled (`typeset`), so prose reads
 * the same wherever it appears.
 *
 * It is drawn by the platform's own text views (`react-native-enriched-markdown`,
 * `apps/mobile/deps/README.md`), not by React Native `Text` nodes built in JavaScript: the text
 * can be selected across paragraphs, and a reply that grows does not rebuild a tree of
 * components for every step of its reveal.
 *
 * Adapted from T3 Code mobile's `MobileEnrichedMarkdownText`
 * (`apps/mobile/src/native/EnrichedMarkdownText.tsx` in the T3 Code fork). Kept from it: the
 * GitHub flavour (tables, task lists, callouts), selectable text, maths off, task boxes that
 * cannot be ticked, a spoiler covered by a still shape, and the container that may shrink inside
 * a row. Left out, because Vivid has no model for them: its own rendering and signing of
 * pictures (`renderMedia`, `resolveImageSource`, `onDocumentAssets`, `onImagePress`), links
 * recognised in plain text and drawn as file or skill pills (`linkRecognition`, `linkVariants`,
 * `linkPillContent`), the long-press menus on a link, the clipboard fragment for its composer
 * (`selectionClipboard`), its rewriting of HTML in the Markdown (`markdownWithHtml`), and its
 * own selection colours on Android (the system's are kept).
 *
 * `fresh` says the text is still arriving: only then do the words it gains fade in
 * (`streamingAnimation`: the renderer fades what lies beyond the text it last drew, once, over a
 * fifth of a second, and not at all when the phone asks for less motion). Text that is all
 * there, a reply opened from history among it, is drawn as it is. T3 Code does not use the fade;
 * the property is the library's own (`MARKDOWN_STREAMING.md` in the package).
 *
 * Text the formatter cannot draw is still text: it is shown as it was written (`plain`), and
 * tried again when it changes. One malformed reply must not take the screen with it.
 *
 * A link is handed to `onLink` and never followed by the renderer itself: what a link opens (a
 * Library citation, a web page) is the screen's to decide. The renderer opens nothing on a
 * press; on an iPhone it would show a page's preview on a long press, which is the renderer
 * following the link, so that is off.
 */
export function Prose({
  text,
  plain,
  fresh,
  onLink,
}: {
  /** The Markdown to draw. */
  text: string
  /** The same words as they were written, shown if `text` cannot be drawn. */
  plain: string
  /** Whether `text` is still arriving, which is when the words it gains fade in. */
  fresh: boolean
  onLink: (address: string) => void
}) {
  const { colors } = useTheme()
  // One object per palette: the renderer sends a style to the native view when it is a new one.
  const style = useMemo(() => typeset(colors), [colors])
  return (
    <Recover from={text} fallback={<Plain text={plain} />}>
      <EnrichedMarkdownText
        markdown={text}
        markdownStyle={style}
        // A row gives prose the width beside a face; without these it would push past the edge.
        containerStyle={{ flexShrink: 1, minWidth: 0 }}
        flavor="github"
        md4cFlags={READING}
        selectable
        streamingAnimation={fresh}
        // The last paragraph keeps the space under it, as `Plain` does and as prose always has.
        allowTrailingMargin
        enableTaskListItemToggle={false}
        // The other cover is a field of moving particles, repainted for as long as it is shown.
        spoilerOverlay="solid"
        enableLinkPreview={false}
        onLinkPress={({ url }) => onLink(url)}
      />
    </Recover>
  )
}
