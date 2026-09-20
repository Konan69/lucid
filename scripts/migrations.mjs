#!/usr/bin/env node
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

const repositoryRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  '..',
)
const initialSnapshotId = '00000000-0000-0000-0000-000000000000'
export const migrationOwners = Object.freeze(['apps/server', 'apps/server#product'])

const MigrationManifest = Schema.Struct({
  scripts: Schema.Struct({
    'db:generate': Schema.String,
    'db:migrate': Schema.String,
    'db:generate:product': Schema.optionalKey(Schema.String),
    'db:migrate:product': Schema.optionalKey(Schema.String),
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
  const product = owner === 'apps/server#product'
  const ownerRoot = NodePath.join(root, product ? 'apps/server' : owner)
  return {
    config: NodePath.join(ownerRoot, product ? 'product-drizzle.config.ts' : 'drizzle.config.ts'),
    manifest: NodePath.join(ownerRoot, 'package.json'),
    migrations: NodePath.join(ownerRoot, product ? 'product-drizzle' : 'drizzle'),
    out: product ? './product-drizzle' : './drizzle',
    generateScript: product ? 'db:generate:product' : 'db:generate',
    migrateScript: product ? 'db:migrate:product' : 'db:migrate',
  }
}

const configErrors = (owner, config, paths) => [
  ...(/schema\s*:\s*["'][^"']+["']/u.test(config)
    ? []
    : [`${owner}: schema must be a literal owned path`]),
  ...(config.includes(`out: '${paths.out}'`) || config.includes(`out: "${paths.out}"`)
    ? []
    : [`${owner}: out must be "${paths.out}"`]),
]

const manifestErrors = (owner, manifest, paths) => [
  ...(manifest.scripts[paths.generateScript] !== undefined &&
  manifest.scripts[paths.generateScript].startsWith('drizzle-kit generate')
    ? []
    : [`${owner}/package.json: ${paths.generateScript} must run drizzle-kit generate`]),
  ...(manifest.scripts[paths.migrateScript] !== undefined &&
  manifest.scripts[paths.migrateScript].startsWith('drizzle-kit migrate')
    ? []
    : [`${owner}/package.json: ${paths.migrateScript} must run drizzle-kit migrate`]),
]

const migrationDirectories = (path) =>
  NodeFS.readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted((left, right) => left.localeCompare(right))

const readMigration = (path) => {
  try {
    return Option.some(NodeFS.readFileSync(path, 'utf8'))
  } catch {
    return Option.none()
  }
}

const readSnapshot = (path) => {
  try {
    return Option.some(decodeSnapshotText(NodeFS.readFileSync(path, 'utf8')))
  } catch {
    return Option.none()
  }
}

/** Validate one generated migration and advance the expected snapshot predecessor. */
function migrationErrors({ owner, migrationsPath, directory, previousId, ids }) {
  const errors = []
  if (!/^\d{14}_[a-z0-9_-]+$/u.test(directory)) {
    errors.push(`${owner}/${directory}: migration directory must start with a 14-digit timestamp`)
  }
  const migration = readMigration(NodePath.join(migrationsPath, directory, 'migration.sql'))
  const snapshot = readSnapshot(NodePath.join(migrationsPath, directory, 'snapshot.json'))
  if (Option.isNone(migration)) {
    errors.push(`${owner}/${directory}: migration.sql is missing`)
  } else if (migration.value.trim().length === 0) {
    errors.push(`${owner}/${directory}: migration.sql is empty`)
  }
  if (Option.isNone(snapshot)) {
    errors.push(`${owner}/${directory}: snapshot.json is missing or invalid JSON`)
    return { errors, nextPreviousId: previousId }
  }
  if (snapshot.value.id.length === 0) {
    errors.push(`${owner}/${directory}: snapshot id is required`)
  } else if (ids.has(snapshot.value.id)) {
    errors.push(`${owner}/${directory}: snapshot id ${snapshot.value.id} is duplicated`)
  } else {
    ids.add(snapshot.value.id)
  }
  if (!snapshot.value.prevIds.includes(previousId)) {
    errors.push(`${owner}/${directory}: prevIds must link to the previous snapshot ${previousId}`)
  }
  return { errors, nextPreviousId: snapshot.value.id }
}

/** Validate one Drizzle owner's generated SQL/snapshot chain without rewriting generated state. */
export function validateMigrationOwner(root, owner) {
  const paths = ownerPaths(root, owner)
  const config = NodeFS.readFileSync(paths.config, 'utf8')
  const manifest = decodeManifestText(NodeFS.readFileSync(paths.manifest, 'utf8'))
  const directories = migrationDirectories(paths.migrations)
  const errors = [...configErrors(owner, config, paths), ...manifestErrors(owner, manifest, paths)]
  if (directories.length === 0) {
    errors.push(`${owner}: at least one generated migration is required`)
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
