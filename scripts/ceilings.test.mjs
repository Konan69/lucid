import * as NodeAssert from 'node:assert/strict'
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeTest from 'node:test'
import * as NodeURL from 'node:url'
import { checkTightCeilings, measureCeilings } from './ceilings.mjs'
import { ratchets } from './gate/ratchets.mjs'

const assert = NodeAssert
const test = NodeTest.default
const ceilings = new Map(ratchets.map((entry) => [`${entry.plugin}/${entry.rule}`, entry.ceiling]))
const script = NodeURL.fileURLToPath(new URL('./ceilings.mjs', import.meta.url))

/** Isolate fixture writes even when this suite runs in a Git push hook. */
function environment() {
  const env = { ...process.env }
  const names = NodeChildProcess.spawnSync('git', ['rev-parse', '--local-env-vars'], {
    encoding: 'utf8',
  })
  assert.equal(names.status, 0, names.stderr)
  for (const name of names.stdout.trim().split('\n')) delete env[name]
  return env
}

/** Each proof uses a real branch and merge base, without mutating the application checkout. */
function repository(t, source) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-ceilings-'))
  t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }))
  const env = environment()
  const git = (args) => {
    const result = NodeChildProcess.spawnSync('git', args, { cwd: root, env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git(['init', '--quiet', '--initial-branch=main'])
  git(['config', 'user.name', 'ceilings'])
  git(['config', 'user.email', 'ceilings@localhost'])
  NodeFS.mkdirSync(NodePath.join(root, 'scripts/gate'), { recursive: true })
  NodeFS.mkdirSync(NodePath.join(root, '.husky'))
  const file = source.startsWith('check_ratchet') ? '.husky/pre-push' : 'scripts/gate/ratchets.mjs'
  NodeFS.writeFileSync(NodePath.join(root, file), source)
  git(['add', '--', file])
  git(['commit', '--quiet', '-m', 'baseline'])
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD'])
  git(['switch', '--quiet', '-c', 'unit'])
  return {
    root,
    git,
    write: (value) => NodeFS.writeFileSync(NodePath.join(root, 'scripts/gate/ratchets.mjs'), value),
    run: (args = []) =>
      NodeChildProcess.spawnSync(process.execPath, [script, ...args], {
        cwd: root,
        env,
        encoding: 'utf8',
      }),
  }
}

/** Literal tables are fixtures of the public file format, including different field orders. */
const table = (ceiling) =>
  `export const ratchets = [{ ceiling: ${ceiling}, rule: "max-lines-per-function", plugin: "eslint" }]\n`

void test('the CLI fails an uncommitted raise against origin/main and names both numbers', (t) => {
  const repo = repository(t, table(18))
  repo.write(table(28))
  const result = repo.run()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /eslint\/max-lines-per-function: ceiling 18 -> 28/u)
})

void test('the merge base, not a newer origin/main ceiling, owns the comparison', (t) => {
  const repo = repository(t, table(18))
  const base = repo.git(['rev-parse', 'HEAD'])
  repo.write(table(28))
  repo.git(['commit', '--quiet', '-am', 'raised on unit'])
  repo.git(['switch', '--quiet', 'main'])
  repo.write(table(40))
  repo.git(['commit', '--quiet', '-am', 'main advanced'])
  repo.git(['update-ref', 'refs/remotes/origin/main', 'HEAD'])
  repo.git(['switch', '--quiet', 'unit'])
  const result = repo.run()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /ceiling 18 -> 28/u)
  assert.equal(repo.git(['merge-base', 'HEAD', 'origin/main']), base)
})

void test('lowered ceilings and new rule baselines pass', (t) => {
  const repo = repository(t, table(18))
  repo.write(`export const ratchets = [
    { plugin: 'eslint', rule: 'max-lines-per-function', ceiling: 17 },
    { plugin: 'vivid', rule: 'new-rule', ceiling: 10 },
  ]\n`)
  const result = repo.run()
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /0 violations/u)
})

