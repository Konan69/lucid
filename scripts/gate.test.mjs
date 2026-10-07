import * as NodeAssert from 'node:assert/strict'
import * as NodeChildProcess from 'node:child_process'
import * as NodeEvents from 'node:events'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeTest from 'node:test'
import * as NodeURL from 'node:url'
import * as Schema from 'effect/Schema'
import { parse, report, selectStages, withoutRepositoryEnvironment } from './gate.mjs'
import { refusedHost, shellWord, snapshot, treeName } from './gate/cloud.mjs'
import { checkRatchets, countFindings, ratchets } from './gate/ratchets.mjs'
import { slotCount, takeLock } from './gate/slots.mjs'
import { stageNames, stageOfTask, stages } from './gate/stages.mjs'

const assert = NodeAssert
const test = NodeTest.default
const repositoryRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  '..',
)

const TurboConfig = Schema.Struct({
  tasks: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Json)),
})
const decodeTurboConfig = Schema.decodeUnknownSync(Schema.fromJsonString(TurboConfig))
const Manifest = Schema.Struct({ scripts: Schema.Record(Schema.String, Schema.String) })
const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))

/** What the hook's probe saw: whether git exported its repository, and where `git add` landed. */
const decodeProbe = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ inherited: Schema.Boolean, top: Schema.String, scratch: Schema.String }),
  ),
)

function git(cwd, args, env = process.env) {
  const result = NodeChildProcess.spawnSync('git', args, { cwd, env, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

/** A repository with one commit, cleaned up with the test. */
function repository(t) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-gate-'))
  t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }))
  const env = withoutRepositoryEnvironment(process.env)
  git(root, ['init', '--quiet', '--initial-branch=main'], env)
  git(root, ['config', 'user.name', 'gate'], env)
  git(root, ['config', 'user.email', 'gate@localhost'], env)
  NodeFS.writeFileSync(NodePath.join(root, 'kept.txt'), 'committed\n')
  git(root, ['add', '.'], env)
  git(root, ['commit', '--quiet', '-m', 'first'], env)
  return { root, env }
}

void test('a finding is counted in both of the formats oxlint prints a rule in', () => {
  const ratchet = { plugin: 'vivid', rule: 'no-try-catch' }
  const output = [
    '  ⚠ vivid(no-try-catch): Use a typed failure.',
    'src/a.ts:1:1: message [Warning/vivid/no-try-catch]',
    '  ⚠ vivid(no-try-catch-extra): a longer rule name is another rule',
    '  ⚠ eslint(complexity): unrelated',
  ].join('\n')
  assert.equal(countFindings(output, ratchet), 2)
  // The rule's words inside a longer file name earlier in the line do not hide the rule field.
  const shadowed = 'src/vivid/no-try-catch-fixture.ts:1:1: message [Warning/vivid/no-try-catch]'
  assert.equal(countFindings(shadowed, ratchet), 1)
})

void test('a ratchet fails only above its ceiling, and every ratchet names a distinct rule', () => {
  const clean = checkRatchets('Found 0 warnings and 0 errors.\n')
  assert.equal(clean.length, ratchets.length)
  assert.ok(clean.every((ratchet) => ratchet.held))
  const broken = checkRatchets('  ⚠ eslint(max-depth): Blocks are nested too deeply (4).\n')
  assert.deepEqual(
    broken.filter((ratchet) => !ratchet.held).map((ratchet) => ratchet.label),
    ['deep nesting'],
  )
  const rules = ratchets.map((ratchet) => `${ratchet.plugin}/${ratchet.rule}`)
  assert.equal(new Set(rules).size, rules.length)
})

