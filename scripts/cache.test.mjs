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
const repositoryRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  '..',
)
const turbo = NodePath.join(repositoryRoot, 'node_modules/turbo/bin/turbo')

// Validate the fields the fixture changes while preserving the real dependency
// declarations and other manifest metadata that Turbo uses to construct hashes.
const FixtureManifest = Schema.StructWithRest(
  Schema.Struct({ scripts: Schema.Record(Schema.String, Schema.String) }),
  [Schema.Record(Schema.String, Schema.Json)],
)
const decodeFixtureManifest = Schema.decodeUnknownSync(Schema.fromJsonString(FixtureManifest))
const TurboRun = Schema.Struct({
  tasks: Schema.Array(
    Schema.Struct({
      taskId: Schema.String,
      hash: Schema.String,
      command: Schema.String,
    }),
  ),
})
const decodeTurboRun = Schema.decodeUnknownSync(Schema.fromJsonString(TurboRun))

/** Run the pinned real Turbo binary; probes replace only expensive check commands. */
function runTurbo(root, args) {
  const result = NodeChildProcess.spawnSync(process.execPath, [turbo, 'run', ...args], {
    cwd: root,
    env: { ...process.env, CI: '1', TURBO_TELEMETRY_DISABLED: '1' },
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  return result
}

/** Keep the actual config, package relationships and lockfile in an isolated repo. */
function fixture(t) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-cache-'))
  t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }))
  for (const file of [
    'turbo.json',
    'pnpm-workspace.yaml',
    'pnpm-lock.yaml',
    '.gitignore',
    '.oxlintrc.json',
    'tsconfig.base.json',
    'tsconfig.json',
  ]) {
    NodeFS.copyFileSync(NodePath.join(repositoryRoot, file), NodePath.join(root, file))
  }
  const packages = NodeFS.readFileSync(NodePath.join(root, 'pnpm-workspace.yaml'), 'utf8')
    .split('\n\n')[0]
    .split('\n')
    .filter((line) => line.startsWith("  - '"))
    .map((line) => line.slice(5, -1))
  for (const directory of ['', ...packages]) {
    NodeFS.mkdirSync(NodePath.join(root, directory, 'src'), { recursive: true })
    const manifest = decodeFixtureManifest(
      NodeFS.readFileSync(NodePath.join(repositoryRoot, directory, 'package.json'), 'utf8'),
    )
    const probe = `${'../'.repeat(directory.split('/').filter(Boolean).length)}probe.mjs`
    for (const task of Object.keys(manifest.scripts)) {
      if (task === 'lint' || task === 'typecheck' || task === 'types' || task.endsWith(':root')) {
        manifest.scripts[task] = `node ${probe} ${task}`
      }
    }
    NodeFS.writeFileSync(NodePath.join(root, directory, 'package.json'), JSON.stringify(manifest))
    NodeFS.writeFileSync(
      NodePath.join(root, directory, 'src', 'probe.ts'),
      'export const probe = 1\n',
    )
    const config = NodePath.join(repositoryRoot, directory, 'tsconfig.json')
    if (directory !== '' && NodeFS.existsSync(config)) {
      NodeFS.copyFileSync(config, NodePath.join(root, directory, 'tsconfig.json'))
    }
  }
  for (const file of [
    'scripts/lint.mjs',
    'scripts/types.mjs',
    'scripts/oxlint-plugin-vivid.mjs',
    'tools/oxlint/probe.ts',
    'apps/web/src/styles/probe.css',
  ]) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, file)), { recursive: true })
    NodeFS.writeFileSync(NodePath.join(root, file), '// shared input\n')
  }
  NodeFS.writeFileSync(
    NodePath.join(root, 'probe.mjs'),
    `
import * as fs from 'node:fs'
const task = process.argv[2]
fs.mkdirSync('.cache/typescript', { recursive: true })
fs.appendFileSync('.cache/executions', task + '\\n')
if (task.startsWith('typecheck')) {
  fs.writeFileSync('.cache/typescript/' + (task.endsWith(':root') ? 'root' : 'tsconfig') + '.tsbuildinfo', 'cached build info')
}
if (task === 'types') {
  fs.mkdirSync('.cache/typescript/types', { recursive: true })
  fs.writeFileSync('.cache/typescript/types/probe.d.ts', 'export declare const probe: number')
  fs.writeFileSync('.cache/typescript/types.tsbuildinfo', 'cached declaration build info')
}
console.log('typescript(no-explicit-any): probe diagnostic')
`,
  )
  for (const args of [
    ['init', '--quiet'],
    ['add', '.'],
  ]) {
    const result = NodeChildProcess.spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  return root
}

/** Observe downstream hashes directly instead of asserting literal config entries. */
function hashes(root) {
  const result = runTurbo(root, [
    'build',
    'types',
    'format:root',
    'lint',
    'lint:root',
    'typecheck',
    'typecheck:root',
    '--dry=json',
  ])
  const tasks = decodeTurboRun(result.stdout).tasks
  return new Map(tasks.map((task) => [task.taskId, task]))
}

