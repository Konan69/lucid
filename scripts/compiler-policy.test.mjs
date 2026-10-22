import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodeChildProcess from 'node:child_process'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
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

for (const compiler of ['tsc', 'tsgo']) {
  test(`pnpm exec rejects ${compiler} before reaching a global compiler`, () => {
    const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), '..')
    const result = NodeChildProcess.spawnSync('pnpm', ['exec', compiler, '--version'], {
      cwd: root,
      encoding: 'utf8',
    })
    assert.notEqual(result.status, 0)
    if (compiler === 'tsc') assert.match(result.stderr + result.stdout, /Use pnpm check <project>/u)
  })
}

NodeTest.test('historical compiler names are prose, while runnable examples remain checked', () => {
  assert.deepEqual(commandErrors('docs/checks.md', '| `tsc` 7.0.2 | 28.3 s |'), [])
  assert.equal(commandErrors('docs/checks.md', 'Run `tsc`.').length, 1)
  assert.equal(commandErrors('docs/checks.md', '```sh\ntsc\n```').length, 1)
})

NodeTest.test('pnpm rejects a compiler package reached through node and a file path', (context) => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-compiler-guard-'))
  context.after(() => NodeFS.rmSync(directory, { recursive: true, force: true }))
  const file = NodePath.join(directory, 'node_modules/typescript/lib/driver.js')
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true })
  NodeFS.writeFileSync(file, 'console.log("compiler executed")')
  const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), '..')
  const result = NodeChildProcess.spawnSync('pnpm', ['exec', 'node', file], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Use pnpm check <project>/u)
  assert.equal(result.stdout, '')
})
