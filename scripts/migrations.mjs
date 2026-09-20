#!/usr/bin/env node
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import * as Schema from 'effect/Schema'

const repositoryRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  '..',
)
const initialSnapshotId = '00000000-0000-0000-0000-000000000000'
export const migrationOwners = Object.freeze([
  'apps/server',
  'packages/agent-runtime',
  'packages/connectors',
])

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

const ownerPaths = (root, owner) => {
  const ownerRoot = NodePath.join(root, owner)
  return {
    config: NodePath.join(ownerRoot, 'drizzle.config.ts'),
    manifest: NodePath.join(ownerRoot, 'package.json'),
    migrations: NodePath.join(ownerRoot, 'drizzle'),
  }
}

const configErrors = (owner, config) => [
  ...(/schema\s*:\s*["'][^"']+["']/u.test(config)
    ? []
    : [`${owner}/drizzle.config.ts: schema must be a literal owned path`]),
  ...(/out\s*:\s*["']\.\/drizzle["']/u.test(config)
    ? []
    : [`${owner}/drizzle.config.ts: out must be "./drizzle"`]),
]

const manifestErrors = (owner, manifest) => [
  ...(manifest.scripts['db:generate'] === 'drizzle-kit generate'
    ? []
    : [`${owner}/package.json: db:generate must run drizzle-kit generate`]),
  ...(manifest.scripts['db:migrate'] === 'drizzle-kit migrate'
    ? []
    : [`${owner}/package.json: db:migrate must run drizzle-kit migrate`]),
]

const migrationDirectories = (path) =>
  NodeFS.readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted((left, right) => left.localeCompare(right))

const readMigration = (path) => {
  try {
    return { _tag: 'Found', value: NodeFS.readFileSync(path, 'utf8') }
  } catch {
    return { _tag: 'Missing' }
  }
}

const readSnapshot = (path) => {
  try {
    return { _tag: 'Found', value: decodeSnapshotText(NodeFS.readFileSync(path, 'utf8')) }
  } catch {
    return { _tag: 'Missing' }
  }
}

/** Validate one generated migration and advance the expected snapshot predecessor. */
function migrationErrors({ owner, migrationsPath, directory, previousId, ids }) {
  const errors = []
  if (!/^\d{14}_[a-z0-9_-]+$/u.test(directory)) {
    errors.push(
      `${owner}/drizzle/${directory}: migration directory must start with a 14-digit timestamp`,
    )
  }
  const migration = readMigration(NodePath.join(migrationsPath, directory, 'migration.sql'))
  const snapshot = readSnapshot(NodePath.join(migrationsPath, directory, 'snapshot.json'))
  if (migration._tag === 'Missing') {
    errors.push(`${owner}/drizzle/${directory}: migration.sql is missing`)
  } else if (migration.value.trim().length === 0) {
    errors.push(`${owner}/drizzle/${directory}: migration.sql is empty`)
  }
  if (snapshot._tag === 'Missing') {
    errors.push(`${owner}/drizzle/${directory}: snapshot.json is missing or invalid JSON`)
    return { errors, nextPreviousId: previousId }
  }
  if (snapshot.value.id.length === 0) {
    errors.push(`${owner}/drizzle/${directory}: snapshot id is required`)
  } else if (ids.has(snapshot.value.id)) {
    errors.push(`${owner}/drizzle/${directory}: snapshot id ${snapshot.value.id} is duplicated`)
  } else {
    ids.add(snapshot.value.id)
  }
  if (!snapshot.value.prevIds.includes(previousId)) {
    errors.push(
      `${owner}/drizzle/${directory}: prevIds must link to the previous snapshot ${previousId}`,
    )
  }
  return { errors, nextPreviousId: snapshot.value.id }
}

/** Validate one Drizzle owner's generated SQL/snapshot chain without rewriting generated state. */
export function validateMigrationOwner(root, owner) {
  const paths = ownerPaths(root, owner)
  const config = NodeFS.readFileSync(paths.config, 'utf8')
  const manifest = decodeManifestText(NodeFS.readFileSync(paths.manifest, 'utf8'))
  const directories = migrationDirectories(paths.migrations)
  const errors = [...configErrors(owner, config), ...manifestErrors(owner, manifest)]
  if (directories.length === 0) {
    errors.push(`${owner}/drizzle: at least one generated migration is required`)
  }
  const ids = new Set()
  let previousId = initialSnapshotId
  for (const directory of directories) {
    const result = migrationErrors({
      owner,
      migrationsPath: paths.migrations,
      directory,
      previousId,
      ids,
    })
    errors.push(...result.errors)
    previousId = result.nextPreviousId
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
    process.stderr.write(
      `migration integrity failed:\n${errors.map((error) => `  - ${error}`).join('\n')}\n`,
    )
    process.exitCode = 1
    return
  }
  process.stdout.write(
    `migration integrity passed: ${reports.map((report) => `${report.owner} (${report.migrations})`).join(', ')}\n`,
  )
}

if (
  process.argv[1] !== undefined &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
)
  main()
