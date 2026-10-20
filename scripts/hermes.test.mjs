import * as NodeAssert from 'node:assert/strict'
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeTest from 'node:test'
import * as NodeURL from 'node:url'
import * as Schema from 'effect/Schema'
import * as Result from 'effect/Result'
import { hermesConfigErrors, mobileClosure } from './hermes.mjs'
import { workspaceManifestPaths } from './versions.mjs'

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), '..')
const assert = NodeAssert
const test = NodeTest.default

const Rules = Schema.Record(Schema.String, Schema.Unknown)
const decodeConfig = Schema.decodeUnknownResult(
  Schema.fromJsonString(
    Schema.Struct({
      rules: Rules,
      overrides: Schema.Array(
        Schema.Struct({
          files: Schema.Array(Schema.String),
          excludeFiles: Schema.optionalKey(Schema.Array(Schema.String)),
          rules: Rules,
        }),
      ),
    }),
  ),
)
const decodeOutput = Schema.decodeUnknownResult(
  Schema.fromJsonString(
    Schema.Struct({
      diagnostics: Schema.Array(
        Schema.Struct({
          message: Schema.String,
          help: Schema.optionalKey(Schema.String),
          filename: Schema.String,
        }),
      ),
    }),
  ),
)

/** Isolated configs exercise inheritance and graph traversal without compiling the product. */
function fixture(context) {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-hermes-'))
  context.after(() => NodeFS.rmSync(directory, { recursive: true, force: true }))
  const source = (path, value) => {
    const target = NodePath.join(directory, path)
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true })
    NodeFS.writeFileSync(target, value)
  }
  const write = (path, value) => source(path, JSON.stringify(value))
  source('hermes.d.ts', 'interface HermesFixture {}')
  write('profile.json', {
    compilerOptions: { lib: ['ES2022', 'DOM', 'DOM.Iterable'] },
    files: ['hermes.d.ts'],
  })
  const packages = [
    {
      path: 'apps/mobile',
      manifest: { name: '@vivid/mobile', dependencies: { shared: 'workspace:*' } },
    },
    {
      path: 'packages/shared',
      manifest: { name: 'shared', optionalDependencies: { peer: 'workspace:*' } },
    },
    {
      path: 'packages/peer',
      manifest: { name: 'peer', peerDependencies: { shared: 'workspace:*' } },
    },
    { path: 'apps/server', manifest: { name: 'server' } },
  ]
  for (const { path, manifest } of packages) {
    write(`${path}/package.json`, manifest)
    source(`${path}/src/index.ts`, 'export const value = 1')
    write(`${path}/tsconfig.json`, { extends: '../../profile.json', include: ['src'] })
  }
  return { directory, write, source, paths: packages.map(({ path }) => `${path}/package.json`) }
}

void test('effective inherited lib is enforced on the transitive phone closure, including peers and optional packages', (context) => {
  const { directory, write, paths } = fixture(context)
  assert.deepEqual(mobileClosure(directory, paths), [
    'apps/mobile',
    'packages/shared',
    'packages/peer',
  ])
  assert.deepEqual(hermesConfigErrors(directory, paths), [])
  write('packages/peer/broader.json', {
    extends: '../../profile.json',
    compilerOptions: { lib: ['ESNext', 'DOM'] },
  })
  write('packages/peer/tsconfig.json', { extends: './broader.json', include: ['src'] })
  assert.match(
    hermesConfigErrors(directory, paths).join('\n'),
    /packages\/peer\/tsconfig.json: effective lib must be ES2022/u,
  )
  write('apps/server/tsconfig.json', { compilerOptions: { lib: ['ESNext'] }, include: ['src'] })
  assert.equal(hermesConfigErrors(directory, paths).length, 1)
})

void test('tests and missing Hermes declarations cannot slip into the production project', (context) => {
  const { directory, write, source, paths } = fixture(context)
  source('packages/shared/src/example.test.ts', 'Promise.withResolvers()')
  assert.match(hermesConfigErrors(directory, paths).join('\n'), /production includes tests/u)
  write('packages/shared/tsconfig.json', {
    extends: '../../profile.json',
    files: [],
    include: ['src'],
    exclude: ['**/*.test.ts'],
  })
  assert.match(hermesConfigErrors(directory, paths).join('\n'), /include hermes.d.ts/u)
})

void test('the repository production profiles cover every runtime workspace dependency', () => {
  assert.deepEqual(hermesConfigErrors(root, workspaceManifestPaths(root)), [])
})

/** Keep the real override order, including broad mobile/test exceptions, while isolating these rules. */
void test('Hermes lint rejects missing APIs in the entire closure and permits Node tests and the guarded registry', (context) => {
  const { directory, write, source } = fixture(context)
  const config = Result.getOrThrow(
    decodeConfig(NodeFS.readFileSync(NodePath.join(root, '.oxlintrc.json'), 'utf8')),
  )
  const restricted = (rules) =>
    Object.fromEntries(Object.entries(rules).filter(([name]) => name.startsWith('no-restricted-')))
  write('oxlintrc.json', {
    plugins: [],
    categories: {},
    rules: restricted(config.rules),
    overrides: config.overrides.map((override) => ({
      files: override.files,
      excludeFiles: override.excludeFiles,
      rules: restricted(override.rules),
    })),
  })
  const closure = mobileClosure(root, workspaceManifestPaths(root))
  const probe = 'new Intl.RelativeTimeFormat(); new FinalizationRegistry(() => {}); [1].toSorted();'
  for (const path of closure) source(`${path}/src/probe.ts`, probe)
  source('apps/mobile/src/probe.test.ts', probe)
  source('apps/server/src/probe.ts', probe)
  source(
    'packages/client/state/src/live.ts',
    'typeof FinalizationRegistry; new FinalizationRegistry(() => {});',
  )
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [
      NodePath.join(root, 'node_modules/oxlint/bin/oxlint'),
      '-c',
      'oxlintrc.json',
      '--format=json',
      '--threads=1',
      '.',
    ],
    { cwd: directory, encoding: 'utf8' },
  )
  const output = Result.getOrThrow(decodeOutput(result.stdout))
  const findings = output.diagnostics.filter(
    (diagnostic) =>
      diagnostic.message.includes('Hermes') ||
      (diagnostic.help !== undefined && diagnostic.help.includes('Hermes')),
  )
  assert.equal(result.status, 1, result.stderr)
  assert.equal(findings.length, closure.length * 3, result.stdout)
  for (const path of closure)
    assert.equal(
      findings.filter((finding) => finding.filename === `${path}/src/probe.ts`).length,
      3,
      result.stdout,
    )
})
