import * as NodeAssert from 'node:assert/strict'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeTest from 'node:test'
import * as NodeURL from 'node:url'
import { migrationOwners, validateMigrationOwner, validateMigrations } from './migrations.mjs'

const assert = NodeAssert
const test = NodeTest.default
const repositoryRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  '..',
)

/** Both checked-in Drizzle owners retain a valid generated snapshot chain. */
void test('validates every checked-in migration owner', () => {
  assert.deepEqual(migrationOwners, ['apps/server', 'apps/server#product', 'packages/connectors'])
  assert.deepEqual(
    validateMigrations(repositoryRoot).flatMap((report) => report.errors),
    [],
  )
})

/** A broken prevIds chain fails even when the JSON and SQL are otherwise valid. */
void test('rejects a snapshot that does not link to its predecessor', () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-migrations-'))
  const owner = 'apps/server'
  const ownerRoot = NodePath.join(root, owner)
  const migrationRoot = NodePath.join(ownerRoot, 'drizzle', '20260101000000_initial')
  try {
    NodeFS.mkdirSync(migrationRoot, { recursive: true })
    NodeFS.writeFileSync(
      NodePath.join(ownerRoot, 'package.json'),
      JSON.stringify({
        scripts: { 'db:generate': 'drizzle-kit generate', 'db:migrate': 'drizzle-kit migrate' },
      }),
    )
    NodeFS.writeFileSync(
      NodePath.join(ownerRoot, 'drizzle.config.ts'),
      "defineConfig({ schema: './src/schema.ts', out: './drizzle' })",
    )
    NodeFS.writeFileSync(NodePath.join(migrationRoot, 'migration.sql'), 'select 1;\n')
    NodeFS.writeFileSync(
      NodePath.join(migrationRoot, 'snapshot.json'),
      JSON.stringify({ version: 8, dialect: 'postgresql', id: 'next', prevIds: ['wrong'] }),
    )

    assert.match(validateMigrationOwner(root, owner).errors.join('\n'), /prevIds/u)
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true })
  }
})
