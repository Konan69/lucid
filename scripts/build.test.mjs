import * as NodeAssert from 'node:assert/strict'
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeTest from 'node:test'
import * as NodeURL from 'node:url'
import * as Schema from 'effect/Schema'
import * as YAML from 'yaml'
import { runLocal } from './gate/local.mjs'
import { stageOfTask, stages } from './gate/stages.mjs'

const assert = NodeAssert
const root = NodeURL.fileURLToPath(new URL('../', import.meta.url))
const Manifest = Schema.StructWithRest(
  Schema.Struct({ scripts: Schema.Record(Schema.String, Schema.String) }),
  [Schema.Record(Schema.String, Schema.Json)],
)
const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))
const decodeEnvironment = Schema.decodeUnknownSync(Schema.Array(Schema.String))
const buildStage = stages.find((stage) => stage.name === 'build')

/** Preserve the real task graph while replacing only expensive bundlers with artifact writers. */
function fixture(t) {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-build-'))
  t.after(() => NodeFS.rmSync(directory, { recursive: true, force: true }))
  for (const file of [
    'turbo.json',
    'pnpm-workspace.yaml',
    'pnpm-lock.yaml',
    '.gitignore',
    'tsconfig.base.json',
  ])
    NodeFS.copyFileSync(NodePath.join(root, file), NodePath.join(directory, file))
  const packages = NodeFS.readFileSync(NodePath.join(root, 'pnpm-workspace.yaml'), 'utf8')
    .split('\n\n')[0]
    .split('\n')
    .filter((line) => line.startsWith("  - '"))
    .map((line) => line.slice(5, -1))
  for (const path of ['', ...packages]) {
    const target = NodePath.join(directory, path)
    NodeFS.mkdirSync(NodePath.join(target, 'src'), { recursive: true })
    const manifest = decodeManifest(
      NodeFS.readFileSync(NodePath.join(root, path, 'package.json'), 'utf8'),
    )
    const probe = `${'../'.repeat(path.split('/').filter(Boolean).length)}probe.mjs`
    if (manifest.scripts.build !== undefined) manifest.scripts.build = `node ${probe} dist/result`
    if (manifest.scripts['build:updates'] !== undefined)
      manifest.scripts['build:updates'] = `node ${probe} .cache/updates/result`
    const config = NodePath.join(root, path, 'turbo.json')
    if (path !== '' && NodeFS.existsSync(config))
      NodeFS.copyFileSync(config, NodePath.join(target, 'turbo.json'))
    NodeFS.writeFileSync(NodePath.join(target, 'package.json'), JSON.stringify(manifest))
    NodeFS.writeFileSync(NodePath.join(target, 'src/input.ts'), 'export const input = 1\n')
  }
  NodeFS.symlinkSync(
    NodePath.join(root, 'node_modules'),
    NodePath.join(directory, 'node_modules'),
    'dir',
  )
  NodeFS.writeFileSync(
    NodePath.join(directory, 'probe.mjs'),
    `
import * as fs from 'node:fs'
import * as path from 'node:path'
if (process.env.SENTRY_AUTH_TOKEN !== undefined) {
  console.error('gate passed upload credentials to a build task')
  process.exit(8)
}
if (process.env.VIVID_COMMIT === 'reject-web' && process.cwd().endsWith('/apps/web')) process.exit(7)
const output = process.argv[2]
fs.mkdirSync(path.dirname(output), { recursive: true })
fs.writeFileSync(output, 'built artifact')
console.log('artifact written')
`,
  )
  const init = NodeChildProcess.spawnSync('git', ['init', '--quiet'], {
    cwd: directory,
    encoding: 'utf8',
  })
  assert.equal(init.status, 0, init.stderr)
  const tracked = NodeChildProcess.spawnSync('git', ['add', '.'], {
    cwd: directory,
    encoding: 'utf8',
  })
  assert.equal(tracked.status, 0, tracked.stderr)
  return directory
}

