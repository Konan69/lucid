/**
 * How much of a reply that is still arriving will not change again.
 *
 * A phone formats a reply with a renderer that rebuilds every element each time the text
 * changes, and a reply being let out changes up to 25 times a second (`reveal.ts`). Formatting
 * the whole reply on each of those costs more the longer it gets, which is the opposite of
 * smooth. What was written before the paragraph now arriving is finished, so a screen draws it
 * once and redraws only the rest. The idea is Streamdown's block memoization (the AI SDK's
 * streaming Markdown component splits a reply into blocks and re-renders only the last).
 */
import { FENCE } from './mend.js'

/**
 * A line that carries on what was before it across a blank line: an item of the same list, or
 * text indented under one. Cutting in front of it would start a second list and number it anew.
 * A list's first item reads the same, so the line that leads into a list stays with it.
 */
const CARRIES_ON = /^(?:\s|[-*+]\s|\d+[.)]\s)/u

/**
 * The fence the scan is inside once `line` is read. A fence closes only on its own kind of
 * marker, at least as long as the one that opened it (`mend.ts` `openFence`).
 */
const after = (fence: string, line: string): string => {
  const found = FENCE.exec(line)
  if (found === null) return fence
  const [, , marker = ''] = found
  if (fence === '') return marker
  return marker.startsWith(fence) ? '' : fence
}

/**
 * Where the finished part of `text` ends: the start of the last block that follows a blank line,
 * outside a code fence, and does not carry on a list. Everything before that place is drawn the
 * same however the reply goes on. It is 0 when the reply is still on its first block.
 */
const settledAt = (text: string): number => {
  // The marker of the fence the scan is inside, or empty outside one.
  let fence = ''
  let blank = false
  let at = 0
  let settled = 0
  for (const line of text.split('\n')) {
    // Read before this line moves it: a line that closes a fence is still the fence's own.
    const inside = fence !== ''
    const empty = line.trim() === ''
    if (blank && !empty && !inside && !CARRIES_ON.test(line)) settled = at
    fence = after(fence, line)
    blank = empty && !inside
    at += line.length + 1
  }
  return Math.min(settled, text.length)
}
