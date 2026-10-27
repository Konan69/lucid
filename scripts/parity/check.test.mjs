import * as NodeAssert from 'node:assert/strict'
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeTest from 'node:test'

/** Real git objects prove ref isolation and prevent an old runtime hiding a missing port. */
NodeTest.test(
  'checks the requested commit, feature mapping and the replacement runtime',
  (context) => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-parity-'))
    context.after(() => NodeFS.rmSync(root, { recursive: true, force: true }))
    const git = (...args) =>
      NodeChildProcess.execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    const write = (path, text) => {
      NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, path)), { recursive: true })
      NodeFS.writeFileSync(NodePath.join(root, path), text)
    }
    const commit = () => {
      git('add', '.')
      git(
        '-c',
        'user.name=Parity',
        '-c',
        'user.email=parity@example.invalid',
        'commit',
        '-qm',
        'fixture',
      )
      return git('rev-parse', 'HEAD').trim()
    }
    const run = (ref) =>
      NodeChildProcess.spawnSync(
        process.execPath,
        [NodePath.join(root, 'scripts/parity/check.mjs'), ref],
        {
          cwd: NodeOS.tmpdir(),
          encoding: 'utf8',
        },
      )
    git('init', '-q')
    write(
      'scripts/parity/check.mjs',
      NodeFS.readFileSync(new URL('./check.mjs', import.meta.url), 'utf8'),
    )
    write(
      'scripts/parity/behaviours.tsv',
      [
        'id\tbehaviour\tmain_commits\tsurface\tcheck',
        'offer\tI can tap a reply\tfixture\truntime\t' +
          JSON.stringify([
            {
              paths: [
                'packages/agent/runtime/src/tools/follow.ts',
                'packages/agent/durable/src/tools/follow.ts',
              ],
              text: 'suggest_replies',
            },
          ]),
        'first\tI can send\tfixture\tweb\t' + JSON.stringify([{ feature: 'first' }]),
        '',
      ].join('\n'),
    )
    write('packages/agent/runtime/src/tools/follow.ts', 'suggest_replies')
    write('.agents/skills/verify-vivid/features/first.md', 'First message')
    write('.agents/skills/verify-vivid/features/README.md', '[First](first.md)')
    const original = commit()
    NodeAssert.equal(run(original).status, 0)

    write('packages/agent/runtime/src/tools/follow.ts', 'dirty file without the tool')
    NodeAssert.equal(run(original).status, 0)
    write('packages/agent/runtime/src/tools/follow.ts', 'suggest_replies')
    write('packages/agent/durable/src/main.ts', 'replacement entry')
    write('packages/agent/durable/src/tools/follow.ts', 'missing tool')
    write('.agents/skills/verify-vivid/features/README.md', 'unmapped')
    const replacement = commit()
    const missing = run(replacement)
    NodeAssert.equal(missing.status, 1)
    NodeAssert.match(missing.stdout, /MISSING\toffer\t/u)
    NodeAssert.match(missing.stdout, /MISSING\tfirst\t/u)
    NodeAssert.match(missing.stdout, /PASS=0 MISSING=2 TOTAL=2/u)
    NodeAssert.equal(run(original).status, 0)
    write('packages/agent/durable/src/tools/follow.ts', 'suggest_replies')
    write('.agents/skills/verify-vivid/features/README.md', '[First](first.md)')
    NodeAssert.equal(run(commit()).status, 0)
    NodeAssert.notEqual(run('not-a-ref').status, 0)
  },
)