void test('every Turbo stage task exists as a script or a root task', () => {
  const turbo = decodeTurboConfig(
    NodeFS.readFileSync(NodePath.join(repositoryRoot, 'turbo.json'), 'utf8'),
  )
  const manifest = decodeManifest(
    NodeFS.readFileSync(NodePath.join(repositoryRoot, 'package.json'), 'utf8'),
  )
  for (const stage of stages.filter((entry) => entry.tasks !== undefined))
    for (const task of stage.tasks) {
      const declared = turbo.tasks[task] !== undefined || turbo.tasks[`//#${task}`] !== undefined
      assert.ok(declared, `${stage.name}: turbo.json has no task ${task}`)
      if (turbo.tasks[`//#${task}`] !== undefined)
        assert.notEqual(manifest.scripts[task], undefined, `package.json has no script ${task}`)
    }
  assert.equal(stageOfTask('@vivid/server#lint').name, 'lint')
  assert.equal(stageOfTask('//#typecheck:root').name, 'typecheck')
  assert.equal(stageOfTask('@vivid/contracts#types').name, 'typecheck')
})

/**
 * Turbo 2.11.2 replaces a generic task with a package-specific one; it does not merge them. An
 * override that names only `dependsOn` silently drops the shared inputs, outputs and environment
 * (before 6 Oct 2026 the server's lint did not rerun when `.oxlintrc.json` changed). Every
 * override must therefore repeat the generic task and differ only in its dependencies.
 */
void test('a package-specific Turbo task keeps the generic task hash inputs and outputs', () => {
  const { tasks } = decodeTurboConfig(
    NodeFS.readFileSync(NodePath.join(repositoryRoot, 'turbo.json'), 'utf8'),
  )
  const overrides = Object.keys(tasks).filter((key) =>
    /^@vivid\/[\w-]+#(lint|typecheck|test)$/u.test(key),
  )
  assert.ok(overrides.length >= 12)
  for (const key of overrides) {
    const generic = tasks[key.slice(key.indexOf('#') + 1)]
    for (const field of ['inputs', 'outputs', 'passThroughEnv'])
      if (generic[field] !== undefined && field !== 'passThroughEnv')
        assert.deepEqual(tasks[key][field], generic[field], `${key} must repeat ${field}`)
    for (const dependency of generic.dependsOn)
      assert.ok(tasks[key].dependsOn.includes(dependency), `${key} must keep ${dependency}`)
  }
})

/**
 * The database address differs on every run and would miss the cache every time; the gate's
 * marker and every other test setting are hashed instead, so a result made without one of them
 * never answers for a run that has it.
 */
