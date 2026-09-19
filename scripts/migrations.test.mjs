import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { migrationOwners, validateMigrationOwner, validateMigrations } from './migrations.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Both checked-in Drizzle owners retain a valid generated snapshot chain. */
void test('validates every checked-in migration owner', () => {
  assert.deepEqual(migrationOwners, ['apps/server', 'packages/agent-runtime'])
  assert.deepEqual(validateMigrations(repositoryRoot).flatMap((report) => report.errors), [])
})

/** A broken prevIds chain fails even when the JSON and SQL are otherwise valid. */
void test('rejects a snapshot that does not link to its predecessor', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'vivid-migrations-'))
  const owner = 'apps/server'
  const ownerRoot = path.join(root, owner)
  const migrationRoot = path.join(ownerRoot, 'drizzle', '20260101000000_initial')
  try {
    mkdirSync(migrationRoot, { recursive: true })
    writeFileSync(
      path.join(ownerRoot, 'package.json'),
      JSON.stringify({
        scripts: { 'db:generate': 'drizzle-kit generate', 'db:migrate': 'drizzle-kit migrate' },
      }),
    )
    writeFileSync(
      path.join(ownerRoot, 'drizzle.config.ts'),
      "defineConfig({ schema: './src/schema.ts', out: './drizzle' })",
    )
    writeFileSync(path.join(migrationRoot, 'migration.sql'), 'select 1;\n')
    writeFileSync(
      path.join(migrationRoot, 'snapshot.json'),
      JSON.stringify({ version: 8, dialect: 'postgresql', id: 'next', prevIds: ['wrong'] }),
    )

    assert.match(validateMigrationOwner(root, owner).errors.join('\n'), /prevIds/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
