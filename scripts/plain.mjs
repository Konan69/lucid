#!/usr/bin/env node
/**
 * Every sentence the code writes for a Person is in the Person's words.
 *
 * Vivid's replies said "the connection never finished authorizing, so it loads zero tools" and
 * "the check-in is armed" (production, 1 to 11 November 2026), because the text Vivid is handed
 * is written in the system's language. Sentences meant for the Person are now typed apart
 * (`plain(...)` in `packages/agent/runtime/src/tools/views.ts`) and the prompt's translation
 * examples show the plain form after an arrow. This check reads both and fails on any system word
 * from `packages/agent/runtime/src/agents/system.json`, the same list the runtime uses to flag
 * live replies, so the code and the callout share one vocabulary. The message names the word and
 * what to say instead.
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const vocabulary = JSON.parse(
  readFileSync('packages/agent/runtime/src/agents/system.json', 'utf8'),
).words.map((word) => ({ ...word, regex: new RegExp(word.pattern, 'iu') }))

/** Person sentences in code: the string literal passed to plain(...). */
const PLAIN_CALL = /\bplain\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1\s*\)/gu
/** The plain side of a translation example in the prompt: → "…". */
const ARROW = /→ "((?:\\.|[^"\\])*)"/gu

const files = execFileSync(
  'git',
  ['ls-files', 'packages/agent/runtime/src/**/*.ts', 'packages/agent/runtime/src/*.ts'],
  { encoding: 'utf8' },
)
  .split('\n')
  .filter((file) => file.length > 0 && !file.endsWith('.test.ts'))

const failures = []
for (const file of files) {
  const source = readFileSync(file, 'utf8')
  for (const pattern of [PLAIN_CALL, ARROW]) {
    for (const match of source.matchAll(pattern)) {
      const sentence = pattern === ARROW ? match[1] : match[2]
      const line = source.slice(0, match.index).split('\n').length
      for (const word of vocabulary)
        if (word.regex.test(sentence))
          failures.push(
            `${file}:${line} says "${sentence}" to a Person with the system word /${word.pattern}/; say ${word.instead}.`,
          )
    }
  }
}

if (failures.length > 0) {
  console.error(`Person sentences use system words (${failures.length}):\n${failures.join('\n')}`)
  process.exit(1)
}
console.log('Person sentences are in the Person’s words.')
