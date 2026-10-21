import { CodeTiming } from '@vivid/contracts/code'

/** Server-owned limits; programs cannot extend them with pragmas or tool arguments. */
export const budgets = {
  source: 16_384,
  seconds: CodeTiming.seconds,
  calls: 100,
  frame: 262_144,
  wire: 263_168,
  data: 4_194_304,
  result: 32_768,
  logs: 8_192,
  depth: 32,
  // Programs this server follows at once, each an open connection to a Computer.
  processes: 4,
  // Display rendering has separate, smaller admission and never claims Vivid's per-Thread slot.
  displays: 2,
  // Answers on their way to one program at once. Each is a request to the Computer's provider.
  replies: 8,
  pages: 8,
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
