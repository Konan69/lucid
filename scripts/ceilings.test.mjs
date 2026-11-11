import * as NodeAssert from 'node:assert/strict'
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeTest from 'node:test'
import * as NodeURL from 'node:url'
import { checkRaises } from './ceilings.mjs'
import { lintCeilingBase, parse } from './gate.mjs'
import { applyRatchets, stageResult } from './gate/local.mjs'

const assert = NodeAssert
const test = NodeTest.default
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

/** Execute the workflow's fetch command so the shallow-clone proof covers the CI shell too. */
function fetchComparison(root, base, env) {
  const workflow = NodeFS.readFileSync(
    new URL('../.github/workflows/quality.yml', import.meta.url),
    'utf8',
  )
  const fetch = workflow.match(
    /      - name: Fetch the ceiling comparison commit\n        if: matrix.stages == 'lint'\n        run: \|\n((?: {10}.+\n)+)/u,
  )
  assert.notEqual(fetch, null, 'the lint job must fetch its explicit comparison commit')
  return NodeChildProcess.spawnSync('bash', ['-e', '-c', fetch[1]], {
    cwd: root,
    env: { ...env, CEILINGS_BASE: base },
    encoding: 'utf8',
  })
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

/** Numeric ceiling history remains enforced after lifecycle debt moves to individual sites. */
void test('the lint stage rejects an increased numeric ceiling', (t) => {
  const repo = repository(t, table(18))
  repo.write(table(28))
  const lint = { name: 'lint', failed: [], output: '' }
  applyRatchets([lint], { root: repo.root, ceilingsBase: 'HEAD', env: environment() })
  assert.match(lint.failed.join('\n'), /ceiling 18 -> 28/u)
})

void test('failed lint cannot recommend lowering from a partial log', (t) => {
  const repo = repository(t, table(18))
  const lint = { name: 'lint', failed: ['linter stopped early'], output: '' }
  applyRatchets([lint], { root: repo.root, ceilingsBase: 'HEAD', env: environment() })
  assert.deepEqual(lint.failed, ['linter stopped early'])
})

void test('a missing Turbo lint receipt fails instead of appearing to have zero findings', (t) => {
  const repo = repository(t, table(18))
  const run = { root: repo.root, directory: repo.root, ceilingsBase: 'HEAD', env: environment() }
  const lint = stageResult(
    { name: 'lint' },
    [
      {
        taskId: '@vivid/web#lint',
        cache: { status: 'HIT' },
        execution: { startTime: 0, endTime: 0, exitCode: 0 },
        logFile: 'missing.log',
      },
    ],
    run,
  )
  applyRatchets([lint], run)
  assert.deepEqual(lint.failed, ['missing lint log for @vivid/web#lint'])
})

void test('full and affected gates resolve the lint merge base separately from test selection', (t) => {
  const repo = repository(t, table(18))
  const base = repo.git(['rev-parse', 'HEAD'])
  assert.equal(lintCeilingBase(repo.root, parse(['full']), environment()), base)
  assert.equal(lintCeilingBase(repo.root, parse(['affected']), environment()), base)
  repo.git(['update-ref', '-d', 'refs/remotes/origin/main'])
  const forwarded = parse(['full', '--ceilings-base', base])
  assert.equal(lintCeilingBase(repo.root, forwarded, environment()), base)
  assert.equal(
    lintCeilingBase(repo.root, parse(['full', '--only', 'typecheck']), environment()),
    undefined,
  )
  assert.equal(
    lintCeilingBase(repo.root, parse(['focused', 'example.test.ts']), environment()),
    undefined,
  )
})

/** GitHub starts with only the checked-out commit; fetching a base must not require ancestry. */
void test('depth-1 lint requires an explicit fetched base and still rejects a raise', (t) => {
  const repo = repository(t, table(18))
  const base = repo.git(['rev-parse', 'HEAD'])
  repo.write(table(28))
  repo.git(['commit', '--quiet', '-am', 'raise'])
  const root = NodePath.join(repo.root, 'shallow')
  const env = environment()
  repo.git([
    'clone',
    '--quiet',
    '--depth=1',
    '--single-branch',
    NodeURL.pathToFileURL(repo.root).href,
    root,
  ])
  const shallowGit = (args) => {
    const result = NodeChildProcess.spawnSync('git', args, { cwd: root, env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  shallowGit(['checkout', '--quiet', '--detach'])
  assert.equal(shallowGit(['rev-parse', '--is-shallow-repository']), 'true')
  assert.equal(shallowGit(['rev-list', '--count', 'HEAD']), '1')
  assert.equal(shallowGit(['for-each-ref', 'refs/remotes/origin/main']), '')
  const fetched = fetchComparison(root, base, env)
  assert.equal(fetched.status, 0, fetched.stderr)
  const resolved = lintCeilingBase(
    root,
    parse(['full', '--only', 'lint', '--ceilings-base', base]),
    env,
  )
  assert.equal(resolved, base)
  assert.match(checkRaises(root, resolved, env).join('\n'), /ceiling 18 -> 28/u)
  assert.throws(
    () => lintCeilingBase(root, parse(['full', '--only', 'lint']), env),
    /--ceilings-base/u,
  )
})

/** GitHub uses an all-zero before SHA for a new branch, which cannot authorize a comparison. */
void test('the CI fetch fails closed for an absent base and a new branch', (t) => {
  const repo = repository(t, table(18))
  for (const base of ['', '0'.repeat(40)]) {
    const result = fetchComparison(repo.root, base, environment())
    assert.equal(result.status, 1)
    assert.match(result.stdout, /::error::ceilings: this event has no comparison commit/u)
    assert.match(result.stdout, /--ceilings-base/u)
    assert.equal(result.stderr, '')
  }
})

void test('a historical table uses its own ceiling with a recorded lint log', (t) => {
  const repo = repository(t, table(18))
  const log = NodePath.join(repo.root, 'lint.log')
  NodeFS.writeFileSync(log, 'eslint(max-lines-per-function): long function\n'.repeat(17))
  repo.write(table(17))
  repo.git(['commit', '--quiet', '-am', 'lowered'])
  const historical = repo.run(['HEAD^', 'HEAD^', '--lint', log])
  assert.equal(historical.status, 1)
  assert.match(historical.stderr, /17 findings below ceiling 18; write ceiling: 17/u)
  assert.equal(repo.run(['HEAD^', 'HEAD', '--lint', log]).status, 0)
})

void test('dead-code ceilings share the historical no-raise policy', (t) => {
  const extra = (count) =>
    `export const deadCodeRatchets = [{ plugin: 'knip', rule: 'exports', ceiling: ${count} }]\n`
  const repo = repository(t, table(0) + extra(3))
  repo.write(table(0) + extra(4))
  const result = repo.run()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /knip\/exports: ceiling 3 -> 4/u)
})
