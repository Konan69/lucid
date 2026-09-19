#!/usr/bin/env node
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import * as Schema from 'effect/Schema'

const repositoryRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), '..')
const initialSnapshotId = '00000000-0000-0000-0000-000000000000'
export const migrationOwners = Object.freeze(['apps/server', 'packages/agent-runtime'])

const MigrationManifest = Schema.Struct({
  scripts: Schema.Struct({
    'db:generate': Schema.String,
    'db:migrate': Schema.String,
  }),
})
const MigrationSnapshot = Schema.Struct({
  version: Schema.Union([Schema.Literal('8'), Schema.Literal(8)]),
  dialect: Schema.Literals(['postgresql', 'postgres']),
  id: Schema.String,
  prevIds: Schema.Array(Schema.String),
})
const decodeManifestText = Schema.decodeUnknownSync(Schema.fromJsonString(MigrationManifest))
const decodeSnapshotText = Schema.decodeUnknownSync(Schema.fromJsonString(MigrationSnapshot))

/** Validate one Drizzle owner's generated SQL/snapshot chain without rewriting generated state. */
export function validateMigrationOwner(root, owner) {
  const errors = []
  const ownerRoot = NodePath.join(root, owner)
  const configPath = NodePath.join(ownerRoot, 'drizzle.config.ts')
  const manifestPath = NodePath.join(ownerRoot, 'package.json')
  const migrationsPath = NodePath.join(ownerRoot, 'drizzle')
  const config = NodeFS.readFileSync(configPath, 'utf8')
  const manifest = decodeManifestText(NodeFS.readFileSync(manifestPath, 'utf8'))

  if (!/schema\s*:\s*["'][^"']+["']/u.test(config)) {
    errors.push(`${owner}/drizzle.config.ts: schema must be a literal owned path`)
  }
  if (!/out\s*:\s*["']\.\/drizzle["']/u.test(config)) {
    errors.push(`${owner}/drizzle.config.ts: out must be "./drizzle"`)
  }
  if (manifest.scripts['db:generate'] !== 'drizzle-kit generate') {
    errors.push(`${owner}/package.json: db:generate must run drizzle-kit generate`)
  }
  if (manifest.scripts['db:migrate'] !== 'drizzle-kit migrate') {
    errors.push(`${owner}/package.json: db:migrate must run drizzle-kit migrate`)
  }

  const directories = NodeFS.readdirSync(migrationsPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted((left, right) => left.localeCompare(right))
  if (directories.length === 0) errors.push(`${owner}/drizzle: at least one generated migration is required`)

  let previousId = initialSnapshotId
  const ids = new Set()
  for (const directory of directories) {
    if (!/^\d{14}_[a-z0-9_-]+$/u.test(directory)) {
      errors.push(`${owner}/drizzle/${directory}: migration directory must start with a 14-digit timestamp`)
    }
    const migrationPath = NodePath.join(migrationsPath, directory, 'migration.sql')
    const snapshotPath = NodePath.join(migrationsPath, directory, 'snapshot.json')
    let migration
    let snapshot
    try {
      migration = NodeFS.readFileSync(migrationPath, 'utf8')
    } catch {
      errors.push(`${owner}/drizzle/${directory}: migration.sql is missing`)
    }
    try {
      snapshot = decodeSnapshotText(NodeFS.readFileSync(snapshotPath, 'utf8'))
    } catch {
      errors.push(`${owner}/drizzle/${directory}: snapshot.json is missing or invalid JSON`)
    }
    if (migration !== undefined && migration.trim().length === 0) {
      errors.push(`${owner}/drizzle/${directory}: migration.sql is empty`)
    }
    if (snapshot === undefined) continue
    if (snapshot.version !== '8' && snapshot.version !== 8) {
      errors.push(`${owner}/drizzle/${directory}: snapshot version must be 8`)
    }
    if (snapshot.dialect !== 'postgresql' && snapshot.dialect !== 'postgres') {
      errors.push(`${owner}/drizzle/${directory}: snapshot dialect must be PostgreSQL`)
    }
    if (snapshot.id.length === 0) {
      errors.push(`${owner}/drizzle/${directory}: snapshot id is required`)
    } else if (ids.has(snapshot.id)) {
      errors.push(`${owner}/drizzle/${directory}: snapshot id ${snapshot.id} is duplicated`)
    } else {
      ids.add(snapshot.id)
    }
    if (!snapshot.prevIds.includes(previousId)) {
      errors.push(
        `${owner}/drizzle/${directory}: prevIds must link to the previous snapshot ${previousId}`,
      )
    }
    previousId = snapshot.id
  }
  return { owner, migrations: directories.length, errors }
}

/** Validate both existing migration owners in deterministic migration order. */
export function validateMigrations(root = repositoryRoot) {
  return migrationOwners.map((owner) => validateMigrationOwner(root, owner))
}

function main() {
  if (process.argv[2] !== 'check') {
    process.stderr.write('usage: migrations.mjs check\n')
    process.exitCode = 2
    return
  }
  const reports = validateMigrations()
  const errors = reports.flatMap((report) => report.errors)
  if (errors.length > 0) {
    process.stderr.write(`migration integrity failed:\n${errors.map((error) => `  - ${error}`).join('\n')}\n`)
    process.exitCode = 1
    return
  }
  process.stdout.write(
    `migration integrity passed: ${reports.map((report) => `${report.owner} (${report.migrations})`).join(', ')}\n`,
  )
}

if (process.argv[1] !== undefined && NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)) main()