/** Shared rule and compiler changes must invalidate successful checks. */
void test('shared lint and TypeScript inputs invalidate the correct cached tasks', (t) => {
  const root = fixture(t)
  const initial = hashes(root)
  NodeFS.appendFileSync(NodePath.join(root, 'tsconfig.base.json'), '\n ')
  const compiler = hashes(root)
  assert.notEqual(
    initial.get('@vivid/web#typecheck').hash,
    compiler.get('@vivid/web#typecheck').hash,
  )
  assert.notEqual(initial.get('@vivid/web#build').hash, compiler.get('@vivid/web#build').hash)
  assert.notEqual(initial.get('@vivid/web#lint').hash, compiler.get('@vivid/web#lint').hash)
  NodeFS.appendFileSync(NodePath.join(root, 'scripts/oxlint-plugin-vivid.mjs'), '// rule change\n')
  const plugin = hashes(root)
  assert.notEqual(compiler.get('@vivid/web#lint').hash, plugin.get('@vivid/web#lint').hash)
  assert.equal(compiler.get('@vivid/web#typecheck').hash, plugin.get('@vivid/web#typecheck').hash)
  NodeFS.appendFileSync(NodePath.join(root, 'scripts/types.mjs'), '// compiler runner change\n')
  const runner = hashes(root)
  assert.notEqual(
    plugin.get('@vivid/contracts#types').hash,
    runner.get('@vivid/contracts#types').hash,
  )
  assert.notEqual(plugin.get('@vivid/web#typecheck').hash, runner.get('@vivid/web#typecheck').hash)
  assert.equal(plugin.get('@vivid/web#lint').hash, runner.get('@vivid/web#lint').hash)
})

/** tsgolint reopens referenced source, so declaration emission must not delay lint. */
void test('lint checks every workspace without executing declaration producers', (t) => {
  const root = fixture(t)
  runTurbo(root, ['lint', 'lint:root', '--concurrency=1', '--ui=stream'])
  const receipts = []
  for (const directory of [
    '',
    'apps/desktop',
    'apps/mobile',
    'apps/server',
    'apps/web',
    'packages/contracts',
    'packages/client/rpc',
    'packages/computer/state',
    'packages/client/state',
    'packages/design/marks',
    'packages/design/tokens',
    'packages/agent/runtime',
    'packages/agent/skills',
  ]) {
    receipts.push(NodeFS.readFileSync(NodePath.join(root, directory, '.cache/executions'), 'utf8'))
  }
  assert.equal(receipts.filter((receipt) => receipt === 'lint\n').length, 12)
  assert.equal(receipts.filter((receipt) => receipt === 'lint:root\n').length, 1)
})

/** Contracts still invalidate consumers when their declarations are generated separately. */
void test('dependency source invalidates consumers while unrelated leaf checks stay reusable', (t) => {
  const root = fixture(t)
  const initial = hashes(root)
  NodeFS.appendFileSync(
    NodePath.join(root, 'packages/contracts/src/probe.ts'),
    'export const changed = 2\n',
  )
  const changed = hashes(root)
  for (const task of ['lint', 'typecheck']) {
    assert.notEqual(initial.get(`@vivid/web#${task}`).hash, changed.get(`@vivid/web#${task}`).hash)
    assert.equal(
      initial.get(`@vivid/computer#${task}`).hash,
      changed.get(`@vivid/computer#${task}`).hash,
    )
  }
  assert.notEqual(initial.get('//#typecheck:root').hash, changed.get('//#typecheck:root').hash)
  assert.notEqual(initial.get('@vivid/client-runtime#lint').command, '<NONEXISTENT>')
})

/** Test-only edits must rerun their owner without rebuilding production or its consumers. */
void test('shared tests do not invalidate production declarations or ordinary consumers', (t) => {
  const root = fixture(t)
  const initial = hashes(root)
  NodeFS.writeFileSync(
    NodePath.join(root, 'packages/contracts/src/probe.test.ts'),
    'export const checked = 1\n',
  )
  const changed = hashes(root)
  for (const task of ['lint', 'typecheck']) {
    assert.notEqual(
      initial.get(`@vivid/contracts#${task}`).hash,
      changed.get(`@vivid/contracts#${task}`).hash,
    )
    for (const consumer of ['client-runtime', 'state', 'web', 'mobile', 'desktop']) {
      assert.equal(
        initial.get(`@vivid/${consumer}#${task}`).hash,
        changed.get(`@vivid/${consumer}#${task}`).hash,
      )
    }
  }
  for (const producer of ['contracts', 'client-runtime', 'state', 'skills', 'agent-runtime']) {
    assert.equal(
      initial.get(`@vivid/${producer}#types`).hash,
      changed.get(`@vivid/${producer}#types`).hash,
    )
  }
})

