#!/usr/bin/env node
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import * as NodeUtil from 'node:util'
import { admitHost, placedHost, push, runInTree, snapshot, ssh, treeName } from './gate/cloud.mjs'
import { withoutRepositoryEnvironment } from './gate.mjs'

const repositoryRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  '..',
)

const usage = `usage: pnpm verify <feature>... --host <cloudbox> [--committed]

  Proves the named verify-vivid features on a Cloudbox, in its warm verify tree at this
  checkout's commit (uncommitted work is sent as a snapshot, as the gate does): launch, a worthy
  doctor, each feature and its browser recipe, cleanup. The last line is the summary, with the
  evidence directory on the machine. On this PC, run .agents/skills/verify-vivid/verify run.

  --host <ssh host>  the Cloudbox (default: $VIVID_GATE_HOST, else the one devbox-pick prints)
  --committed        verify HEAD as committed, without uncommitted changes
`

/** Launch refuses below 6 GiB available (`capacity` in verify-vivid `scripts/process.mjs`). */
const verifyMegabytes = 7168

/**
 * The provider keys stay on the machine, in the private file verify-vivid reads
 * (`VIVID_VERIFY_KEY_FILE`); only its path crosses. The path is absolute on the machine, so ask
 * the machine for its home once.
 */
function keyFile(host) {
  const home = ssh(host, 'printf %s "$HOME"', [], 'pipe')
  if (home.status !== 0 || home.stdout === '') throw new Error(`could not read ${host}'s home`)
  return `${home.stdout}/.config/vivid/verify.env`
}

function main(argv, environment) {
  const { values, positionals } = NodeUtil.parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      host: { type: 'string' },
      committed: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  })
  if (values.help || positionals.length === 0) {
    process.stdout.write(usage)
    return 2
  }
  const host = values.host ?? placedHost(environment, verifyMegabytes)
  if (host === undefined) throw new Error('no Cloudbox available; name one with --host')
  const env = withoutRepositoryEnvironment(environment)
  admitHost(host)
  const name = treeName(repositoryRoot, env, undefined)
  const { sha, label } = snapshot(repositoryRoot, env, values.committed)
  push(repositoryRoot, host, `${sha}:refs/gate/${name}`, env)
  const command = [
    'env',
    `VIVID_VERIFY_DEVBOX=${host}`,
    `VIVID_VERIFY_KEY_FILE=${keyFile(host)}`,
    '.agents/skills/verify-vivid/verify',
    'run',
    ...positionals,
  ]
  return runInTree(repositoryRoot, { host, family: 'verify', name, sha, label, command })
}

try {
  process.exitCode = main(process.argv.slice(2), process.env)
} catch (error) {
  process.stderr.write(`verify FAIL: ${error.message}\n`)
  process.exitCode = 1
}
