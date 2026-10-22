import * as NodeFS from 'node:fs'
import * as NodeChildProcess from 'node:child_process'
import * as NodePath from 'node:path'
import * as NodeAssert from 'node:assert/strict'
import * as NodeTest from 'node:test'
import { blockedCommands, isCompilerBlocker } from './bins.mjs'
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

for (const source of ['tsc -b', '    tsc -b', '\ttsc', '1. tsc -b', 'Then tsc -b builds it.']) {
  test(`Markdown compiler commands fail without an instruction verb: ${source}`, () => {
    assert.equal(commandErrors('docs/checks.md', source).length, 1)
  })
}

for (const source of [
  'Run `tsc-rs`, not `tsc`.',
  'tsc-rs',
  'Run `tsc-rs`.',
  'Never run `tsc`.',
  'Run `tsc-rs` instead of `tsc`.',
]) {
  test(`the native checker is allowed in Markdown: ${source}`, () => {
    assert.deepEqual(commandErrors('docs/checks.md', source), [])
  })
}

test('workspace installs expose only repo-owned rejection bins', () => {
  for (const manifest of NodeFS.globSync(
    ['package.json', 'apps/*/package.json', 'packages/**/package.json'],
    { exclude: ['**/node_modules/**'] },
  )) {
    for (const name of blockedCommands) {
      const bin = NodePath.resolve(NodePath.dirname(manifest), 'node_modules/.bin', name)
      if (NodeFS.existsSync(bin)) assert.ok(isCompilerBlocker(process.cwd(), bin), bin)
    }
  }
})

test('bin identity rejects executables and links to any other file', (context) => {
  const root = NodeFS.mkdtempSync(NodePath.resolve('.cache/compiler-bins-'))
  context.after(() => NodeFS.rmSync(root, { recursive: true, force: true }))
  NodeFS.mkdirSync(NodePath.join(root, 'packages/compiler'), { recursive: true })
  NodeFS.mkdirSync(NodePath.join(root, 'node_modules/.bin'), { recursive: true })
  const target = NodePath.join(root, 'packages/compiler/disabled.mjs')
  NodeFS.writeFileSync(target, '')
  const bin = NodePath.join(root, 'node_modules/.bin/tsc')
  NodeFS.symlinkSync(target, bin)
  assert.equal(isCompilerBlocker(root, bin), true)
  NodeFS.rmSync(bin)
  NodeFS.writeFileSync(bin, '#!/bin/sh\nexit 0\n')
  assert.equal(isCompilerBlocker(root, bin), false)
  NodeFS.rmSync(bin)
  NodeFS.writeFileSync(NodePath.join(root, 'other.mjs'), '')
  NodeFS.symlinkSync(NodePath.join(root, 'other.mjs'), bin)
  assert.equal(isCompilerBlocker(root, bin), false)
})

test('pnpm exec rejects legacy names from the root and package directories', () => {
  for (const directory of ['.', 'packages/contracts', 'apps/server', 'packages/agent/runtime']) {
    for (const command of ['tsc', 'tsgo', 'tsserver']) {
      const result = NodeChildProcess.spawnSync('pnpm', ['exec', command, '--version'], {
        cwd: directory,
        encoding: 'utf8',
      })
      assert.equal(
        result.status,
        1,
        directory + '/' + command + ': ' + result.stdout + result.stderr,
      )
      assert.equal(result.stdout, '')
      assert.equal(
        result.stderr,
        'Compiler command disabled. Use pnpm check with a project path.\n',
      )
    }
  }
})
