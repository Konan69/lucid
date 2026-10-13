import type { Options } from 'react-markdown'

/**
 * Words that fade in as a reply is written.
 *
 * While a reply is still arriving, every word of its formatted text is put in its own span that
 * fades up from clear (`word-in`, `styles/motion.css`). React keeps a span it already drew and
 * only mounts the ones that are new, and a CSS animation runs once, when its element is
 * mounted: so the words already on the page stay still and only the newest fade in. Where the
 * formatter replaces an element as more arrives (a link's words when its address closes, a list
 * that becomes a loose one), the words in it are mounted again and fade once more; `mended`
 * (`@vivid/state`) removes the common cases and those two remain. This is the
 * look of a stream in ChatGPT and the AI SDK's `Streamdown` (`animated`), done with the same
 * mechanism: a rehype step over the formatted tree, no timers and no state.
 *
 * Code is left alone: a span per word inside `pre` or `code` would break its highlighting and
 * its copy. A reply that has finished is drawn without the spans (`Markdown`'s `fresh`), so a
 * long Thread does not carry a span for every word it ever said.
 */

/** The part of a formatted tree this step reads: text, and elements with children. */
interface Text {
  readonly type: 'text'
  readonly value: string
}
interface Element {
  readonly type: 'element'
  readonly tagName: string
  /** Only what this step writes; an element it only passes through keeps whatever it had. */
  readonly properties: { readonly className?: ReadonlyArray<string> }
  children: Array<Node>
}
interface Other {
  readonly type: 'comment' | 'doctype' | 'raw'
}
type Node = Text | Element | Other
interface Root {
  readonly type: 'root'
  children: Array<Node>
}

/** Text kept as written: one span per word here would change what is copied and highlighted. */
const VERBATIM = new Set(['pre', 'code'])

/** A word with the space after it, so a line breaks between spans exactly as it did before. */
const WORDS = /\S+\s*|\s+/gu

const wordsOf = (text: Text): ReadonlyArray<Node> =>
  (text.value.match(WORDS) ?? []).map((word): Element => ({
    type: 'element',
    tagName: 'span',
    properties: { className: ['word-in'] },
    children: [{ type: 'text', value: word }],
  }))

/** Replaces each run of text under `parent` with its words, leaving verbatim elements whole. */
const fade = (parent: Root | Element): void => {
  parent.children = parent.children.flatMap((child): ReadonlyArray<Node> => {
    // Space between blocks, rows and items is structure, not words: a span there is invalid
    // under a table or a list and undoes the formatter's own removal of it.
    if (child.type === 'text') return child.value.trim() === '' ? [child] : wordsOf(child)
    if (child.type === 'element' && !VERBATIM.has(child.tagName)) fade(child)
    return [child]
  })
}

/** The rehype step, in the form `react-markdown` takes. */
export const fadeWords: NonNullable<Options['rehypePlugins']>[number] = () => (tree: Root) =>
  fade(tree)
