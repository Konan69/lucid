import * as NodeAssert from 'node:assert/strict'
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeModule from 'node:module'
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
const oxlint = NodePath.join(repositoryRoot, 'node_modules/oxlint/bin/oxlint')

const Manifest = Schema.StructWithRest(
  Schema.Struct({ scripts: Schema.Record(Schema.String, Schema.String) }),
  [Schema.Record(Schema.String, Schema.Json)],
)
const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))

/** Exercise the real pinned compiler and repository configs with small owned source files. */
function fixture(t) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-types-'))
  t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }))
  for (const file of [
    'package.json',
    'pnpm-workspace.yaml',
    'pnpm-lock.yaml',
    '.gitignore',
    'turbo.json',
    'scripts/types.mjs',
    'tsconfig.base.json',
    'tsconfig.hermes.json',
    'hermes.d.ts',
    'packages/contracts/package.json',
    'packages/contracts/tsconfig.json',
    'packages/contracts/tsconfig.types.json',
    'packages/client/rpc/package.json',
    'packages/client/rpc/tsconfig.json',
    'packages/client/rpc/tsconfig.types.json',
  ]) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, file)), { recursive: true })
    NodeFS.copyFileSync(NodePath.join(repositoryRoot, file), NodePath.join(root, file))
  }
  // This compiler integration fixture owns a test project even though contracts has no tests.
  NodeFS.writeFileSync(
    NodePath.join(root, 'packages/contracts/tsconfig.tests.json'),
    JSON.stringify({
      extends: './tsconfig.types.json',
      compilerOptions: {
        composite: false,
        noEmit: true,
        declaration: false,
        emitDeclarationOnly: false,
        rootDir: '.',
        tsBuildInfoFile: '.cache/typescript/tests.tsbuildinfo',
      },
      include: ['src/**/*.test.ts'],
      exclude: [],
      references: [{ path: './tsconfig.types.json' }],
    }),
  )
  // Turbo validates named package edges, even when this probe runs only two packages.
  const workspaces = NodeFS.readFileSync(NodePath.join(root, 'pnpm-workspace.yaml'), 'utf8')
    .split('\n\n')[0]
    .split('\n')
    .filter((line) => line.startsWith("  - '"))
    .map((line) => line.slice(5, -1))
  for (const workspace of workspaces) {
    NodeFS.mkdirSync(NodePath.join(root, workspace), { recursive: true })
    NodeFS.copyFileSync(
      NodePath.join(repositoryRoot, workspace, 'package.json'),
      NodePath.join(root, workspace, 'package.json'),
    )
  }
  const contractManifest = NodePath.join(root, 'packages/contracts/package.json')
  const manifest = decodeManifest(NodeFS.readFileSync(contractManifest, 'utf8'))
  manifest.scripts.typecheck += ' tsconfig.tests.json'
  NodeFS.writeFileSync(contractManifest, JSON.stringify(manifest))
  NodeFS.mkdirSync(NodePath.join(root, 'node_modules/@typescript'), { recursive: true })
  NodeFS.symlinkSync(
    NodePath.join(repositoryRoot, 'node_modules/@typescript/native'),
    NodePath.join(root, 'node_modules/@typescript/native'),
  )
  // The checker scripts/types.mjs runs; its platform package resolves through the real path.
  NodeFS.symlinkSync(
    NodeFS.realpathSync(NodePath.join(repositoryRoot, 'node_modules/tsc-rs')),
    NodePath.join(root, 'node_modules/tsc-rs'),
  )
  // The Node test project names its ambient types explicitly; the production project excludes them.
  NodeFS.mkdirSync(NodePath.join(root, 'node_modules/@types'), { recursive: true })
  NodeFS.symlinkSync(
    NodeFS.realpathSync(NodePath.join(repositoryRoot, 'node_modules/@types/node')),
    NodePath.join(root, 'node_modules/@types/node'),
  )
  for (const directory of ['packages/contracts/src', 'packages/client/rpc/src']) {
    NodeFS.mkdirSync(NodePath.join(root, directory), { recursive: true })
  }
  const dependencies = NodePath.join(root, 'packages/client/rpc/node_modules/@vivid')
  NodeFS.mkdirSync(dependencies, { recursive: true })
  NodeFS.symlinkSync(
    NodePath.join(root, 'packages/contracts'),
    NodePath.join(dependencies, 'contracts'),
  )
  NodeFS.writeFileSync(
    NodePath.join(root, 'packages/contracts/src/index.ts'),
    'export const count = 1\n',
  )
  NodeFS.writeFileSync(
    NodePath.join(root, 'packages/contracts/src/check.test.ts'),
    "import { count } from './index.js'\nexport const checked: number = count\n",
  )
  NodeFS.writeFileSync(
    NodePath.join(root, 'packages/client/rpc/src/index.ts'),
    "import { count } from '@vivid/contracts'\nexport const consumed: number = count\n",
  )
  for (const args of [
    ['init', '--quiet', root],
    ['-C', root, 'add', '.'],
  ]) {
    const result = NodeChildProcess.spawnSync('git', args, { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  return root
}

/** Direct commands must prepare references and diagnose errors without Turbo. */
function check(root) {
  const environment = { ...process.env }
  delete environment.TURBO_HASH
  return NodeChildProcess.spawnSync(
    process.execPath,
    [
      NodePath.join(root, 'scripts/types.mjs'),
      'packages/contracts/tsconfig.tests.json',
      'packages/client/rpc/tsconfig.types.json',
    ],
    { cwd: root, env: environment, encoding: 'utf8' },
  )
}

/** Use actual package commands and the real scheduler/cache around tiny native programs. */
function cachedCheck(root) {
  return NodeChildProcess.spawnSync(
    process.execPath,
    [
      turbo,
      'run',
      'typecheck',
      '--filter=@vivid/contracts',
      '--filter=@vivid/client-runtime',
      '--concurrency=1',
      '--ui=stream',
    ],
    {
      cwd: root,
      env: { ...process.env, CI: '1', TURBO_TELEMETRY_DISABLED: '1' },
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    },
  )
}

/** Model a checkout whose input mtime predates newly restored cached declarations. */
function replaceOlder(root, file, content) {
  const target = NodePath.join(root, file)
  const earlier = new Date(Date.now() - 60_000)
  NodeFS.writeFileSync(target, content)
  NodeFS.utimesSync(target, earlier, earlier)
}

/** A split must retain production/test diagnostics and the consumer's declared contract. */
void test('project boundaries retain production, test, and consumer type errors', (t) => {
  const root = fixture(t)
  const valid = check(root)
  assert.equal(valid.status, 0, `${valid.stdout}\n${valid.stderr}`)
  assert.ok(
    NodeFS.existsSync(NodePath.join(root, 'packages/contracts/.cache/typescript/types/index.d.ts')),
  )

  NodeFS.writeFileSync(
    NodePath.join(root, 'packages/contracts/src/index.ts'),
    'export const count: number = "invalid"\n',
  )
  const production = check(root)
  assert.notEqual(production.status, 0)
  assert.match(production.stdout, /contracts\/src\/index\.ts.*TS2322/u)

  NodeFS.writeFileSync(
    NodePath.join(root, 'packages/contracts/src/index.ts'),
    'export const count = 1\n',
  )
  NodeFS.writeFileSync(
    NodePath.join(root, 'packages/contracts/src/check.test.ts'),
    "import { count } from './index.js'\nexport const checked: string = count\n",
  )
  const tests = check(root)
  assert.notEqual(tests.status, 0)
  assert.match(tests.stdout, /check\.test\.ts.*TS2322/u)

  NodeFS.writeFileSync(
    NodePath.join(root, 'packages/contracts/src/check.test.ts'),
    "import { count } from './index.js'\nexport const checked: number = count\n",
  )
  NodeFS.writeFileSync(
    NodePath.join(root, 'packages/client/rpc/src/index.ts'),
    "import { count } from '@vivid/contracts'\nexport const consumed: string = count\n",
  )
  const consumer = check(root)
  assert.notEqual(consumer.status, 0)
  assert.match(consumer.stdout, /client\/rpc\/src\/index\.ts.*TS2322/u)
})

/** A hash miss must never become a false success because build outputs have newer mtimes. */
void test('restored declaration caches retain production, test, and consumer errors', (t) => {
  const root = fixture(t)
  const valid = cachedCheck(root)
  assert.equal(valid.status, 0, `${valid.stdout}\n${valid.stderr}`)
  const consumerFiles = NodeChildProcess.spawnSync(
    process.execPath,
    [
      NodePath.join(root, 'node_modules/tsc-rs/bin/tsc-rs'),
      '-p',
      'packages/client/rpc/tsconfig.types.json',
      '--listFilesOnly',
    ],
    { cwd: root, encoding: 'utf8' },
  )
  assert.equal(consumerFiles.status, 0, consumerFiles.stderr)
  assert.match(consumerFiles.stdout, /contracts\/\.cache\/typescript\/types\/index\.d\.ts/u)
  assert.doesNotMatch(consumerFiles.stdout, /contracts\/src\/index\.ts/u)
  for (const workspace of ['packages/contracts', 'packages/client/rpc']) {
    NodeFS.rmSync(NodePath.join(root, workspace, '.cache'), { recursive: true, force: true })
  }
  const restored = cachedCheck(root)
  assert.equal(restored.status, 0, `${restored.stdout}\n${restored.stderr}`)
  assert.match(restored.stdout, /cache hit/u)
  assert.ok(
    NodeFS.existsSync(NodePath.join(root, 'packages/contracts/.cache/typescript/types/index.d.ts')),
  )

  replaceOlder(root, 'packages/contracts/src/index.ts', 'export const count: number = "invalid"\n')
  const production = cachedCheck(root)
  assert.notEqual(production.status, 0)
  assert.match(production.stdout, /@vivid\/contracts:types: src\/index\.ts.*TS2322/u)

  replaceOlder(root, 'packages/contracts/src/index.ts', 'export const count = 1\n')
  replaceOlder(
    root,
    'packages/contracts/src/check.test.ts',
    "import { count } from './index.js'\nexport const checked: string = count\n",
  )
  const tests = cachedCheck(root)
  assert.notEqual(tests.status, 0)
  assert.match(tests.stdout, /check\.test\.ts.*TS2322/u)
  assert.match(tests.stdout, /@vivid\/contracts:types: cache hit/u)

  replaceOlder(
    root,
    'packages/contracts/src/check.test.ts',
    "import { count } from './index.js'\nexport const checked: number = count\n",
  )
  replaceOlder(
    root,
    'packages/client/rpc/src/index.ts',
    "import { count } from '@vivid/contracts'\nexport const consumed: string = count\n",
  )
  const consumer = cachedCheck(root)
  assert.notEqual(consumer.status, 0)
  assert.match(consumer.stdout, /@vivid\/client-runtime:types: src\/index\.ts.*TS2322/u)
})

/** The pinned engine must retain semantic lint diagnostics without emitted references. */
void test('typed lint diagnoses production, tests, and consumers before declaration emission', (t) => {
  const root = fixture(t)
  NodeFS.writeFileSync(
    NodePath.join(root, '.oxlintrc.json'),
    '{"rules":{"typescript/no-floating-promises":"error","typescript/no-redundant-type-constituents":"error"}}\n',
  )
  NodeFS.writeFileSync(
    NodePath.join(root, 'packages/contracts/src/index.ts'),
    'export interface Failure { readonly code: string }\nexport const pending = () => Promise.resolve(1)\n',
  )
  NodeFS.writeFileSync(
    NodePath.join(root, 'packages/contracts/src/check.test.ts'),
    "import { pending } from './index.js'\nexport const checked = pending\n",
  )
  NodeFS.writeFileSync(
    NodePath.join(root, 'packages/client/rpc/src/index.ts'),
    "import { pending, type Failure } from '@vivid/contracts'\nexport type Refusal = Failure | string\nexport const checked = pending\n",
  )
  const invoke = () =>
    NodeChildProcess.spawnSync(
      process.execPath,
      [
        oxlint,
        '--type-aware',
        '--threads=1',
        '--format=unix',
        'packages/contracts',
        'packages/client/rpc',
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          GOMAXPROCS: '1',
          OXLINT_TSGOLINT_PATH: NodeModule.createRequire(import.meta.url)(
            '@maschwenk/tsrslint',
          ).binaryPath(),
        },
        encoding: 'utf8',
      },
    )
  const valid = invoke()
  assert.equal(valid.status, 0, `${valid.stdout}\n${valid.stderr}`)
  for (const file of [
    'packages/contracts/src/index.ts',
    'packages/contracts/src/check.test.ts',
    'packages/client/rpc/src/index.ts',
  ]) {
    NodeFS.appendFileSync(NodePath.join(root, file), 'pending()\n')
  }
  const result = invoke()
  assert.notEqual(result.status, 0)
  assert.match(result.stdout, /contracts\/src\/index\.ts.*no-floating-promises/u)
  assert.match(result.stdout, /check\.test\.ts.*no-floating-promises/u)
  assert.match(result.stdout, /client\/rpc\/src\/index\.ts.*no-floating-promises/u)
  assert.ok(!NodeFS.existsSync(NodePath.join(root, 'packages/contracts/.cache/typescript/types')))
})
