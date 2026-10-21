import * as NodeAssert from 'node:assert/strict'
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeTest from 'node:test'
import * as NodeURL from 'node:url'
import * as Schema from 'effect/Schema'
import { checkReferences, repository } from './references.mjs'

const test = NodeTest.default
const assert = NodeAssert
const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), '..')
const decodeLint = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      overrides: Schema.Array(
        Schema.Struct({
          files: Schema.Array(Schema.String),
          rules: Schema.Record(Schema.String, Schema.Unknown),
        }),
      ),
    }),
  ),
)

const decodeDiagnostics = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ diagnostics: Schema.Array(Schema.Struct({ code: Schema.String })) }),
  ),
)

const declarations = { generated: [], dependencies: [], empty: [], examples: [] }

/** A source inventory is the check's public input, independent of filesystem accidents. */
function tree(entries) {
  return { files: Object.keys(entries), read: (file) => entries[file] }
}

void test('ignored runtime root is declared, and a missing child is not silently authorized', () => {
  const input = tree({
    'AGENTS.md': '`packages/agent/runtime/.state` and `packages/agent/runtime/.state/missing.ts`',
  })
  const policy = {
    ...declarations,
    generated: [
      { path: 'packages/agent/runtime/.state', reason: 'Flue owns local durable state.' },
    ],
  }
  assert.deepEqual(checkReferences(input, policy), [
    'AGENTS.md: packages/agent/runtime/.state/missing.ts matches no tracked source or declared generated path',
  ])
})

void test('a tracked directory never authorizes a missing source child', () => {
  assert.deepEqual(
    checkReferences(
      tree({
        'docs/checks.md': '`apps/server/src/missing.ts`',
        'apps/server/src/main.ts': '',
      }),
      declarations,
    ),
    [
      'docs/checks.md: apps/server/src/missing.ts matches no tracked source or declared generated path',
    ],
  )
})

void test('future file guards need an exact owner, path and reason', () => {
  const input = tree({
    '.oxlintrc.json': JSON.stringify({ overrides: [{ files: ['**/*.spec.ts'] }] }),
  })
  assert.equal(checkReferences(input, declarations).length, 1)
  const policy = {
    ...declarations,
    empty: [
      { owner: '.oxlintrc.json', path: '**/*.spec.ts', reason: 'Protect future spec files.' },
    ],
  }
  assert.deepEqual(checkReferences(input, policy), [])
  assert.throws(
    () => checkReferences(input, { ...policy, empty: [{ ...policy.empty[0], reason: '' }] }),
    /invalid reference configuration/,
  )
  assert.equal(
    checkReferences(input, { ...policy, empty: [{ ...policy.empty[0], owner: 'other.json' }] })
      .length,
    1,
  )
})

void test('Turbo root inputs are checked before recognizing special default inputs', () => {
  const entries = {
    'turbo.json': JSON.stringify({
      tasks: { build: { inputs: ['$TURBO_DEFAULT$', '$TURBO_ROOT$/tsconfig.base.json'] } },
    }),
    'packages/one/package.json': '{"name":"@vivid/one"}',
    'tsconfig.base.json': '{}',
  }
  assert.deepEqual(checkReferences(tree(entries), declarations), [])
  delete entries['tsconfig.base.json']
  assert.deepEqual(checkReferences(tree(entries), declarations), [
    'turbo.json: $TURBO_ROOT$/tsconfig.base.json matches no tracked source or declared generated path',
  ])
})

void test('qualified Turbo inputs resolve in their own package', () => {
  const entries = {
    'turbo.json': JSON.stringify({ tasks: { '@vivid/one#build': { inputs: ['src/**'] } } }),
    'packages/one/package.json': '{"name":"@vivid/one"}',
    'packages/two/package.json': '{"name":"@vivid/two"}',
    'packages/two/src/index.ts': '',
  }
  assert.equal(checkReferences(tree(entries), declarations).length, 1)
  entries['packages/one/src/index.ts'] = ''
  assert.deepEqual(checkReferences(tree(entries), declarations), [])
})

void test('relative links, instruction paths, JSONC and TypeScript globs keep their owning base', () => {
  const entries = {
    '.agents/skills/sample/SKILL.md': '[Guide](references/guide.md) and `./references/guide.md`',
    '.agents/skills/sample/references/guide.md': '',
    'docs/checks.md': '[Source](../apps/server/src/main.ts#run)',
    'apps/server/AGENTS.md': '`./src/main.ts`',
    'apps/server/tsconfig.json':
      '{// config\n"extends":"../../tsconfig.base", "include":["src/**/*.ts"], "files":["src/main.ts"]}',
    'apps/server/src/main.ts': '',
    'tsconfig.base.json': '{}',
  }
  assert.deepEqual(checkReferences(tree(entries), declarations), [])
  delete entries['.agents/skills/sample/references/guide.md']
  assert.equal(checkReferences(tree(entries), declarations).length, 2)
})

