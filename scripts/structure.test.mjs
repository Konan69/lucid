import * as NodeAssert from 'node:assert/strict'
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeTest from 'node:test'
import * as NodeURL from 'node:url'
import * as Schema from 'effect/Schema'
import { directoryErrors, directiveErrors } from './structure.mjs'

const assert = NodeAssert
const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), '..')

const Output = Schema.Struct({
  diagnostics: Schema.Array(Schema.Struct({ filename: Schema.String })),
})
const decodeOutput = Schema.decodeUnknownSync(Schema.fromJsonString(Output))

NodeTest.test('the real Oxlint plugin preserves the five structural conventions', (context) => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-structure-'))
  context.after(() => NodeFS.rmSync(directory, { recursive: true, force: true }))
  const fixtures = {
    'apps/server/src/auth/handlers.ts': "import { eq } from 'drizzle-orm'; export { eq }",
    'apps/server/src/auth/store.ts': "import * as Rpc from 'effect/rpc/Rpc'; export { Rpc }",
    'apps/web/src/longName.ts': 'export const value = 1',
    'packages/client/state/src/utils.ts': 'export const value = 1',
    'apps/server/src/reexports/handlers.ts': "export { eq } from 'drizzle-orm'",
    'apps/server/src/importequals/handlers.ts': "import orm = require('drizzle-orm')",
    'apps/web/src/longName.js': 'export const value = 1',
    'apps/server/src/valid/handlers.ts':
      "import type { SQL } from 'drizzle-orm'; export type Value = SQL",
    'apps/server/src/valid/store.ts':
      "import { type Rpc } from 'effect/rpc/Rpc'; export type Value = Rpc",
  }
  for (const [file, source] of Object.entries(fixtures)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(directory, file)), { recursive: true })
    NodeFS.writeFileSync(NodePath.join(directory, file), source)
  }
  NodeFS.mkdirSync(NodePath.join(directory, 'packages/bad-name/node_modules'), { recursive: true })
  assert.deepEqual(directoryErrors(directory), [
    'packages/bad-name: use a one-word package directory',
  ])
  NodeFS.writeFileSync(
    NodePath.join(directory, 'lint.json'),
    JSON.stringify({
      plugins: [],
      categories: { correctness: 'off' },
      jsPlugins: [
        { name: 'vivid-structure', specifier: NodePath.join(root, 'scripts/structure.mjs') },
      ],
      rules: { 'vivid-structure/source': 'error' },
    }),
  )
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [
      NodePath.join(root, 'node_modules/oxlint/bin/oxlint'),
      '--config',
      'lint.json',
      '--format=json',
      '--threads=1',
      '.',
    ],
    { cwd: directory, encoding: 'utf8' },
  )
  assert.equal(result.status, 1, result.stderr)
  const diagnostics = decodeOutput(result.stdout).diagnostics
  assert.equal(diagnostics.length, 4, result.stdout)
  assert.ok(
    diagnostics.every((diagnostic) => !diagnostic.filename.includes('/valid/')),
    result.stdout,
  )
})

NodeTest.test('structural conventions cannot be suppressed through lint directives', () => {
  assert.deepEqual(
    directiveErrors('apps/web/src/tree.gen.ts', '// eslint-disable\nexport const value = 1'),
    [],
  )
  for (const directive of [
    '// oxlint-disable',
    '/* oxlint-disable vivid-structure/source\n   -- reason */',
    '/*\n oxlint-disable vivid-structure/source\n*/',
    '/* eslint-disable-next-line\n vivid-structure/source */',
    '// eslint-disable-next-line vivid-structure/source',
    '/* oxlint-disable vivid-structure/source -- no */',
  ])
    assert.equal(
      directiveErrors('apps/web/src/longName.ts', `${directive}\nexport const value = 1`).length,
      1,
    )
  assert.deepEqual(
    directiveErrors('apps/web/src/longName.ts', "const text = '// oxlint-disable'"),
    [],
  )
  assert.deepEqual(
    directiveErrors(
      'apps/web/src/longName.ts',
      '// oxlint-disable no-unused-vars\nexport const value = 1',
    ),
    [],
  )
})

NodeTest.test('directive scans reject malformed source with and without suppression', () => {
  for (const prefix of ['', '// oxlint-disable\n'])
    assert.throws(() => directiveErrors('apps/web/src/example.ts', `${prefix}const = ;`), /apps\/web\/src\/example\.ts/u)
})