void test('explicit revisions catch a raise across the old-hook to table migration', (t) => {
  const repo = repository(
    t,
    'check_ratchet "long functions" "eslint" "max-lines-per-function" 18\n',
  )
  const base = repo.git(['rev-parse', 'HEAD'])
  repo.write(table(28))
  repo.git(['add', '--', 'scripts/gate/ratchets.mjs'])
  repo.git(['commit', '--quiet', '-m', 'table migration with raise'])
  const result = repo.run([base, 'HEAD'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /ceiling 18 -> 28/u)
})

void test('legacy hook comparisons catch multiple raised rules', (t) => {
  const repo = repository(
    t,
    'check_ratchet "long functions" "eslint" "max-lines-per-function" 0\ncheck_ratchet "depth" "eslint" "max-depth" 0\n',
  )
  NodeFS.writeFileSync(
    NodePath.join(repo.root, '.husky/pre-push'),
    'check_ratchet "long functions" "eslint" "max-lines-per-function" 5\ncheck_ratchet "depth" "eslint" "max-depth" 2\n',
  )
  repo.git(['commit', '--quiet', '-am', 'legacy raises'])
  const result = repo.run(['HEAD^', 'HEAD'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /ceiling 0 -> 5/u)
  assert.match(result.stderr, /ceiling 0 -> 2/u)
  assert.match(result.stdout, /2 violations/u)
})

void test('missing revisions and declarations fail instead of permitting every raise', (t) => {
  const repo = repository(t, table(18))
  assert.equal(repo.run(['missing-revision']).status, 1)
  repo.write('export const ratchets = []\n')
  assert.match(repo.run().stderr, /no ceiling declarations/u)
  repo.git(['update-ref', '-d', 'refs/remotes/origin/main'])
  assert.equal(repo.run().status, 1)
})

void test('computed ceilings and duplicate identities cannot hide a raise', (t) => {
  const repo = repository(t, table(18))
  repo.write(table('9 + 19'))
  assert.match(repo.run().stderr, /literal value/u)
  repo.write(`export const ratchets = [
    { plugin: 'eslint', rule: 'max-lines-per-function', ceiling: 28 },
    { plugin: 'eslint', rule: 'max-lines-per-function', ceiling: 18 },
  ]\n`)
  assert.match(repo.run().stderr, /duplicate rule/u)
  repo.write(table(-1))
  assert.equal(repo.run().status, 1)
})

/** The same complete lint log can be fresh or restored by Turbo. Rule prefixes must not collide. */
void test('tight ceilings name the measured replacement and accept exact counts', () => {
  const rule = ratchets.find((entry) => entry.rule === 'react-no-state-after-wait')
  assert.notEqual(rule, undefined)
  const finding = '  ⚠ vivid(react-no-state-after-wait): Move the lifecycle to a machine.\n'
  const tight = finding.repeat(rule.ceiling)
  assert.deepEqual(checkTightCeilings(measureCeilings(tight, ceilings)), [])
  const loose = finding.repeat(rule.ceiling - 1)
  assert.deepEqual(checkTightCeilings(measureCeilings(loose, ceilings)), [
    `vivid/react-no-state-after-wait: ${rule.ceiling - 1} findings below ceiling ${rule.ceiling}; write ceiling: ${rule.ceiling - 1} in scripts/gate/ratchets.mjs.`,
  ])
  assert.deepEqual(
    checkTightCeilings(
      measureCeilings(`${tight}vivid/react-no-state-after-wait-extra\n`, ceilings),
    ),
    [],
  )
})

void test('the CLI consumes an existing lint log and exits nonzero for a loose ceiling', (t) => {
  const repo = repository(t, table(18))
  const log = NodePath.join(repo.root, 'lint.log')
  NodeFS.writeFileSync(log, 'Found 0 warnings and 0 errors.\n')
  const result = repo.run(['--lint', log])
  assert.equal(result.status, 1)
  assert.match(
    result.stderr,
    /eslint\/max-lines-per-function: 0 findings below ceiling 18; write ceiling: 0/u,
  )
})