/**
 * A package's source invalidates the checks of the packages that declare it and no others. Since
 * `vivid/no-cross-package-import` no package reaches another by path, so the manifest edges are the
 * whole graph: the server takes the runtime as a devDependency, and the skills package, which the
 * runtime depends on, does not depend on the runtime.
 */
void test('runtime source invalidates its dependents and no other package', (t) => {
  const root = fixture(t)
  const initial = hashes(root)
  NodeFS.appendFileSync(
    NodePath.join(root, 'packages/agent/runtime/src/probe.ts'),
    'export const changed = 2\n',
  )
  const changed = hashes(root)
  for (const task of ['lint', 'typecheck']) {
    assert.notEqual(
      initial.get(`@vivid/server#${task}`).hash,
      changed.get(`@vivid/server#${task}`).hash,
    )
    for (const unrelated of ['skills', 'computer']) {
      assert.equal(
        initial.get(`@vivid/${unrelated}#${task}`).hash,
        changed.get(`@vivid/${unrelated}#${task}`).hash,
      )
    }
  }
})

/** Consumers need restored declarations, not just a successful cached compiler log. */
void test('declaration cache restores types before a consumer runs', (t) => {
  const root = fixture(t)
  const args = ['types', '--filter=@vivid/contracts', '--concurrency=1', '--ui=stream']
  runTurbo(root, args)
  const packageRoot = NodePath.join(root, 'packages/contracts')
  const outputs = NodePath.join(packageRoot, '.cache/typescript')
  const executions = NodeFS.readFileSync(NodePath.join(packageRoot, '.cache/executions'), 'utf8')
  NodeFS.rmSync(outputs, { recursive: true })
  runTurbo(root, args)
  assert.equal(
    NodeFS.readFileSync(NodePath.join(packageRoot, '.cache/executions'), 'utf8'),
    executions,
  )
  assert.equal(
    NodeFS.readFileSync(NodePath.join(outputs, 'types/probe.d.ts'), 'utf8'),
    'export declare const probe: number',
  )
  assert.equal(
    NodeFS.readFileSync(NodePath.join(outputs, 'types.tsbuildinfo'), 'utf8'),
    'cached declaration build info',
  )
})

/** Cached logs must preserve ratchets, and incremental outputs must actually restore. */
void test('cache hits replay diagnostics and restore build info without executing checks again', (t) => {
  const root = fixture(t)
  const args = [
    'lint',
    'typecheck',
    '--filter=@vivid/computer',
    '--concurrency=1',
    '--ui=stream',
    '--output-logs=full',
    '--cache=local:rw',
  ]
  const first = runTurbo(root, args)
  const packageRoot = NodePath.join(root, 'packages/computer/state')
  const executions = NodeFS.readFileSync(NodePath.join(packageRoot, '.cache/executions'), 'utf8')
  const buildInfo = NodePath.join(packageRoot, '.cache/typescript/tsconfig.tsbuildinfo')
  NodeFS.rmSync(buildInfo)
  const cached = runTurbo(root, args)
  assert.equal(
    NodeFS.readFileSync(NodePath.join(packageRoot, '.cache/executions'), 'utf8'),
    executions,
  )
  assert.equal(NodeFS.readFileSync(buildInfo, 'utf8'), 'cached build info')
  assert.match(cached.stdout, /typescript\(no-explicit-any\): probe diagnostic/u)
  assert.equal(
    Array.from(cached.stdout.matchAll(/typescript\(no-explicit-any\): probe diagnostic/gu)).length,
    Array.from(first.stdout.matchAll(/typescript\(no-explicit-any\): probe diagnostic/gu)).length,
  )
})

/** Explicit root globs must not hash dependency shims, task logs or build output. */
void test('root checks ignore generated workspace files and reuse successful results', (t) => {
  const root = fixture(t)
  const initial = hashes(root)
  for (const file of [
    'apps/web/.cache/typescript/tsconfig.tsbuildinfo',
    'apps/web/.turbo/turbo-lint.log',
    'apps/web/node_modules/.bin/tsc',
    'apps/web/dist/probe.js',
    'apps/web/.env.local',
    'apps/mobile/ios/generated.js',
  ]) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, file)), { recursive: true })
    NodeFS.writeFileSync(NodePath.join(root, file), 'generated state')
  }
  const generated = hashes(root)
  for (const task of ['lint:root', 'typecheck:root', 'format:root']) {
    assert.equal(initial.get(`//#${task}`).hash, generated.get(`//#${task}`).hash)
  }
  const args = ['lint:root', 'typecheck:root', 'format:root', '--concurrency=1', '--ui=stream']
  runTurbo(root, args)
  const executions = NodeFS.readFileSync(NodePath.join(root, '.cache/executions'), 'utf8')
  runTurbo(root, args)
  assert.equal(NodeFS.readFileSync(NodePath.join(root, '.cache/executions'), 'utf8'), executions)
})
