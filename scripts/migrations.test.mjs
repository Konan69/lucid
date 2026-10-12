import * as NodeAssert from 'node:assert/strict'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeTest from 'node:test'
import { validateMigrationOwner } from './migrations.mjs'

const assert = NodeAssert
const test = NodeTest.default
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
    // Repair only the predecessor: the same validator must accept the otherwise identical fixture.
    NodeFS.writeFileSync(
      NodePath.join(migrationRoot, 'snapshot.json'),
      JSON.stringify({
        version: 8,
        dialect: 'postgresql',
        id: 'next',
        prevIds: ['00000000-0000-0000-0000-000000000000'],
      }),
    )
    assert.deepEqual(validateMigrationOwner(root, owner).errors, [])
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true })
  }
})
