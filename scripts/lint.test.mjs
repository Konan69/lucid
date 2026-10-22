import * as NodeAssert from 'node:assert/strict'
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeTest from 'node:test'
import * as NodeURL from 'node:url'
import * as Schema from 'effect/Schema'

const assert = NodeAssert
const test = NodeTest.default
const script = NodeURL.fileURLToPath(new URL('./lint.mjs', import.meta.url))

// Decode the captured CLI receipt once at the subprocess boundary.
const LintReceipt = Schema.Struct({
  args: Schema.Array(Schema.String),
  cwd: Schema.String,
  workers: Schema.String,
  backend: Schema.String,
})
const decodeLintReceipt = Schema.decodeUnknownSync(Schema.fromJsonString(LintReceipt))

/** Exercise the runner's public CLI without starting a TypeScript graph. */
function fixture(t) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-lint-'))
  t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }))
  for (const directory of [
    'scripts',
    'apps/web',
    'node_modules/oxlint/bin',
    'node_modules/@maschwenk/tsrslint',
  ]) {
    NodeFS.mkdirSync(NodePath.join(root, directory), { recursive: true })
  }
  NodeFS.writeFileSync(
    NodePath.join(root, 'node_modules/@maschwenk/tsrslint/index.js'),
    'exports.binaryPath = () => "/fixture/tsrslint"\n',
  )
  NodeFS.copyFileSync(script, NodePath.join(root, 'scripts/lint.mjs'))
  NodeFS.writeFileSync(
    NodePath.join(root, 'node_modules/oxlint/bin/oxlint'),
    `const args = process.argv.slice(2)
console.log(JSON.stringify({ args, cwd: process.cwd(), workers: process.env.GOMAXPROCS, backend: process.env.OXLINT_TSGOLINT_PATH }))
if (args.includes('--fixture-failure')) {
  console.error('fixture lint diagnostic')
  process.exitCode = 7
}
`,
  )
  return root
}

/** Clear ambient worker overrides so the default is tested deliberately. */
function invoke(root, cwd, args = [], workers) {
  const environment = { ...process.env }
  delete environment.OXLINT_TSGOLINT_PATH
  delete environment.GOMAXPROCS
  delete environment.VIVID_LINT_THREADS
  if (workers !== undefined) environment.GOMAXPROCS = workers
  return NodeChildProcess.spawnSync(
    process.execPath,
    [NodePath.join(root, 'scripts/lint.mjs'), ...args],
    {
      cwd,
      env: environment,
      encoding: 'utf8',
    },
  )
}

/** Root-relative rule globs must retain their meaning for package tasks. */
void test('package lint keeps full type analysis and runs its entire directory from the root', (t) => {
  const root = fixture(t)
  const result = invoke(root, NodePath.join(root, 'apps/web'))
  assert.equal(result.status, 0, result.stderr)
  const observed = decodeLintReceipt(result.stdout)
  assert.equal(observed.cwd, root)
  assert.equal(observed.workers, '1')
  assert.equal(observed.backend, '/fixture/tsrslint')
  assert.ok(observed.args.includes('--type-aware'))
  assert.ok(observed.args.includes('--threads=1'))
  assert.equal(observed.args.at(-1), 'apps/web')
  assert.ok(!observed.args.includes('--ignore-pattern'))
})

/** Each workspace is checked once; root tooling and infrastructure remain covered. */
void test('root lint excludes directories owned by workspace tasks', (t) => {
  const root = fixture(t)
  const result = invoke(root, root)
  assert.equal(result.status, 0, result.stderr)
  const observed = decodeLintReceipt(result.stdout)
  assert.ok(observed.args.includes('apps/**'))
  assert.ok(observed.args.includes('packages/**'))
  assert.equal(observed.args.at(-1), '.')
})

/** Fixes must still reach packages despite the root task's normal partition. */
void test('root fix explicitly checks the whole workspace', (t) => {
  const root = fixture(t)
  const result = invoke(root, root, ['--fix', '--workspace'])
  assert.equal(result.status, 0, result.stderr)
  const observed = decodeLintReceipt(result.stdout)
  assert.ok(observed.args.includes('--fix'))
  assert.ok(!observed.args.includes('--workspace'))
  assert.ok(!observed.args.includes('--ignore-pattern'))
})

/** A failed linter remains a failed gate with its diagnostic intact. */
void test('lint exit status and diagnostics propagate', (t) => {
  const root = fixture(t)
  const result = invoke(root, root, ['--fixture-failure'])
  assert.equal(result.status, 7)
  assert.match(result.stderr, /fixture lint diagnostic/u)
})

/** Deliberate worker comparisons must remain possible through the documented env. */
void test('an explicit Go worker setting is respected', (t) => {
  const root = fixture(t)
  const result = invoke(root, root, [], '2')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(decodeLintReceipt(result.stdout).workers, '2')
})

/** An outside cwd must never turn a cached package task into a different scope. */
void test('lint rejects paths outside the repository', (t) => {
  const root = fixture(t)
  const result = invoke(root, NodePath.dirname(root))
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /inside the Vivid workspace/u)
})

void test('an explicit type-aware backend is respected', (t) => {
  const root = fixture(t)
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [NodePath.join(root, 'scripts/lint.mjs')],
    {
      cwd: root,
      env: { ...process.env, OXLINT_TSGOLINT_PATH: '/custom/backend' },
      encoding: 'utf8',
    },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.equal(decodeLintReceipt(result.stdout).backend, '/custom/backend')
})