void test('the historical ed0ab26d override fails against the moved auth provider', () => {
  const entries = {
    '.oxlintrc.json':
      '{"overrides":[{"files":["apps/server/src/auth.ts"],"rules":{"vivid/better-auth-secure-options":"error"}}]}',
    'apps/server/src/auth/provider.ts': '',
  }
  assert.deepEqual(checkReferences(tree(entries), declarations), [
    '.oxlintrc.json: apps/server/src/auth.ts matches no tracked source or declared generated path',
  ])
  entries['.oxlintrc.json'] = entries['.oxlintrc.json'].replace(
    'src/auth.ts',
    'src/auth/provider.ts',
  )
  assert.deepEqual(checkReferences(tree(entries), declarations), [])
})

/** Use Git and an ignored on-disk file so filesystem existence cannot stand in for source identity. */
void test('an ignored untracked source file cannot satisfy a reference', (context) => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-references-'))
  context.after(() => NodeFS.rmSync(directory, { recursive: true, force: true }))
  NodeChildProcess.execFileSync('git', ['init', '-q', directory])
  NodeFS.writeFileSync(NodePath.join(directory, '.gitignore'), 'apps/\n')
  NodeFS.writeFileSync(NodePath.join(directory, 'AGENTS.md'), '`apps/missing.ts`')
  NodeFS.mkdirSync(NodePath.join(directory, 'apps'))
  NodeFS.writeFileSync(NodePath.join(directory, 'apps/missing.ts'), '')
  NodeChildProcess.execFileSync('git', ['add', '--', '.gitignore', 'AGENTS.md'], { cwd: directory })
  assert.equal(checkReferences(repository(directory), declarations).length, 1)
})

/** The real override and rule run together at the production-relative path in a disposable tree. */
void test('Better Auth migrate true is reported at the configured provider path', (context) => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-auth-scope-'))
  context.after(() => NodeFS.rmSync(directory, { recursive: true, force: true }))
  const actual = decodeLint(NodeFS.readFileSync(NodePath.join(root, '.oxlintrc.json'), 'utf8'))
  const override = actual.overrides.find((entry) =>
    Object.hasOwn(entry.rules, 'vivid/better-auth-secure-options'),
  )
  const path = 'apps/server/src/auth/provider.ts'
  assert.deepEqual(override.files, [path])
  const file = NodePath.join(directory, path)
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true })
  NodeFS.writeFileSync(file, 'export const options = { migrate: true }')
  const config = NodePath.join(directory, '.oxlintrc.json')
  NodeFS.writeFileSync(
    config,
    JSON.stringify({
      jsPlugins: [
        { name: 'vivid', specifier: NodePath.join(root, 'scripts/oxlint-plugin-vivid.mjs') },
      ],
      overrides: [override],
    }),
  )
  const result = NodeChildProcess.spawnSync(
    NodePath.join(root, 'node_modules/.bin/oxlint'),
    ['--config', config, '--format', 'json', path],
    { cwd: directory, encoding: 'utf8' },
  )
  assert.equal(result.status, 1, result.stderr)
  const diagnostics = decodeDiagnostics(result.stdout).diagnostics
  assert.equal(
    diagnostics.filter((entry) => entry.code === 'vivid(better-auth-secure-options)').length,
    1,
  )
})

void test('a future guard expires when its first real file is tracked', () => {
  const input = tree({
    '.oxlintrc.json': '{"overrides":[{"files":["**/*.spec.ts"]}]}',
    'apps/server/src/provider.spec.ts': '',
  })
  const policy = {
    ...declarations,
    empty: [{ owner: '.oxlintrc.json', path: '**/*.spec.ts', reason: 'Protect future specs.' }],
  }
  assert.deepEqual(checkReferences(input, policy), [
    '.oxlintrc.json: **/*.spec.ts is no longer empty; remove its declaration',
  ])
})

void test('a packaged extends needs its exact declared path and its owning dependency', () => {
  const entries = {
    'apps/mobile/tsconfig.json': '{"extends":"expo/tsconfig.base"}',
    'apps/mobile/package.json': '{"dependencies":{"expo":"55.0.0"}}',
  }
  const policy = {
    ...declarations,
    dependencies: [{ path: 'expo/tsconfig.base', reason: 'Pinned Expo config.' }],
  }
  assert.deepEqual(checkReferences(tree(entries), policy), [])
  entries['apps/mobile/tsconfig.json'] = '{"extends":"expo/tsconfig.typo"}'
  assert.deepEqual(checkReferences(tree(entries), policy), [
    'apps/mobile/tsconfig.json: expo/tsconfig.typo matches no tracked source or declared generated path',
    'scripts/references.json: dependencies declaration expo/tsconfig.base authorizes nothing; remove it',
  ])
  entries['apps/mobile/tsconfig.json'] = '{"extends":"expo/tsconfig.base"}'
  entries['apps/mobile/package.json'] = '{}'
  assert.deepEqual(checkReferences(tree(entries), policy), [
    'apps/mobile/tsconfig.json: expo/tsconfig.base matches no tracked source or declared generated path',
    'scripts/references.json: dependencies declaration expo/tsconfig.base authorizes nothing; remove it',
  ])
})

