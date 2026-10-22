import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as NodeAssert from 'node:assert/strict'
import * as NodeTest from 'node:test'
import { commandErrors } from './compiler-policy.mjs'

const assert = NodeAssert
const test = NodeTest.default

for (const command of [
  'tsc --noEmit',
  'pnpm exec tsc -p tsconfig.json',
  'pnpm exec tsgo',
  'npx tsc',
  'echo ready && tsc',
  'tsgo -b',
  'node node_modules/typescript/bin/tsc -p .',
  './node_modules/.bin/tsc',
  '/usr/bin/tsc --noEmit',
  'node node_modules/typescript/lib/tsc.js',
]) {
  test(`legacy compiler commands fail the gate: ${command}`, () => {
    assert.equal(
      commandErrors('package.json', JSON.stringify({ scripts: { check: command } })).length,
      1,
    )
    assert.equal(commandErrors('.husky/pre-push', command).length, 1)
    assert.equal(commandErrors('AGENTS.md', `Run \`${command}\` to check types.`).length, 1)
    assert.equal(commandErrors('docs/checks.md', `Run ${command} to check types.`).length, 1)
  })
}

test('the documented project check runs the pinned checker', () => {
  const command = 'node scripts/types.mjs packages/contracts/tsconfig.json'
  assert.deepEqual(
    commandErrors('package.json', JSON.stringify({ scripts: { check: command } })),
    [],
  )
  assert.deepEqual(
    commandErrors('AGENTS.md', 'Run `pnpm check packages/contracts/tsconfig.json`.'),
    [],
  )
})

NodeTest.test('historical compiler names are prose, while runnable examples remain checked', () => {
  assert.deepEqual(commandErrors('docs/checks.md', '| `tsc` 7.0.2 | 28.3 s |'), [])
  assert.equal(commandErrors('docs/checks.md', 'Run `tsc`.').length, 1)
  assert.equal(commandErrors('docs/checks.md', '```sh\ntsc\n```').length, 1)
})

for (const source of ['tsc -b', '    tsc -b', '\ttsc']) {
  test(`Markdown compiler commands fail without an instruction verb: ${source}`, () => {
    assert.equal(commandErrors('docs/checks.md', source).length, 1)
  })
}

for (const source of ['Run `tsc-rs`, not `tsc`.', 'tsc-rs', 'Run `tsc-rs`.']) {
  test(`the native checker is allowed in Markdown: ${source}`, () => {
    assert.deepEqual(commandErrors('docs/checks.md', source), [])
  })
}

test('workspace installs expose no legacy compiler bins', () => {
  for (const manifest of NodeFS.globSync(
    ['package.json', 'apps/*/package.json', 'packages/**/package.json'],
    { exclude: ['**/node_modules/**'] },
  )) {
    for (const name of ['tsc', 'tsgo']) {
      assert.equal(
        NodeFS.existsSync(NodePath.join(NodePath.dirname(manifest), 'node_modules/.bin', name)),
        false,
      )
    }
  }
})
