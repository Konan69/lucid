#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const initialSnapshotId = '00000000-0000-0000-0000-000000000000'
export const migrationOwners = Object.freeze(['apps/server', 'packages/agent-runtime'])

const readJson = (filename) => JSON.parse(readFileSync(filename, 'utf8'))

/** Validate one Drizzle owner's generated SQL/snapshot chain without rewriting generated state. */
export function validateMigrationOwner(root, owner) {
  const errors = []
  const ownerRoot = path.join(root, owner)
  const configPath = path.join(ownerRoot, 'drizzle.config.ts')
  const manifestPath = path.join(ownerRoot, 'package.json')
  const migrationsPath = path.join(ownerRoot, 'drizzle')
  const config = readFileSync(configPath, 'utf8')
  const manifest = readJson(manifestPath)

  if (!/schema\s*:\s*["'][^"']+["']/u.test(config)) {
    errors.push(`${owner}/drizzle.config.ts: schema must be a literal owned path`)
  }
  if (!/out\s*:\s*["']\.\/drizzle["']/u.test(config)) {
    errors.push(`${owner}/drizzle.config.ts: out must be "./drizzle"`)
  }
  if (manifest.scripts?.['db:generate'] !== 'drizzle-kit generate') {
    errors.push(`${owner}/package.json: db:generate must run drizzle-kit generate`)
  }
  if (manifest.scripts?.['db:migrate'] !== 'drizzle-kit migrate') {
    errors.push(`${owner}/package.json: db:migrate must run drizzle-kit migrate`)
  }

  const directories = readdirSync(migrationsPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  if (directories.length === 0) errors.push(`${owner}/drizzle: at least one generated migration is required`)

  let previousId = initialSnapshotId
  const ids = new Set()
  for (const directory of directories) {
    if (!/^\d{14}_[a-z0-9_-]+$/u.test(directory)) {
      errors.push(`${owner}/drizzle/${directory}: migration directory must start with a 14-digit timestamp`)
    }
    const migrationPath = path.join(migrationsPath, directory, 'migration.sql')
    const snapshotPath = path.join(migrationsPath, directory, 'snapshot.json')
    let migration
    let snapshot
    try {
      migration = readFileSync(migrationPath, 'utf8')
    } catch {
      errors.push(`${owner}/drizzle/${directory}: migration.sql is missing`)
    }
    try {
      snapshot = readJson(snapshotPath)
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
    if (typeof snapshot.id !== 'string' || snapshot.id.length === 0) {
      errors.push(`${owner}/drizzle/${directory}: snapshot id is required`)
    } else if (ids.has(snapshot.id)) {
      errors.push(`${owner}/drizzle/${directory}: snapshot id ${snapshot.id} is duplicated`)
    } else {
      ids.add(snapshot.id)
    }
    if (!Array.isArray(snapshot.prevIds) || !snapshot.prevIds.includes(previousId)) {
      errors.push(
        `${owner}/drizzle/${directory}: prevIds must link to the previous snapshot ${previousId}`,
      )
    }
    if (typeof snapshot.id === 'string') previousId = snapshot.id
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

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