void test('test tasks hash every test setting except the database address', () => {
  const { tasks } = decodeTurboConfig(
    NodeFS.readFileSync(NodePath.join(repositoryRoot, 'turbo.json'), 'utf8'),
  )
  const tests = Object.entries(tasks).filter(([key]) => /(^|#)test$/u.test(key))
  assert.ok(tests.length >= 6)
  for (const [key, task] of tests) {
    assert.deepEqual(
      task.env,
      ['VIVID_TEST_*', 'VIVID_LIVE_*', 'EXPLABS_API_KEY', '!VIVID_TEST_DATABASE_URL'],
      key,
    )
    assert.deepEqual(task.passThroughEnv, ['VIVID_TEST_DATABASE_URL'], key)
  }
})

void test('a remote argument stays one word whatever it contains', () => {
  for (const argument of ['plain', 'two words', "it's", '$(touch x); `id` && *']) {
    const echoed = NodeChildProcess.spawnSync('sh', ['-c', `printf %s ${shellWord(argument)}`], {
      encoding: 'utf8',
    })
    assert.equal(echoed.stdout, argument)
  }
})

void test('a lock is exclusive, and the kernel frees it when its owner ends', async () => {
  const name = `test-${process.pid}-${Date.now()}`
  const release = await takeLock(name)
  assert.notEqual(release, undefined)
  assert.equal(await takeLock(name), undefined)
  release()
  // Another process takes the lock and is killed without releasing it.
  const holder = NodeChildProcess.spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { takeLock } from ${JSON.stringify(NodeURL.pathToFileURL(NodePath.join(repositoryRoot, 'scripts/gate/slots.mjs')).href)}
       const held = await takeLock(${JSON.stringify(name)})
       console.log(held === undefined ? 'refused' : 'held')
       setInterval(() => {}, 1000)`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  )
  const [line] = await NodeEvents.once(holder.stdout, 'data')
  assert.equal(String(line).trim(), 'held')
  assert.equal(await takeLock(name), undefined)
  holder.kill('SIGKILL')
  await NodeEvents.once(holder, 'close')
  const after = await takeLock(name)
  assert.notEqual(after, undefined)
  after()
  assert.equal(slotCount(8), 2)
  assert.equal(slotCount(2), 1)
})

void test('arguments select a mode, and an unknown stage is refused', () => {
  assert.equal(parse([]).mode, 'full')
  assert.deepEqual(parse(['focused', 'a.test.ts', 'b.test.ts']).files, ['a.test.ts', 'b.test.ts'])
  assert.equal(parse(['everything']).mode, 'help')
  assert.deepEqual(selectStages(undefined), stageNames)
  assert.deepEqual(selectStages('lint, format'), ['lint', 'format'])
  assert.throws(() => selectStages('lint,tests'), /unknown stage tests/u)
})

void test('the verdict names the commit, the run and every failing stage', () => {
  const outcome = {
    runId: 'run1',
    seconds: 12.34,
    counts: { tests: 10, skipped: 1, files: 2 },
    results: [
      { name: 'lint', seconds: 1, failed: [], detail: '13/13 cached', log: 'lint.log' },
      {
        name: 'test',
        seconds: 9,
        failed: ['@vivid/server#test'],
        detail: '10/11 cached',
        log: 'test.log',
      },
    ],
  }
  const failed = report(outcome, { mode: 'full', sha: 'abc123' })
  assert.equal(failed.passed, false)
  assert.match(
    failed.text,
    /gate full FAIL \(test\) sha=abc123 run=run1 12\.3s tests=10 skipped=1 files=2\n$/u,
  )
  assert.match(failed.text, /@vivid\/server#test/u)
  outcome.results[1].failed = []
  const passed = report(outcome, { mode: 'full', sha: 'abc123' })
  assert.equal(passed.passed, true)
  assert.match(passed.text, /gate full PASS sha=abc123/u)
})

void test('a snapshot carries uncommitted work without touching the index or the branch', (t) => {
  const { root, env } = repository(t)
  const head = git(root, ['rev-parse', 'HEAD'], env)
  assert.equal(snapshot(root, env, false).sha, head)
  NodeFS.writeFileSync(NodePath.join(root, 'kept.txt'), 'edited\n')
  NodeFS.writeFileSync(NodePath.join(root, 'new.txt'), 'untracked\n')
  const status = git(root, ['status', '--porcelain'], env)
  const taken = snapshot(root, env, false)
  assert.notEqual(taken.sha, head)
  assert.equal(taken.label, `${head.slice(0, 12)}+uncommitted`)
  assert.equal(git(root, ['show', `${taken.sha}:kept.txt`], env), 'edited')
  assert.equal(git(root, ['show', `${taken.sha}:new.txt`], env), 'untracked')
  assert.equal(git(root, ['rev-parse', 'HEAD'], env), head)
  assert.equal(git(root, ['status', '--porcelain'], env), status)
  assert.equal(snapshot(root, env, true).sha, head)
})

void test('a tree name is one lower-case word made from the branch', (t) => {
  const { root, env } = repository(t)
  assert.equal(treeName(root, env, undefined), 'main')
  assert.equal(treeName(root, env, 'feat/Fast_Gate'), 'feat-fast-gate')
  assert.throws(() => treeName(root, env, '///'), /--name/u)
})

/**
 * The failure this guards: git 2.54 exports GIT_DIR to a hook when the push comes from a linked
 * worktree. A tooling test that then ran `git add` in a temporary repository of its own wrote
 * into the pushing worktree's index. The hook here is a real pre-push hook on a real push from a
 * linked worktree; it runs the gate's own cleaning and then does what those tests do.
 */
void test('a push from a linked worktree cannot reach that worktree through the hook environment', (t) => {
  const { root, env } = repository(t)
  const remote = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-gate-remote-'))
  const linked = `${root}-linked`
  const probe = NodePath.join(root, 'probe.mjs')
  t.after(() => {
    NodeFS.rmSync(remote, { recursive: true, force: true })
    NodeFS.rmSync(linked, { recursive: true, force: true })
  })
  git(remote, ['init', '--quiet', '--bare'], env)
  git(root, ['worktree', 'add', '--quiet', '-b', 'linked', linked], env)
  NodeFS.writeFileSync(
    probe,
    `import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import { withoutRepositoryEnvironment } from ${JSON.stringify(NodePath.join(repositoryRoot, 'scripts/gate.mjs'))}
const inherited = process.env.GIT_DIR !== undefined
const env = withoutRepositoryEnvironment(process.env)
const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-gate-scratch-'))
const run = (args) => NodeChildProcess.spawnSync('git', args, { cwd: scratch, env, encoding: 'utf8' })
run(['init', '--quiet'])
NodeFS.writeFileSync(NodePath.join(scratch, 'fixture.txt'), 'fixture')
run(['add', '.'])
const top = NodeFS.realpathSync(run(['rev-parse', '--show-toplevel']).stdout.trim())
NodeFS.writeFileSync(${JSON.stringify(NodePath.join(root, 'probe.json'))}, JSON.stringify({ inherited, top, scratch: NodeFS.realpathSync(scratch) }))
NodeFS.rmSync(scratch, { recursive: true, force: true })
`,
  )
  const hooks = NodePath.join(root, 'hooks')
  NodeFS.mkdirSync(hooks)
  NodeFS.writeFileSync(NodePath.join(hooks, 'pre-push'), `#!/bin/sh\nexec node ${probe}\n`, {
    mode: 0o755,
  })
  git(root, ['config', 'core.hooksPath', hooks], env)
  git(linked, ['push', '--quiet', remote, 'linked'], env)
  const seen = decodeProbe(NodeFS.readFileSync(NodePath.join(root, 'probe.json'), 'utf8'))
  // git did export its repository to the hook, so the case below is the real one.
  assert.equal(seen.inherited, true)
  assert.equal(seen.top, seen.scratch)
  assert.equal(git(linked, ['status', '--porcelain'], env), '')
  assert.equal(git(linked, ['ls-files'], env), 'kept.txt')
})

test('the gate refuses the Vivid Computer under any name, and no other machine', () => {
  // What `ssh -G` printed for each name on 7 October 2026: `vivid-boat` had pointed at the
  // production Vivid Computer for four days, and the gates sent there filled its disk.
  const vivid = [
    'host vivid-boat',
    'hostname cloudbox-vivid',
    "proxycommand sh -c 'cd /home/user/cloudbox-vivid && exec node cli.mjs boat proxy vivid %p'",
  ].join('\n')
  const renamed = [
    'host builder',
    'hostname builder.internal',
    "proxycommand sh -c 'exec node cli.mjs boat proxy vivid %p'",
  ].join('\n')
  const ci = [
    'host vivid-boat',
    'hostname cloudbox-konan',
    "proxycommand sh -c 'exec node cli.mjs boat proxy konan %p'",
  ].join('\n')
  assert.match(refusedHost(vivid), /production Vivid Computer/u)
  // The machine is refused, not the alias: another name for it does not get through.
  assert.match(refusedHost(renamed), /production Vivid Computer/u)
  assert.equal(refusedHost(ci), undefined)
  assert.equal(refusedHost('host plain\nhostname 10.0.0.7'), undefined)
})
