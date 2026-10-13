/**
 * Closing what a reply has opened and not yet closed, for as long as it is still arriving.
 *
 * A reply is formatted text that arrives a few characters at a time, so for a moment it holds
 * half of a mark: `**Why riv` before its closing `**`, a code fence with no end, a link whose
 * address is still coming. Formatted as it stands, the half mark is drawn as literal asterisks
 * and then, when its other half lands, the same words are drawn again inside a new element.
 * The headless pass of 13 October 2026 measured both: the first text on screen was `**`, and a
 * reply's opening bold title faded in twice because its element was replaced.
 *
 * The design is Streamdown's `remend` (the AI SDK's streaming Markdown component): complete
 * the unfinished mark before formatting, so the structure is the same from the first character
 * to the last. Only a reply still arriving is mended; a finished one is formatted as written.
 * This is the part of `remend` Vivid's replies need: fences, inline code, bold and links.
 */

const FENCE = /^\s{0,3}(```|~~~)/u

/** Whether the text ends inside a code fence, where nothing else is a mark. */
const inFence = (text: string): boolean =>
  text.split('\n').filter((line) => FENCE.test(line)).length % 2 === 1

/** How many times `mark` occurs in `text`. */
const count = (text: string, mark: string): number => text.split(mark).length - 1

/**
 * The last paragraph with its unfinished inline marks completed or, where a mark has nothing in
 * it yet, taken off: a bare `**` or `` ` `` at the very end says nothing until words follow.
 */
const mendInline = (paragraph: string): string => {
  // A link whose address has not closed is shown as its words alone.
  const linked = paragraph.replace(/\[([^\]\n]*)\]\([^)\n]*$/u, '$1')
  // Inline code first: an asterisk inside it is not a mark.
  const coded = count(linked, '`') % 2 === 1 ? closing(linked, '`') : linked
  const outsideCode = coded.replace(/`[^`]*`/gu, '')
  return count(outsideCode, '**') % 2 === 1 ? closing(coded, '**') : coded
}

/** Closes an open `mark`, or drops it when it is the last thing written. */
const closing = (text: string, mark: string): string =>
  text.endsWith(mark) ? text.slice(0, -mark.length) : `${text}${mark}`

/**
 * `text` with whatever it has left open closed. Marks are only ever open in the paragraph being
 * written, so everything before the last blank line is returned untouched.
 */
export const mended = (text: string): string => {
  if (inFence(text)) return `${text}\n\`\`\``
  const at = text.lastIndexOf('\n\n')
  const head = at < 0 ? '' : text.slice(0, at + 2)
  return `${head}${mendInline(text.slice(head.length))}`
}
