import { Schema } from 'effect'

/** A configured limit must fit one complete UTF-8 character; callers validate it before splitting. */
export const ChannelTextLimit = Schema.Int.check(Schema.isGreaterThanOrEqualTo(4)).pipe(
  Schema.brand('ChannelTextLimit'),
)
export type ChannelTextLimit = typeof ChannelTextLimit.Type

/** Preserve the words and link destinations while removing presentation that text messages cannot render. */
export const channelText = (markdown: string): string =>
  markdown
    .replace(/^```[^\n]*\n/gmu, '')
    .replace(/^```\s*$/gmu, '')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/gu, '$1 ($2)')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/gu, '$1 ($2)')
    .replace(/^ {0,3}#{1,6}\s+/gmu, '')
    .replace(/^\s*[-*+]\s+/gmu, '• ')
    .replace(/^>\s?/gmu, '')
    .replace(/\*\*([^*]+)\*\*/gu, '$1')
    .replace(/__([^_]+)__/gu, '$1')
    .replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/gu, '$1')
    .replace(/(?<!\w)_([^_\n]+)_(?!\w)/gu, '$1')
    .replace(/~~([^~]+)~~/gu, '$1')
    .replace(/`([^`\n]+)`/gu, '$1')
    .trim()

/** UTF-8 bytes conservatively bound character-based limits too; never split a surrogate pair. */
const prefixWithin = (text: string, maximumBytes: ChannelTextLimit): string => {
  const encoder = new TextEncoder()
  let bytes = 0
  let prefix = ''
  for (const character of text) {
    bytes += encoder.encode(character).length
    if (bytes > maximumBytes) break
    prefix += character
  }
  return prefix
}

/** Prefer a paragraph end, then a word boundary, then a complete Unicode character for a long word. */
const splitAt = (prefix: string): number => {
  const paragraph = prefix.lastIndexOf('\n\n')
  if (paragraph > 0) return paragraph
  const whitespace = Math.max(prefix.lastIndexOf(' '), prefix.lastIndexOf('\n'))
  return whitespace > 0 ? whitespace : prefix.length
}

/**
 * The caller supplies its verified provider limit in bytes; Spectrum itself exposes no limit.
 * Paragraphs stay intact whenever they fit. Oversized paragraphs and long single words are
 * bounded too, without corrupting emoji or discarding any non-whitespace words.
 */
export const splitChannelText = (
  text: string,
  maximumBytes: ChannelTextLimit,
): ReadonlyArray<string> => {
  const encoder = new TextEncoder()
  const parts: string[] = []
  let remaining = text.trim()
  while (encoder.encode(remaining).length > maximumBytes) {
    const prefix = prefixWithin(remaining, maximumBytes)
    const end = splitAt(prefix)
    parts.push(remaining.slice(0, end).trimEnd())
    remaining = remaining.slice(end).trimStart()
  }
  if (remaining.length > 0) parts.push(remaining)
  return parts
}
