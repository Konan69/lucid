import * as NodeAssert from 'node:assert/strict'
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import { workspaceManifestPaths } from '../versions.mjs'

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), '../..')
const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-hermes-proof-'))

/** Historical files are restored only into an archive, never into the author's checkout. */
function prepare() {
  const archive = NodeChildProcess.spawnSync('git', ['archive', 'HEAD'], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  })
  NodeAssert.equal(archive.status, 0, String(archive.stderr))
  const unpack = NodeChildProcess.spawnSync('tar', ['-x', '-C', scratch], { input: archive.stdout })
  NodeAssert.equal(unpack.status, 0, String(unpack.stderr))
  const directories = ['.', ...workspaceManifestPaths(root).map((path) => NodePath.dirname(path))]
  for (const directory of directories) {
    const dependencies = NodePath.join(root, directory, 'node_modules')
    if (NodeFS.existsSync(dependencies)) {
      NodeFS.symlinkSync(dependencies, NodePath.join(scratch, directory, 'node_modules'))
    }
  }
}

/** The public mobile checker rebuilds declarations as well as checking the production app. */
function types() {
  return NodeChildProcess.spawnSync(
    process.execPath,
    ['../../scripts/types.mjs', 'tsconfig.types.json'],
    {
      cwd: NodePath.join(scratch, 'apps/mobile'),
      env: Object.fromEntries(
        Object.entries(process.env).filter(([name]) => name !== 'TURBO_HASH'),
      ),
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    },
  )
}

/** Require the named diagnostic on the restored file; an unrelated setup failure proves nothing. */
function replayTypes(revision, file, diagnostic) {
  const target = NodePath.join(scratch, file)
  const original = NodeFS.readFileSync(target)
  const historical = NodeChildProcess.spawnSync('git', ['show', `${revision}:${file}`], {
    cwd: root,
  })
  NodeAssert.equal(historical.status, 0, String(historical.stderr))
  NodeFS.writeFileSync(target, historical.stdout)
  try {
    const result = types()
    const output = result.stdout + result.stderr
    NodeAssert.notEqual(result.status, 0, output)
    const line = output.split('\n').find((entry) => diagnostic.test(entry))
    NodeAssert.ok(line, output)
    process.stdout.write(`${revision} rejected: ${line}\n`)
  } finally {
    NodeFS.writeFileSync(target, original)
  }
}

/** Lint the actual historical relative-time implementation with the repository's real config. */
function replayLint() {
  const file = 'packages/client/state/src/when.ts'
  const target = NodePath.join(scratch, file)
  const original = NodeFS.readFileSync(target)
  const historical = NodeChildProcess.spawnSync('git', ['show', `fa8e8169^:${file}`], { cwd: root })
  NodeAssert.equal(historical.status, 0, String(historical.stderr))
  NodeFS.writeFileSync(target, historical.stdout)
  try {
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      ['node_modules/oxlint/bin/oxlint', '--threads=1', file],
      { cwd: scratch, encoding: 'utf8' },
    )
    const output = result.stdout + result.stderr
    NodeAssert.notEqual(result.status, 0, output)
    NodeAssert.match(output, /Intl.RelativeTimeFormat/u)
    NodeAssert.match(output, /no-restricted-properties/u)
    process.stdout.write('fa8e8169^ rejected: no-restricted-properties Intl.RelativeTimeFormat\n')
  } finally {
    NodeFS.writeFileSync(target, original)
  }
}

/** Ambient Node types and newer lib references must not silently expand either production project. */
function rejectGlobals() {
  const mobile = 'apps/mobile/src/hermesprobe.ts'
  const contracts = 'packages/contracts/src/hermesprobe.ts'
  const probes = [
    [
      mobile,
      'export {}; new DisposableStack(); new Float16Array(1); Buffer.from("x"); setImmediate(() => {});',
    ],
    [contracts, 'export {}; document.title; window.location;'],
  ]
  for (const [file, source] of probes) {
    const path = NodePath.join(scratch, file)
    NodeAssert.ok(!NodeFS.existsSync(path), `${file} must be a fresh probe`)
    NodeFS.writeFileSync(path, source)
    try {
      const result = types()
      const output = result.stdout + result.stderr
      NodeAssert.notEqual(result.status, 0, output)
      const names =
        file === mobile ? ['DisposableStack', 'Float16Array', 'Buffer'] : ['document', 'window']
      // React Native declares setImmediate itself in src/types/globals.d.ts; it does not imply Node types.
      if (file === mobile) NodeAssert.doesNotMatch(output, /error TS\d+:[^\n]*'setImmediate'/u)
      for (const name of names) {
        const line = output
          .split('\n')
          .find((entry) => entry.includes('hermesprobe.ts') && entry.includes(`'${name}'`))
        NodeAssert.ok(line, output)
        process.stdout.write(`production global rejected: ${line}\n`)
      }
    } finally {
      NodeFS.rmSync(path)
    }
  }
}

try {
  prepare()
  const head = types()
  NodeAssert.equal(head.status, 0, head.stdout + head.stderr)
  process.stdout.write('HEAD mobile production typecheck passed\n')
  rejectGlobals()
  replayTypes('40dfdcce^', 'apps/mobile/src/screen/chat/asked.ts', /asked\.ts.*TS2550.*toSorted/u)
  replayTypes(
    'd5bb74f6^',
    'apps/mobile/src/data/message.ts',
    /message\.ts.*TS2339.*filter.*ArrayIterator/u,
  )
  replayLint()
} finally {
  NodeFS.rmSync(scratch, { recursive: true, force: true })
}
