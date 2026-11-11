#!/usr/bin/env node
/**
 * Every sentence the code writes for a Person is in the Person's words.
 *
 * Vivid's replies said "the connection never finished authorizing, so it loads zero tools" and
 * "the check-in is armed" (production, 1 to 11 November 2026), because the text Vivid is handed
 * is written in the system's language. Sentences meant for the Person are now typed apart
 * (`plain(...)` in `packages/agent/runtime/src/tools/views.ts`) and the prompt's translation
 * examples show the plain form after an arrow. This check reads both and fails on any system word
 * from `packages/agent/runtime/src/agents/system.json`, the same list the server counts settled
 * replies against (`Message.voice`), so the code and the count share one vocabulary. The message names the word and
 * what to say instead.
 */
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'

const SystemWords = Schema.fromJsonString(
  Schema.Struct({
    words: Schema.Array(
      Schema.Struct({ id: Schema.String, pattern: Schema.String, instead: Schema.String }),
    ),
  }),
)
const vocabulary = Result.getOrThrow(
  Schema.decodeUnknownResult(SystemWords)(
    NodeFS.readFileSync('packages/agent/runtime/src/agents/system.json', 'utf8'),
  ),
).words.map((word) => Object.assign({ regex: new RegExp(word.pattern, 'iu') }, word))

/** Person sentences in code: the string literal passed to plain(...). */
const PLAIN_CALL = /\bplain\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1\s*\)/gu
/** The plain side of a translation example in the prompt: → "…". */
const ARROW = /→ "((?:\\.|[^"\\])*)"/gu

const files = NodeChildProcess.execFileSync(
  'git',
  ['ls-files', 'packages/agent/runtime/src/**/*.ts', 'packages/agent/runtime/src/*.ts'],
  { encoding: 'utf8' },
)
  .split('\n')
  .filter((file) => file.length > 0 && !file.endsWith('.test.ts'))

/** Every Person sentence in one file with its line: plain(...) literals and → examples. */
const sentencesOf = (file) => {
  const source = NodeFS.readFileSync(file, 'utf8')
  const lineOf = (index) => source.slice(0, index).split('\n').length
  return [
    ...[...source.matchAll(PLAIN_CALL)].map((match) => ({
      text: match[2],
      line: lineOf(match.index),
    })),
    ...[...source.matchAll(ARROW)].map((match) => ({ text: match[1], line: lineOf(match.index) })),
  ]
}

const failures = files.flatMap((file) =>
  sentencesOf(file).flatMap(({ text, line }) =>
    vocabulary
      .filter((word) => word.regex.test(text))
      .map(
        (word) =>
          `${file}:${line} says "${text}" to a Person with the system word /${word.pattern}/; say ${word.instead}.`,
      ),
  ),
)

if (failures.length > 0) {
  console.error(`Person sentences use system words (${failures.length}):\n${failures.join('\n')}`)
  process.exit(1)
}
console.log('Person sentences are in the Person’s words.')
