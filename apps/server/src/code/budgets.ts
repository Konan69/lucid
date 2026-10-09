import { CodeTiming } from '@vivid/contracts/code'

/** Server-owned limits; programs cannot extend them with pragmas or tool arguments. */
export const budgets = {
  source: 16_384,
  seconds: CodeTiming.seconds,
  // Statements and expressions one program may evaluate. The interpreter runs on the server's
  // own thread at about a million steps a second (measured 9 October 2026), so this is about two
  // seconds of that thread, taken in turns with everything else.
  steps: 2_000_000,
  // Characters of strings and items of arrays, objects, Maps and Sets one program may make.
  growth: 16_777_216,
  calls: 100,
  frame: 262_144,
  data: 4_194_304,
  result: 32_768,
  logs: 8_192,
  // Programs this server interprets at once.
  processes: 4,
  pages: 8,
  pageBytes: 524_288,
  pageText: 24_576,
  pageSeconds: 10,
  redirects: 5,
} as const

/** UTF-8 bytes, rather than JavaScript code units, are the transport's resource unit. */
export const bytes = (text: string) => Buffer.byteLength(text, 'utf8')
