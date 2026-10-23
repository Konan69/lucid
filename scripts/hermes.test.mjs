import * as NodeAssert from 'node:assert/strict'
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeModule from 'node:module'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeTest from 'node:test'
import * as NodeURL from 'node:url'
import * as Schema from 'effect/Schema'
import * as Result from 'effect/Result'
import { hermesConfigErrors, mobileClosure, productionSources } from './hermes.mjs'
import { workspaceManifestPaths } from './versions.mjs'

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), '..')
const assert = NodeAssert
const test = NodeTest.default

const Rules = Schema.Record(Schema.String, Schema.Unknown)
const decodeConfig = Schema.decodeUnknownResult(
  Schema.fromJsonString(
    Schema.Struct({
      rules: Rules,
      ignorePatterns: Schema.Array(Schema.String),
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
    compilerOptions: { lib: ['ES2022'], types: [] },
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
  assert.ok(
    hermesConfigErrors(directory, paths).every((error) => error.startsWith('packages/peer/')),
  )
})

/** A transitive type package can add newer standard APIs without changing compilerOptions.lib. */
void test('a types entry that references wider libraries is refused', (context) => {
  const { directory, write, source, paths } = fixture(context)
  source(
    'node_modules/@types/wider/index.d.ts',
    '/// <reference lib="esnext.disposable" />\n/// <reference lib="esnext.float16" />\n',
  )
  write('apps/mobile/tsconfig.json', {
    extends: '../../profile.json',
    compilerOptions: { types: ['wider'] },
    include: ['src'],
  })
  const errors = hermesConfigErrors(directory, paths).join('\n')
  assert.match(
    errors,
    /loaded libraries exceed the Hermes profile.*lib\.esnext\.disposable\.d\.ts/u,
  )
  assert.match(errors, /lib\.es2025\.float16\.d\.ts/u)
  assert.doesNotMatch(errors, /effective lib must/u)
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
  source('apps/web/src/data/library.ts', probe)
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
  assert.equal(findings.length, (closure.length + 1) * 3, result.stdout)
  for (const file of [
    ...closure.map((path) => `${path}/src/probe.ts`),
    'apps/web/src/data/library.ts',
  ])
    assert.equal(findings.filter((finding) => finding.filename === file).length, 3, result.stdout)
})

/** Oxlint replaces rule options, so an exception must retain every restriction inherited from the base. */
void test('Hermes overrides retain base restrictions', () => {
  const config = Result.getOrThrow(
    decodeConfig(NodeFS.readFileSync(NodePath.join(root, '.oxlintrc.json'), 'utf8')),
  )
  for (const override of config.overrides) {
    for (const rule of ['no-restricted-globals', 'no-restricted-properties']) {
      if (!Array.isArray(override.rules[rule])) continue
      for (const entry of config.rules[rule].slice(1)) {
        assert.ok(
          override.rules[rule].some((value) => JSON.stringify(value) === JSON.stringify(entry)),
          `${override.files.join(', ')} loses ${rule} ${JSON.stringify(entry)}`,
        )
      }
    }
  }
})

/** Check the compiler's actual source graph, including cross-app paths and future package moves. */
void test('every mobile production source is covered by the effective Hermes lint rules', () => {
  const config = Result.getOrThrow(
    decodeConfig(NodeFS.readFileSync(NodePath.join(root, '.oxlintrc.json'), 'utf8')),
  )
  const files = new Set(
    mobileClosure(root, workspaceManifestPaths(root)).flatMap((directory) =>
      productionSources(root, directory),
    ),
  )
  for (const file of files) {
    // Copied vendor code is typechecked but intentionally exempt from the repository's lint rules.
    if (file.startsWith('apps/mobile/vendor/') || file.startsWith('apps/web/vendor/')) continue
    assert.ok(
      !config.ignorePatterns.some((pattern) => NodePath.matchesGlob(file, pattern)),
      `${file} is lint-ignored`,
    )
    const rules = { ...config.rules }
    for (const override of config.overrides) {
      const matches = override.files.some((pattern) => NodePath.matchesGlob(file, pattern))
      const excludes =
        override.excludeFiles !== undefined &&
        override.excludeFiles.some((pattern) => NodePath.matchesGlob(file, pattern))
      if (matches && !excludes) Object.assign(rules, override.rules)
    }
    assert.match(
      JSON.stringify(rules['no-restricted-properties']),
      /"property":"RelativeTimeFormat"/u,
      file,
    )
    assert.match(JSON.stringify(rules['no-restricted-properties']), /"property":"toSorted"/u, file)
    if (file !== 'packages/client/state/src/live.ts')
      assert.match(
        JSON.stringify(rules['no-restricted-globals']),
        /"name":"FinalizationRegistry"/u,
        file,
      )
  }
})

/** Expo runs this mutator on every start; a solution project must remain byte-for-byte unchanged. */
void test('Expo startup leaves the mobile solution project unchanged', async (context) => {
  const { directory, source } = fixture(context)
  const original = NodeFS.readFileSync(NodePath.join(root, 'apps/mobile/tsconfig.json'), 'utf8')
  source('tsconfig.json', original)
  const require = NodeModule.createRequire(NodePath.join(root, 'apps/mobile/package.json'))
  const expo = NodeModule.createRequire(require.resolve('expo/package.json'))
  const cli = NodePath.dirname(expo.resolve('@expo/cli/package.json'))
  const { updateTSConfigAsync } = require(
    NodePath.join(cli, 'build/src/start/doctor/typescript/updateTSConfig.js'),
  )
  await updateTSConfigAsync({ tsConfigPath: NodePath.join(directory, 'tsconfig.json') })
  assert.equal(NodeFS.readFileSync(NodePath.join(directory, 'tsconfig.json'), 'utf8'), original)
})
