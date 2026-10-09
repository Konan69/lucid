import { CodeTiming } from '@vivid/contracts/code'

/** Server-owned limits; programs cannot extend them with pragmas or tool arguments. */
export const budgets = {
  source: 16_384,
  seconds: CodeTiming.seconds,
  // Statements and expressions one program may evaluate: about two seconds of its own thread
  // (a million steps a second, measured 9 October 2026). It ends a runaway program with a
  // message the model can act on, long before the deadline would.
  steps: 2_000_000,
  // Characters of strings and items of arrays, objects, Maps and Sets one program may make.
  growth: 16_777_216,
  // The heap of the thread one program is interpreted on, in MiB (Node `resourceLimits`).
  heap: 256,
  calls: 100,
  frame: 262_144,
  // The longest message a program's thread may send: one call's arguments and their envelope.
  wire: 263_168,
  data: 4_194_304,
  result: 32_768,
  logs: 8_192,
  // Programs this server interprets at once.
  processes: 4,
  // Calls of one program at work at the same time.
  together: 8,
  pages: 8,
  pageBytes: 524_288,
  pageText: 24_576,
  pageSeconds: 10,
  redirects: 5,
} as const

/** UTF-8 bytes, rather than JavaScript code units, are the transport's resource unit. */
export const bytes = (text: string) => Buffer.byteLength(text, 'utf8')