void test('prose checks links and backticked directory prefixes within its documented limits', () => {
  const input = tree({
    'AGENTS.md': [
      '`apps/server/missing.ts` and [config](turbo.json)',
      '`turbo.json`, `alchemy.run.ts`, `tsconfig.base.json`, `CODING_STANDARDS.md`, `.oxlintrc.json`',
      '`.github/missing.yml`, `.husky/missing`, `patches/missing.patch`',
      'apps/server/unbackticked.ts and `@vivid/agent-runtime/sandbox`',
      '```ts\nconst example = `apps/server/fenced.ts`\n```',
    ].join('\n'),
  })
  assert.deepEqual(checkReferences(input, declarations), [
    'AGENTS.md: apps/server/missing.ts matches no tracked source or declared generated path',
    'AGENTS.md: turbo.json matches no tracked source or declared generated path',
  ])
})

void test('unused generated declarations expire when their last missing reference disappears', () => {
  const entries = { 'AGENTS.md': '`artifacts/proof/result.json`' }
  const policy = {
    ...declarations,
    generated: [{ path: 'artifacts/**', reason: 'Ignored proof output.' }],
  }
  assert.deepEqual(checkReferences(tree(entries), policy), [])
  entries['AGENTS.md'] = ''
  assert.deepEqual(checkReferences(tree(entries), policy), [
    'scripts/references.json: generated declaration artifacts/** authorizes nothing; remove it',
  ])
  entries['AGENTS.md'] = '`artifacts/proof/result.json`'
  entries['artifacts/proof/result.json'] = '{}'
  assert.deepEqual(checkReferences(tree(entries), policy), [
    'scripts/references.json: generated declaration artifacts/** authorizes nothing; remove it',
  ])
})

void test('each example path expires independently when removed or satisfied by tracked source', () => {
  const entries = { 'docs/guide.md': '`apps/missing.ts` and `apps/proposed.ts`' }
  const policy = {
    ...declarations,
    examples: [
      {
        owner: 'docs/guide.md',
        paths: ['apps/missing.ts', 'apps/proposed.ts'],
        reason: 'Proposed files.',
      },
    ],
  }
  assert.deepEqual(checkReferences(tree(entries), policy), [])
  entries['docs/guide.md'] = '`apps/proposed.ts`'
  assert.deepEqual(checkReferences(tree(entries), policy), [
    'scripts/references.json: examples declaration docs/guide.md: apps/missing.ts authorizes nothing; remove it',
  ])
  entries['apps/proposed.ts'] = ''
  assert.deepEqual(checkReferences(tree(entries), policy), [
    'scripts/references.json: examples declaration docs/guide.md: apps/missing.ts authorizes nothing; remove it',
    'scripts/references.json: examples declaration docs/guide.md: apps/proposed.ts authorizes nothing; remove it',
  ])
})

void test('generated declarations do not authorize packaged dependency configs', () => {
  const input = tree({
    'apps/mobile/tsconfig.json': '{"extends":"expo/tsconfig.base"}',
    'apps/mobile/package.json': '{"dependencies":{"expo":"55.0.0"}}',
  })
  const policy = {
    ...declarations,
    generated: [{ path: 'expo/tsconfig.base', reason: 'Misclassified dependency config.' }],
  }
  assert.deepEqual(checkReferences(input, policy), [
    'apps/mobile/tsconfig.json: expo/tsconfig.base matches no tracked source or declared generated path',
    'scripts/references.json: generated declaration expo/tsconfig.base authorizes nothing; remove it',
  ])
})

void test('lint exclusions require tracked files or an exact declared future guard', () => {
  const input = tree({
    '.oxlintrc.json': JSON.stringify({
      overrides: [{ files: ['apps/server/src/**'], excludeFiles: ['**/*.spec.ts'] }],
    }),
    'apps/server/src/main.ts': '',
  })
  assert.deepEqual(checkReferences(input, declarations), [
    '.oxlintrc.json: **/*.spec.ts matches no tracked source or declared generated path',
  ])
  const policy = {
    ...declarations,
    empty: [
      {
        owner: '.oxlintrc.json',
        path: '**/*.spec.ts',
        reason: 'Exclude future specs from product-only rules.',
      },
    ],
  }
  assert.deepEqual(checkReferences(input, policy), [])
})
