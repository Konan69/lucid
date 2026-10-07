import { escapeLiteral } from 'pg'
import { expect, it } from 'vitest'
import { quoteLiteral } from './literal.ts'

/** Equality with the installed driver's public formatter, including its leading
 * space before E, is the transport contract; real SQL string modes are exercised
 * by quoting.test.ts. Long runs detect replacement or delimiter edge cases. */
it.each([
  '',
  'ordinary',
  "'",
  '\\',
  "'\\'\\",
  "x'); DROP TABLE entries; --",
  '😀 é 漢',
  '\ud800',
  '\u0000',
  "'".repeat(32_768),
  '\\'.repeat(32_768),
  "A'\\".repeat(32_768),
])('matches pg literal formatting for awkward text (%#)', (text) => {
  expect(quoteLiteral(text)).toBe(escapeLiteral(text))
})
