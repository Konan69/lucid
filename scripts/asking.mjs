#!/usr/bin/env node
/**
 * Proof journeys ask Vivid the way a Person does. A Person never names a tool, its arguments or
 * which computer field to set; a journey that does ("Use write_document…", computer="person")
 * proves only that the model obeys an engineer, and hid two routing bugs until 26 October 2026
 * (the owner: "stop prompting it by telling it to use the tool"). This check reads every string
 * in the verify-vivid journeys and refuses one that tells Vivid which tool to use.
 *
 * The tool names come from the one vocabulary in packages/contracts/src/tools.ts, so a new tool
 * is covered the moment it is named there.
 */
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'

const vocabulary = NodeFS.readFileSync('packages/contracts/src/tools.ts', 'utf8')
const head = vocabulary.slice(0, vocabulary.indexOf(']'))
const tools = [...head.matchAll(/'([a-z][a-z_]+)'/gu)].map((match) => match[1])
if (tools.length < 10) throw new Error('asking.mjs: could not read the tool names from tools.ts')

const journeys = '.agents/skills/verify-vivid/scripts'
const told = new RegExp(
  `\\b(use|uses|using|call|calls|calling|with|run|invoke)\\s+(the\\s+)?(${tools.join('|')})\\b|computer\\s*=\\s*\\\\?["']?person`,
  'iu',
)
// Only words a journey says to Vivid: quoted string and template literals, not code.
const literal = /'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`|"(?:[^"\\\n]|\\.)*"/gu

const found = NodeFS.readdirSync(journeys)
  .filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs'))
  .flatMap((name) => {
    const path = NodePath.join(journeys, name)
    return NodeFS.readFileSync(path, 'utf8')
      .split('\n')
      .flatMap((line, at) =>
        [...line.matchAll(literal)].flatMap((match) =>
          told.test(match[0]) ? [`${path}:${at + 1}: ${match[0].slice(0, 90)}`] : [],
        ),
      )
  })

if (found.length > 0) {
  console.error(
    "A verify journey tells Vivid which tool to use. Ask in a Person's words instead " +
      '("Write me a document called…", "Open … in the browser on my computer"), and check the ' +
      'outcome and the receipts it leaves:\n' +
      found.map((line) => '  ' + line).join('\n'),
  )
  process.exit(1)
}
