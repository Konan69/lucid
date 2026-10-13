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

/** A line that opens or closes a fence: its indent, and its run of backticks or tildes. */
const FENCE = /^(\s*)(`{3,}|~{3,})/u

/**
 * The fence the text ends inside, when it ends inside one: the indent and marker that opened it.
 * A fence closes only on its own kind of marker, at least as long as the one that opened it, so
 * tildes inside a backtick fence, or a shorter run, are its contents.
 */
const openFence = (text: string): { readonly indent: string; readonly marker: string } | null => {
  let open: { readonly indent: string; readonly marker: string } | null = null
  for (const line of text.split('\n')) {
    const found = FENCE.exec(line)
    if (found === null) continue
    const [, indent = '', marker = ''] = found
    if (open === null) open = { indent, marker }
    else if (marker.startsWith(open.marker)) open = null
  }
  return open
}

/** How many times `mark` occurs in `text`. */
const count = (text: string, mark: string): number => text.split(mark).length - 1

/** Closes an open `mark`, or drops it when it is the last thing written. */
const closing = (text: string, mark: string): string =>
  text.endsWith(mark) ? text.slice(0, -mark.length) : `${text}${mark}`

/** `text` without its finished code spans and link addresses, where an asterisk is not a mark. */
const prose = (text: string): string =>
  text.replace(/(`+)[^`]*?\1/gu, '').replace(/\]\([^)\n]*\)/gu, ']')

/**
 * The last paragraph with its unfinished inline marks completed or, where a mark has nothing in
 * it yet, taken off: a bare `**` or `` ` `` at the very end says nothing until words follow.
 * Code is settled first, and while a code span is open nothing after it is read as a mark.
 */
const mendInline = (paragraph: string): string => {
  if (count(prose(paragraph), '`') % 2 === 1) return closing(paragraph, '`')
  // A link whose address has not closed is shown as its words alone.
  const linked = paragraph.replace(/\[([^\]\n`]*)\]\([^)\n]*$/u, '$1')
  return count(prose(linked), '**') % 2 === 1 ? closing(linked, '**') : linked
}

/**
 * `text` with whatever it has left open closed. Marks are only ever open in the paragraph being
 * written, so everything before the last blank line is returned untouched.
 */
export const mended = (text: string): string => {
  const fence = openFence(text)
  if (fence !== null) return `${text}\n${fence.indent}${fence.marker}`
  const at = text.lastIndexOf('\n\n')
  const head = at < 0 ? '' : text.slice(0, at + 2)
  return `${head}${mendInline(text.slice(head.length))}`
}
