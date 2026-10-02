/** Server-owned limits; programs cannot extend them with pragmas or tool arguments. */
export const budgets = {
  source: 16_384,
  seconds: 30,
  heap: 64 * 1024 * 1024,
  child: 256 * 1024 * 1024,
  calls: 25,
  frame: 262_144,
  wire: 263_168,
  data: 1_048_576,
  result: 32_768,
  depth: 32,
  processes: 2,
  pageBytes: 524_288,
  pageText: 24_576,
  pageSeconds: 10,
  redirects: 5,
} as const

/** UTF-8 bytes, rather than JavaScript code units, are the transport's resource unit. */
export const bytes = (text: string) => Buffer.byteLength(text, 'utf8')

/** Inspect nesting before JSON parsing/recursive schema decoding; quoted braces are just data. */
export function boundedNesting(text: string) {
  let depth = 0
  let quoted = false
  let escaped = false
  for (const char of text) {
    if (escaped) {
      escaped = false
      continue
    }
    if (quoted && char === '\\') {
      escaped = true
      continue
    }
    if (char === '"') quoted = !quoted
    if (quoted) continue
    if (char === '{' || char === '[') depth++
    if (char === '}' || char === ']') depth--
    if (depth > budgets.depth) return false
  }
  return true
}
