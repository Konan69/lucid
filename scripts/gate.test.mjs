import * as NodeAssert from 'node:assert/strict'
import * as NodeChildProcess from 'node:child_process'
import * as NodeEvents from 'node:events'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeTest from 'node:test'
import * as NodeURL from 'node:url'
import * as Schema from 'effect/Schema'
import './gate/database.test.mjs'
import { withoutRepositoryEnvironment } from './gate.mjs'
import {
  followScript,
  remoteScript,
  shellWord,
  snapshot,
  snapshotIgnore,
  treeName,
} from './gate/cloud.mjs'
import { signoff } from './gate/signoff.mjs'
import { slotCount, takeLock } from './gate/slots.mjs'

const assert = NodeAssert
const test = NodeTest.default
const repositoryRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  '..',
)

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

void test('a remote argument stays one word whatever it contains', () => {
  for (const argument of ['plain', 'two words', "it's", '$(touch x); `id` && *']) {
    const echoed = NodeChildProcess.spawnSync('sh', ['-c', `printf %s ${shellWord(argument)}`], {
      encoding: 'utf8',
    })
    assert.equal(echoed.stdout, argument)
  }
})

void test('a lock is exclusive, and the kernel frees it when its owner ends', async (t) => {
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
       process.stdin.resume()`,
    ],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  )
  t.after(async () => {
    if (holder.exitCode === null && holder.signalCode === null) {
      holder.kill('SIGKILL')
      await NodeEvents.once(holder, 'close')
    }
  })
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
  // No completion receipt means ownership is unconfirmed, even when evidence is old.
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-gate-owner-'))
  t.after(() => NodeFS.rmSync(home, { recursive: true, force: true }))
  const runs = NodePath.join(home, 'vivid-gate/fast/runs')
  NodeFS.mkdirSync(runs, { recursive: true })
  const active = NodePath.join(runs, 'active.log')
  NodeFS.writeFileSync(active, 'still owned\n')
  NodeFS.utimesSync(active, new Date(0), new Date(0))
  const env = { ...withoutRepositoryEnvironment(process.env), HOME: home }
  const started = NodeChildProcess.spawnSync('bash', ['-s', '--', 'absent', 'cleanup', 'label'], {
    input: remoteScript,
    env,
    encoding: 'utf8',
  })
  assert.equal(started.status, 0, started.stderr)
  const followed = NodeChildProcess.spawnSync('bash', ['-s', '--', 'cleanup'], {
    input: followScript,
    env,
    encoding: 'utf8',
  })
  assert.equal(followed.status, 92, followed.stdout + followed.stderr)
  assert.equal(NodeFS.readFileSync(active, 'utf8'), 'still owned\n')
})

/**
 * The machine's side, run here against a temporary home: the real script the client sends, up
 * to the point where it would install. What it must hold: runs for different branches reuse the
 * same few trees (one tree per branch is how a machine's disk filled), and the snapshot ignore
 * file is in place before any tree exists.
 */
void test('the machine keeps a fixed set of warm trees and tells Boat what not to snapshot', (t) => {
  const { root, env } = repository(t)
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-gate-home-'))
  t.after(() => NodeFS.rmSync(home, { recursive: true, force: true }))
  const fast = NodePath.join(home, 'vivid-gate/fast')
  NodeFS.mkdirSync(fast, { recursive: true })
  git(fast, ['init', '--quiet', '--bare', 'repo.git'], env)
  const first = git(root, ['rev-parse', 'HEAD'], env)
  NodeFS.writeFileSync(NodePath.join(root, 'second.txt'), 'another branch\n')
  git(root, ['add', '.'], env)
  git(root, ['commit', '--quiet', '-m', 'second'], env)
  const second = git(root, ['rev-parse', 'HEAD'], env)
  git(
    root,
    [
      'push',
      '--quiet',
      NodePath.join(fast, 'repo.git'),
      `${first}:refs/gate/a`,
      `${second}:refs/gate/b`,
    ],
    env,
  )
  const machine = { ...env, HOME: home, VIVID_GATE_PREPARE_ONLY: '1' }
  const bash = (script, args) =>
    NodeChildProcess.spawnSync('bash', ['-s', '--', ...args], {
      input: script,
      env: machine,
      encoding: 'utf8',
    })
  for (const [sha, run] of [
    [first, 'run-a'],
    [second, 'run-b'],
  ]) {
    assert.equal(bash(remoteScript, [sha, run, 'label', 'full']).status, 0)
    const followed = bash(followScript, [run])
    assert.equal(followed.status, 0, followed.stdout + followed.stderr)
    assert.match(followed.stdout, /slot-0/u)
  }
  const trees = NodeFS.readdirSync(NodePath.join(fast, 'trees')).filter(
    (name) => !name.endsWith('.lock'),
  )
  assert.deepEqual(trees, ['slot-0'])
  assert.equal(git(NodePath.join(fast, 'trees/slot-0'), ['rev-parse', 'HEAD'], env), second)
  assert.deepEqual(
    NodeFS.readFileSync(NodePath.join(fast, '.boxignore'), 'utf8').trim().split('\n'),
    snapshotIgnore,
  )
  assert.ok(snapshotIgnore.includes('node_modules/'))
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
import './gate/database.test.mjs'
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

/**
 * The push hook's case: the commit is not on GitHub yet. A stand-in `gh` refuses a status for a
 * commit the remote does not have, as GitHub does, so the status can only land if the commit was
 * sent ahead first; the ref it travelled under must be gone afterwards.
 */
void test('a commit that has not been pushed is sent ahead, signed as the pusher, and its ref removed', () => {
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'gate-signoff-'))
  try {
    const bare = NodePath.join(scratch, 'remote.git')
    const work = NodePath.join(scratch, 'work')
    const bin = NodePath.join(scratch, 'bin')
    const posted = NodePath.join(scratch, 'posted')
    NodeFS.mkdirSync(work)
    NodeFS.mkdirSync(bin)
    git(scratch, ['init', '--quiet', '--bare', bare])
    git(work, ['init', '--quiet'])
    git(work, ['config', 'user.email', 'gate@example.com'])
    git(work, ['config', 'user.name', 'Gate'])
    git(work, ['commit', '--quiet', '--allow-empty', '-m', 'work'])
    git(work, ['remote', 'add', 'origin', 'https://github.com/acme/thing.git'])
    git(work, ['config', `url.${bare}.insteadOf`, 'https://github.com/acme/thing.git'])
    const sha = git(work, ['rev-parse', 'HEAD'])
    NodeFS.writeFileSync(
      NodePath.join(bin, 'gh'),
      [
        '#!/bin/sh',
        `git --git-dir="${bare}" cat-file -e "${sha}" 2>/dev/null || exit 1`,
        `git --git-dir="${bare}" for-each-ref --format='%(refname)' > "${posted}.refs"`,
        `printf '%s\\n' "$@" > "${posted}"`,
        `printf '%s' "$GH_TOKEN" > "${posted}.token"`,
      ].join('\n'),
      { mode: 0o755 },
    )
    // The credential git pushes this repository with; no developer's own configuration is read.
    git(work, [
      'config',
      'credential.helper',
      '!f() { echo username=pusher; echo password=pushing-credential; }; f',
    ])
    const environment = {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      PATH: `${bin}${NodePath.delimiter}${process.env.PATH}`,
    }
    const said = signoff(work, withoutRepositoryEnvironment(environment), 'a test machine')
    assert.match(said, new RegExp(`^signoff gate sha=${sha.slice(0, 12)} on acme/thing`, 'u'))
    const args = NodeFS.readFileSync(posted, 'utf8').split('\n')
    assert.ok(args.includes(`repos/acme/thing/statuses/${sha}`))
    assert.ok(args.includes('context=gate'))
    assert.ok(args.includes('state=success'))
    // Signed as whoever pushes, not as whichever account `gh` happens to have active.
    assert.equal(NodeFS.readFileSync(`${posted}.token`, 'utf8'), 'pushing-credential')
    assert.equal(NodeFS.readFileSync(`${posted}.refs`, 'utf8').trim(), `refs/gate/${sha}`)
    assert.equal(git(scratch, ['--git-dir', bare, 'for-each-ref']), '')
  } finally {
    NodeFS.rmSync(scratch, { recursive: true, force: true })
  }
})