void NodeTest.test(
  'build stage restores artifacts, follows shared source, and reports a failed bundler',
  async (t) => {
    assert.notEqual(buildStage, undefined, 'gate must include the production build stage')
    const directory = fixture(t)
    const environment = {
      ...process.env,
      VIVID_COMMIT: 'fixture',
      SENTRY_AUTH_TOKEN: 'fixture-must-not-reach-builds',
      VIVID_GATE_CACHE: NodePath.join(directory, '.turbo/cache'),
    }
    const run = () => runLocal(directory, { stages: ['build'], base: undefined }, environment)
    const built = await run()
    assert.equal(built.results.length, 1)
    assert.deepEqual(built.results[0].failed, [], built.results[0].output)
    const artifacts = [
      'apps/web/dist/result',
      'packages/agent/runtime/dist/result',
      'apps/mobile/.cache/updates/result',
    ]
    for (const file of artifacts) {
      assert.equal(NodeFS.readFileSync(NodePath.join(directory, file), 'utf8'), 'built artifact')
      NodeFS.rmSync(NodePath.join(directory, file))
    }
    assert.equal(NodeFS.existsSync(NodePath.join(directory, 'apps/desktop/dist/result')), false)
    assert.equal(NodeFS.existsSync(NodePath.join(directory, 'apps/mobile/dist/result')), false)
    const cached = await run()
    assert.match(
      cached.results[0].detail,
      /^3\/3 cached$/u,
      built.results[0].output + cached.results[0].output,
    )
    for (const file of artifacts)
      assert.equal(NodeFS.readFileSync(NodePath.join(directory, file), 'utf8'), 'built artifact')
    NodeFS.appendFileSync(
      NodePath.join(directory, 'packages/contracts/src/input.ts'),
      '// changed shared input\n',
    )
    const changed = await run()
    assert.match(changed.results[0].detail, /^0\/3 cached$/u)
    environment.VIVID_COMMIT = 'reject-web'
    const failed = await run()
    assert.deepEqual(failed.results[0].failed, ['@vivid/web#build'])
    assert.equal(stageOfTask('@vivid/web#build'), buildStage)
    assert.equal(stageOfTask('@vivid/mobile#build'), undefined)
  },
)

/** Package overrides must keep the shared hash and artifact contract when they change ordering. */
void NodeTest.test(
  'production build overrides retain generic inputs, outputs and environment',
  () => {
    const Config = Schema.Struct({
      tasks: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Json)),
    })
    const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Config))
    const shared = decode(NodeFS.readFileSync(NodePath.join(root, 'turbo.json'), 'utf8')).tasks
    const web = decode(NodeFS.readFileSync(NodePath.join(root, 'apps/web/turbo.json'), 'utf8'))
      .tasks.build
    const environment = decodeEnvironment(shared.build.env)
    for (const specific of [shared['@vivid/agent-runtime#build'], web]) {
      for (const field of ['inputs', 'outputs', 'passThroughEnv'])
        assert.deepEqual(specific[field], shared.build[field], `build override must keep ${field}`)
      assert.deepEqual(specific.env, [...environment, '!SENTRY_AUTH_TOKEN'])
    }
  },
)

/** Exercise the executable boundary without booting Expo or uploading maps. */
void NodeTest.test(
  'phone gate export isolates Metro, disables uploads and matches image CI',
  (t) => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-export-'))
    t.after(() => NodeFS.rmSync(directory, { recursive: true, force: true }))
    const scripts = NodePath.join(directory, 'scripts')
    NodeFS.mkdirSync(scripts)
    NodeFS.copyFileSync(
      NodePath.join(root, 'apps/mobile/scripts/export.mjs'),
      NodePath.join(scripts, 'export.mjs'),
    )
    NodeFS.writeFileSync(
      NodePath.join(scripts, 'publish.mjs'),
      `
import * as assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
assert.equal(process.env.SENTRY_AUTH_TOKEN, undefined)
assert.equal(process.env.CI, '1')
assert.equal(process.env.EXPO_NO_TELEMETRY, '1')
assert.equal(os.tmpdir(), path.resolve('.cache/metro'))
assert.equal(fs.statSync(os.tmpdir()).isDirectory(), true)
assert.equal(process.argv[2], path.resolve('.cache/updates'))
`,
    )
    const exported = NodeChildProcess.spawnSync(
      process.execPath,
      [NodePath.join(scripts, 'export.mjs')],
      {
        cwd: directory,
        env: { ...process.env, SENTRY_AUTH_TOKEN: 'fixture-must-not-reach-publisher', CI: '0' },
        encoding: 'utf8',
      },
    )
    assert.equal(exported.status, 0, exported.stderr)
  },
)

/** A missing signoff must run every shipping build on GitHub as well as in the local gate. */
void NodeTest.test('quality checks include the production build stage', () => {
  const workflow = YAML.parse(
    NodeFS.readFileSync(NodePath.join(root, '.github/workflows/quality.yml'), 'utf8'),
  )
  assert.ok(workflow.jobs.checks.strategy.matrix.include.some((job) => job.stages === 'build'))
})
