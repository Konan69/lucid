import * as NodeAssert from 'node:assert/strict'
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeTest from 'node:test'
import * as NodeURL from 'node:url'
import { formatProof, proveBranch, proofSelection } from '../proof.mjs'
import { testBodies } from './source.mjs'
import { scratchTree } from './tree.mjs'

const root = NodePath.resolve(NodeURL.fileURLToPath(new URL('../../', import.meta.url)))

/** Historical objects are deliberately required; these proofs run explicitly on a full clone. */
function git(directory, args, input) {
  const result = NodeChildProcess.spawnSync('git', args, {
    cwd: directory,
    input,
    encoding: 'utf8',
  })
  NodeAssert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

const replays = [
  { sha: '002aef1f', module: 'activity', name: 'says a built-in way of working' },
  { sha: 'dd4b8c56', module: 'mend', name: 'closes a fence with the marker and indent' },
  { sha: 'b54686ee', module: 'sync', name: 'are left waiting, and nothing is written' },
]

/** Retain old adapter capabilities so the reverted implementation can reach its assertion. */
function assertionReachable(module, source) {
  // Count a forbidden write rather than recursively reentering until the stack overflows.
  if (module === 'sync') return source.replace('        sync.changed()\n', '')
  return source
}

for (const replay of replays)
  void NodeTest.test(
    `historical regression ${replay.sha} proves its named assertion`,
    async (t) => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-proof-history-'))
      t.after(() => NodeFS.rmSync(directory, { recursive: true, force: true }))
      const target = scratchTree(root, directory, git(root, ['rev-parse', 'HEAD']))
      git(target, ['config', 'user.name', 'proof'])
      git(target, ['config', 'user.email', 'proof@localhost'])
      const code = `packages/client/state/src/${replay.module}.ts`
      const test = `packages/client/state/src/${replay.module}.test.ts`
      const historical = `${git(root, ['diff', `${replay.sha}^`, replay.sha, '--', code])}\n`
      // The parser was later exported for consumers; replay its algorithm while keeping that API.
      const patch =
        replay.module === 'mend'
          ? historical.replaceAll(/^(?<sign>[+-])const FENCE/gmu, '$<sign>export const FENCE')
          : historical
      let tests = assertionReachable(
        replay.module,
        NodeFS.readFileSync(NodePath.join(target, test), 'utf8'),
      )
      const body = testBodies(test, tests).find((candidate) =>
        tests.split('\n')[candidate.start - 1].includes(replay.name),
      )
      NodeAssert.notEqual(body, undefined, 'historical regression still exists')
      const lines = tests.split('\n')
      const removed = [...lines]
      removed.splice(body.start - 1, body.end - body.start + 1)
      git(target, ['apply', '--reverse', '-'], patch)
      NodeFS.writeFileSync(NodePath.join(target, test), removed.join('\n'))
      git(target, ['add', code, test])
      git(target, ['commit', '--quiet', '-m', `replay ${replay.sha} broken base`])
      const base = git(target, ['rev-parse', 'HEAD'])
      git(target, ['update-ref', 'refs/remotes/origin/main', base])
      git(target, ['switch', '--quiet', '-c', `fix/replay-${replay.sha}`])
      git(target, ['apply', '-'], patch)
      NodeFS.writeFileSync(NodePath.join(target, test), tests)
      git(target, ['add', code, test])
      git(target, ['commit', '--quiet', '-m', `replay ${replay.sha} fixed`])
      const outcome = await proveBranch(target, proofSelection(target, {}), process.env)
      process.stdout.write(formatProof(outcome))
      NodeAssert.equal(outcome.passed, true)
      NodeAssert.equal(outcome.results.length, 1)
      NodeAssert.equal(outcome.results[0].state, 'PROVEN')
    },
  )
