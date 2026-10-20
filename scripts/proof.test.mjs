import * as NodeAssert from 'node:assert/strict'
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeTest from 'node:test'
import * as NodeURL from 'node:url'
import { formatProof, proveBranch, proofSelection } from './proof.mjs'

const root = NodePath.resolve(NodeURL.fileURLToPath(new URL('../', import.meta.url)))
const assert = NodeAssert
const env = { ...process.env, HUSKY: '0' }

/** Fixtures use private clones so even failure-path branch operations cannot reach this repo. */
function git(directory, args) {
  const result = NodeChildProcess.spawnSync('git', args, { cwd: directory, env, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

/** Each seed commits a passing fix and keeps an origin/main base with the broken behavior. */
function fixture(t, tests, kind = 'node') {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-proof-test-'))
  t.after(() => NodeFS.rmSync(directory, { recursive: true, force: true }))
  const template = NodePath.join(directory, 'template')
  NodeFS.mkdirSync(template)
  git(template, ['init', '--quiet', '--initial-branch=main'])
  git(template, ['config', 'user.name', 'proof'])
  git(template, ['config', 'user.email', 'proof@localhost'])
  NodeFS.writeFileSync(NodePath.join(template, 'package.json'), '{"type":"module"}')
  NodeFS.writeFileSync(NodePath.join(template, 'value.mjs'), 'export const value = 1\n')
  if (kind === 'vitest')
    NodeFS.writeFileSync(
      NodePath.join(template, 'vitest.config.mjs'),
      'export default {test: {include: ["*.test.ts"]}}\n',
    )
  git(template, [
    'add',
    'package.json',
    'value.mjs',
    ...(kind === 'vitest' ? ['vitest.config.mjs'] : []),
  ])
  git(template, ['commit', '--quiet', '-m', 'broken base'])
  const target = NodePath.join(directory, 'clone')
  git(template, ['clone', '--quiet', template, target])
  git(target, ['config', 'user.name', 'proof'])
  git(target, ['config', 'user.email', 'proof@localhost'])
  git(target, ['switch', '--quiet', '-c', 'fix/seed'])
  const file = kind === 'node' ? 'value.test.mjs' : 'value.test.ts'
  NodeFS.writeFileSync(NodePath.join(target, file), tests)
  NodeFS.writeFileSync(NodePath.join(target, 'value.mjs'), 'export const value = 2\n')
  git(target, ['add', file, 'value.mjs'])
  git(target, ['commit', '--quiet', '-m', 'fix seed'])
  // Package-level links mirror a pnpm installation without a root node_modules symlink.
  NodeFS.mkdirSync(NodePath.join(target, 'node_modules'))
  if (kind === 'vitest')
    NodeFS.symlinkSync(
      NodeFS.realpathSync(NodePath.join(root, 'node_modules/vitest')),
      NodePath.join(target, 'node_modules/vitest'),
    )
  return target
}

const nodeImports = `import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { value } from './value.mjs'
`

void NodeTest.test('each changed case must fail on its own assertion after reversal', async (t) => {
  const target = fixture(
    t,
    `${nodeImports}
test('detects the missing fix', () => { assert.equal(value, 2) })
test('survives the missing fix', () => { assert.ok(value > 0) })
`,
  )
  const before = git(target, ['status', '--porcelain'])
  const outcome = await proveBranch(target, proofSelection(target, {}), env)
  process.stdout.write(formatProof(outcome))
  assert.equal(outcome.passed, false)
  assert.deepEqual(
    outcome.results.map((result) => result.state),
    ['PROVEN', 'SURVIVED'],
  )
  assert.match(outcome.results[1].label, /survives the missing fix/u)
  assert.equal(
    NodeFS.readFileSync(NodePath.join(target, 'value.mjs'), 'utf8'),
    'export const value = 2\n',
  )
  assert.equal(git(target, ['status', '--porcelain']), before)
})

void NodeTest.test(
  'a real regression assertion proves a fix without changing its checkout',
  async (t) => {
    const target = fixture(
      t,
      `${nodeImports}test('fixed value', () => { assert.equal(value, 2) })\n`,
    )
    const outcome = await proveBranch(target, proofSelection(target, {}), env)
    assert.equal(outcome.passed, true)
    process.stdout.write(formatProof(outcome))
    assert.equal(outcome.results[0].state, 'PROVEN')
  },
)

void NodeTest.test(
  'setup assertions and runtime errors are inconclusive, with an explicit exception trailer',
  async (t) => {
    const target = fixture(
      t,
      `${nodeImports}
beforeEach(() => { assert.equal(value, 2) })
test('has no behavior assertion', () => { assert.ok(true) })
`,
    )
    const first = await proveBranch(target, proofSelection(target, {}), env)
    assert.equal(first.passed, false)
    assert.equal(first.results[0].state, 'INCONCLUSIVE')
    git(target, [
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'explain proof',
      '-m',
      'Proof-Inconclusive: setup owns this assertion; a live provider proof is recorded separately.',
    ])
    const exempted = await proveBranch(target, proofSelection(target, {}), env)
    assert.equal(exempted.passed, true)
    assert.match(exempted.reason, /setup owns/u)
  },
)

void NodeTest.test('an exception never waives a test that survives reversal', async (t) => {
  const target = fixture(t, `${nodeImports}test('survives', () => { assert.ok(value > 0) })\n`)
  git(target, [
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    'explain proof',
    '-m',
    'Proof-Inconclusive: unavailable provider.',
  ])
  const outcome = await proveBranch(target, proofSelection(target, {}), env)
  process.stdout.write(formatProof(outcome))
  assert.equal(outcome.passed, false)
  assert.equal(outcome.results[0].state, 'SURVIVED')
})

void NodeTest.test(
  'changed existing cases are selected without borrowing or charging unchanged cases',
  async (t) => {
    const target = fixture(t, `${nodeImports}test('old', () => { assert.ok(value > 0) })\n`)
    const base = git(target, ['rev-parse', 'HEAD'])
    NodeFS.writeFileSync(
      NodePath.join(target, 'value.test.mjs'),
      `${nodeImports}test('old', () => { assert.equal(value, 3) })\n`,
    )
    NodeFS.writeFileSync(NodePath.join(target, 'value.mjs'), 'export const value = 3\n')
    git(target, ['add', 'value.mjs', 'value.test.mjs'])
    git(target, ['commit', '--quiet', '-m', 'strengthen assertion'])
    const outcome = await proveBranch(target, proofSelection(target, { 'proof-base': base }), env)
    assert.equal(outcome.passed, true)
    assert.equal(outcome.results.length, 1)
  },
)

void NodeTest.test('non-fix branches skip unless proof is explicitly requested', (t) => {
  const target = fixture(t, `${nodeImports}test('fixed value', () => { assert.equal(value, 2) })\n`)
  git(target, ['switch', '--quiet', '-c', 'feature/seed'])
  assert.equal(proofSelection(target, {}).enabled, false)
  assert.equal(proofSelection(target, { only: 'proof' }).enabled, true)
  assert.equal(proofSelection(target, { only: 'lint, proof' }).enabled, true)
  assert.equal(proofSelection(target, { mode: 'focused' }).enabled, false)
})

void NodeTest.test(
  'a patch that no longer reverses is inconclusive and leaves the real source alone',
  async (t) => {
    const target = fixture(
      t,
      `${nodeImports}
import { writeFileSync } from 'node:fs'
test('writes its scratch source', () => {
  assert.equal(value, 2)
  writeFileSync(new URL('./value.mjs', import.meta.url), 'changed during test\\n')
})
`,
    )
    const outcome = await proveBranch(target, proofSelection(target, {}), env)
    assert.equal(outcome.passed, false)
    assert.equal(outcome.results[0].state, 'INCONCLUSIVE')
    assert.match(outcome.results[0].reason, /git apply failed/u)
    assert.equal(
      NodeFS.readFileSync(NodePath.join(target, 'value.mjs'), 'utf8'),
      'export const value = 2\n',
    )
  },
)

void NodeTest.test(
  'an assertion in a same-line setup callback is not a case assertion',
  async (t) => {
    const target = fixture(
      t,
      `${nodeImports}
beforeEach(() => { assert.equal(value, 2) }); test('empty body', () => { assert.ok(true) })
`,
    )
    const outcome = await proveBranch(target, proofSelection(target, {}), env)
    assert.equal(outcome.passed, false)
    assert.equal(outcome.results[0].state, 'INCONCLUSIVE')
  },
)

void NodeTest.test(
  'a Vitest feature that cannot import without its implementation is inconclusive',
  async (t) => {
    const target = fixture(
      t,
      `import { test, expect } from 'vitest'
import { feature } from './feature.mjs'
test('uses new feature', () => { expect(feature()).toBe(2) })
`,
      'vitest',
    )
    NodeFS.writeFileSync(NodePath.join(target, 'feature.mjs'), 'export const feature = () => 2\n')
    git(target, ['add', 'feature.mjs'])
    git(target, ['commit', '--quiet', '-m', 'feature implementation'])
    const outcome = await proveBranch(target, proofSelection(target, {}), env)
    assert.equal(outcome.passed, false)
    assert.ok(outcome.results.some((result) => result.reason.includes('did not collect without')))
    assert.equal(
      outcome.results.some((result) => result.state === 'PROVEN'),
      false,
    )
  },
)

void NodeTest.test(
  'aliases cannot hide a surviving changed case beside a real regression',
  async (t) => {
    const target = fixture(
      t,
      `${nodeImports}
const check = test
test('detects the fix', () => { assert.equal(value, 2) })
check('survives through an alias', () => { assert.ok(value > 0) })
`,
    )
    const outcome = await proveBranch(target, proofSelection(target, {}), env)
    assert.equal(outcome.passed, false)
    assert.ok(outcome.results.some((result) => result.state === 'SURVIVED'))
  },
)

void NodeTest.test(
  'an uncollected changed declaration cannot hide behind a proven sibling',
  async (t) => {
    const target = fixture(
      t,
      `${nodeImports}
test('detects the fix', () => { assert.equal(value, 2) })
if (false) test('never collected', () => { assert.equal(value, 2) })
`,
    )
    const outcome = await proveBranch(target, proofSelection(target, {}), env)
    assert.equal(outcome.passed, false)
    assert.ok(outcome.results.some((result) => result.reason === 'changed case did not collect'))
  },
)

void NodeTest.test(
  'new feature import failures are inconclusive rather than regression proof',
  async (t) => {
    const target = fixture(
      t,
      `${nodeImports}
import { feature } from './feature.mjs'
test('uses the new feature', () => { assert.equal(feature(), 2) })
`,
    )
    NodeFS.writeFileSync(NodePath.join(target, 'feature.mjs'), 'export const feature = () => 2\n')
    git(target, ['add', 'feature.mjs'])
    git(target, ['commit', '--quiet', '-m', 'new implementation'])
    const outcome = await proveBranch(target, proofSelection(target, {}), env)
    process.stdout.write(formatProof(outcome))
    assert.equal(outcome.passed, false)
    assert.ok(outcome.results.some((result) => result.reason.includes('did not collect without')))
    assert.equal(
      outcome.results.some((result) => result.state === 'PROVEN'),
      false,
    )
  },
)
