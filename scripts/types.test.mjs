import * as NodeAssert from 'node:assert/strict'
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeTest from 'node:test'
import * as NodeURL from 'node:url'

const assert = NodeAssert
const test = NodeTest.default
const repositoryRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  '..',
)
const compiler = NodePath.join(repositoryRoot, 'node_modules/@typescript/native/bin/tsc')

/** Exercise the real pinned compiler and repository configs with small owned source files. */
function fixture(t) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-types-'))
  t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }))
  for (const file of [
    'tsconfig.base.json',
    'packages/contracts/package.json',
    'packages/contracts/tsconfig.json',
    'packages/contracts/tsconfig.types.json',
    'packages/contracts/tsconfig.tests.json',
    'packages/client/rpc/package.json',
    'packages/client/rpc/tsconfig.json',
    'packages/client/rpc/tsconfig.types.json',
  ]) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, file)), { recursive: true })
    NodeFS.copyFileSync(NodePath.join(repositoryRoot, file), NodePath.join(root, file))
  }
  for (const directory of ['packages/contracts/src', 'packages/client/rpc/src']) {
    NodeFS.mkdirSync(NodePath.join(root, directory), { recursive: true })
  }
  const dependencies = NodePath.join(root, 'packages/client/rpc/node_modules/@vivid')
  NodeFS.mkdirSync(dependencies, { recursive: true })
  NodeFS.symlinkSync(
    NodePath.join(root, 'packages/contracts'),
    NodePath.join(dependencies, 'contracts'),
  )
  NodeFS.writeFileSync(
    NodePath.join(root, 'packages/contracts/src/index.ts'),
    'export const count = 1\n',
  )
  NodeFS.writeFileSync(
    NodePath.join(root, 'packages/contracts/src/check.test.ts'),
    "import { count } from './index.js'\nexport const checked: number = count\n",
  )
  NodeFS.writeFileSync(
    NodePath.join(root, 'packages/client/rpc/src/index.ts'),
    "import { count } from '@vivid/contracts'\nexport const consumed: number = count\n",
  )
  return root
}

/** Force the tiny graphs so rapid fixture writes cannot reuse timestamp-based build status. */
function check(root) {
  return NodeChildProcess.spawnSync(
    process.execPath,
    [
      compiler,
      '-b',
      'packages/contracts',
      'packages/client/rpc',
      '--force',
      '--checkers',
      '1',
      '--builders',
      '1',
    ],
    { cwd: root, encoding: 'utf8' },
  )
}

/** A split must retain production/test diagnostics and the consumer's declared contract. */
void test('project boundaries retain production, test, and consumer type errors', (t) => {
  const root = fixture(t)
  const valid = check(root)
  assert.equal(valid.status, 0, `${valid.stdout}\n${valid.stderr}`)
  assert.ok(
    NodeFS.existsSync(NodePath.join(root, 'packages/contracts/.cache/typescript/types/index.d.ts')),
  )

  NodeFS.writeFileSync(
    NodePath.join(root, 'packages/contracts/src/index.ts'),
    'export const count: number = "invalid"\n',
  )
  const production = check(root)
  assert.notEqual(production.status, 0)
  assert.match(production.stdout, /contracts\/src\/index\.ts.*TS2322/u)

  NodeFS.writeFileSync(
    NodePath.join(root, 'packages/contracts/src/index.ts'),
    'export const count = 1\n',
  )
  NodeFS.writeFileSync(
    NodePath.join(root, 'packages/contracts/src/check.test.ts'),
    "import { count } from './index.js'\nexport const checked: string = count\n",
  )
  const tests = check(root)
  assert.notEqual(tests.status, 0)
  assert.match(tests.stdout, /check\.test\.ts.*TS2322/u)

  NodeFS.writeFileSync(
    NodePath.join(root, 'packages/contracts/src/check.test.ts'),
    "import { count } from './index.js'\nexport const checked: number = count\n",
  )
  NodeFS.writeFileSync(
    NodePath.join(root, 'packages/client/rpc/src/index.ts'),
    "import { count } from '@vivid/contracts'\nexport const consumed: string = count\n",
  )
  const consumer = check(root)
  assert.notEqual(consumer.status, 0)
  assert.match(consumer.stdout, /client\/rpc\/src\/index\.ts.*TS2322/u)
})
