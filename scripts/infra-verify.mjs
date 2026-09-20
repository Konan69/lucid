import * as NodeAssert from 'node:assert/strict'
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import * as Schema from 'effect/Schema'

const assert = NodeAssert
const scriptDirectory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url))
const defaultRoot = NodePath.resolve(scriptDirectory, '..')
const targetKeys = ['local', 'preview', 'production']
const physicalNameKeys = [
  'stackName',
  'stage',
  'postgresImageId',
  'postgresVolumeName',
  'postgresContainerName',
  'migrationsId',
  'serverProcessId',
  'runtimeProcessId',
  'webId',
]

const Target = Schema.Struct({
  key: Schema.Literals(['local', 'preview', 'production']),
  runnable: Schema.Boolean,
  destroyOnTeardown: Schema.Boolean,
  database: Schema.Literals(['docker', 'required']),
  stackName: Schema.String,
  stage: Schema.String,
  postgresImageId: Schema.String,
  postgresVolumeName: Schema.String,
  postgresContainerName: Schema.String,
  migrationsId: Schema.String,
  serverProcessId: Schema.String,
  runtimeProcessId: Schema.String,
  webId: Schema.String,
  serverUrl: Schema.String,
  runtimeUrl: Schema.String,
  webUrl: Schema.String,
})
const TargetDocument = Schema.Struct({ local: Target, preview: Target, production: Target })
const PackageDocument = Schema.Struct({
  devDependencies: Schema.Struct({ alchemy: Schema.String, effect: Schema.String }),
  scripts: Schema.Struct({
    'infra:dev': Schema.String,
    'infra:destroy': Schema.String,
    'infra:deploy': Schema.optionalKey(Schema.String),
    'infra:preview': Schema.optionalKey(Schema.String),
  }),
})
const decodeTargetDocument = Schema.decodeUnknownSync(Schema.fromJsonString(TargetDocument))
const decodePackageDocument = Schema.decodeUnknownSync(Schema.fromJsonString(PackageDocument))
const source = (root, relativePath) =>
  NodeFS.readFileSync(NodePath.join(root, relativePath), 'utf8')

export const readTargetDocument = (root = defaultRoot) => {
  const targetSource = source(root, 'infra/targets.ts')
  const match = targetSource.match(/deploymentTargetsJson = String\.raw`([\s\S]*?)`/)
  assert.notEqual(match, null, 'infra/targets.ts must expose deploymentTargetsJson')
  return decodeTargetDocument(match[1])
}

export const validateTargets = (targets) => {
  assert.deepEqual(
    Object.keys(targets).toSorted((left, right) => left.localeCompare(right)),
    targetKeys.toSorted((left, right) => left.localeCompare(right)),
    'target keys changed',
  )

  for (const key of targetKeys) {
    const target = targets[key]
    assert.equal(target.key, key, `${key} must decode to its own key`)
    for (const property of [...physicalNameKeys, 'serverUrl', 'runtimeUrl', 'webUrl']) {
      assert.ok(target[property].length > 0, `${key}.${property} must not be empty`)
    }
  }

  assert.equal(targets.local.runnable, true, 'local must be runnable')
  assert.equal(targets.local.database, 'docker', 'local must own Docker PostgreSQL')
  assert.equal(targets.preview.runnable, false, 'preview remote deployment must be disabled')
  assert.equal(targets.production.runnable, false, 'production remote deployment must be disabled')
  assert.equal(targets.preview.database, 'required', 'preview must require DATABASE_URL')
  assert.equal(targets.production.database, 'required', 'production must require DATABASE_URL')
  assert.equal(targets.production.destroyOnTeardown, false, 'production teardown must be protected')

  for (const property of physicalNameKeys) {
    const values = targetKeys.map((key) => targets[key][property])
    assert.equal(
      new Set(values).size,
      values.length,
      `${property} values must be unique across targets`,
    )
  }
}

const walkTypeScript = (directory) =>
  NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = NodePath.join(directory, entry.name)
    if (entry.isDirectory()) return walkTypeScript(entryPath)
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return []
    return [entryPath]
  })

const extractEnvironmentNames = (text) =>
  new Set([...text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map((match) => match[1]))

const assertEnvironmentWiring = (root, stackSource) => {
  const serverConfig = source(root, 'apps/server/src/config.ts')
  const serverNames = new Set(
    [...serverConfig.matchAll(/(?:required|optional)\(["']([A-Z][A-Z0-9_]*)["']/g)].map(
      (match) => match[1],
    ),
  )

  const runtimeFiles = [
    ...walkTypeScript(NodePath.join(root, 'packages/agent/runtime/src')),
    ...walkTypeScript(NodePath.join(root, 'packages/connectors/src')),
  ]
  const runtimeNames = new Set()
  for (const file of runtimeFiles) {
    for (const name of extractEnvironmentNames(NodeFS.readFileSync(file, 'utf8')))
      runtimeNames.add(name)
  }
  const runtimeExample = source(root, 'packages/agent/runtime/.env.example')
  for (const match of runtimeExample.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)) runtimeNames.add(match[1])

  for (const name of new Set([...serverNames, ...runtimeNames])) {
    assert.match(
      stackSource,
      new RegExp(`\\b${name}\\s*:`),
      `${name} is read by an app but not wired by Alchemy`,
    )
  }
}

const assertPackagePolicy = (packageDocument) => {
  // scripts/versions.mjs owns exact pins; this verifier requires catalog ownership.
  assert.equal(
    packageDocument.devDependencies.alchemy,
    'catalog:',
    'root Alchemy version must come from the catalog',
  )
  assert.equal(
    packageDocument.devDependencies.effect,
    'catalog:',
    'root Effect version must come from the catalog',
  )
  assert.match(
    packageDocument.scripts['infra:dev'],
    /alchemy dev/,
    'infra:dev must use alchemy dev',
  )
  assert.match(
    packageDocument.scripts['infra:destroy'],
    /VIVID_DEPLOY_TARGET=local/,
    'infra:destroy must be local-only',
  )
  assert.equal(
    packageDocument.scripts['infra:deploy'],
    undefined,
    'remote deploy script must not exist',
  )
  assert.equal(
    packageDocument.scripts['infra:preview'],
    undefined,
    'remote preview script must not exist',
  )
}

const assertStackPolicy = (stackSource, infrastructureSources) => {
  assert.doesNotMatch(
    infrastructureSources,
    /alchemy\/(Cloudflare|Railway|Neon)/,
    'removed cloud providers must not be imported',
  )
  assert.doesNotMatch(stackSource, /Alchemy\.remote\s*\(/, 'local stack must not opt into live AWS')
  assert.doesNotMatch(
    infrastructureSources,
    /AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)/,
    'local stack must not require AWS credentials',
  )
  assert.doesNotMatch(
    stackSource,
    /alchemy\/AWS/,
    'local stack must not load AWS providers: they boot the Floci emulator for nothing',
  )
  assert.match(
    stackSource,
    /Command\.Dev\(target\.serverProcessId/,
    'server must be an Alchemy-managed process',
  )
  assert.match(
    stackSource,
    /Command\.Dev\(target\.runtimeProcessId/,
    'runtime must be an Alchemy-managed process',
  )
  assert.match(stackSource, /Alchemy\.localState\(\)/, 'stack state must remain local')
  assert.match(
    stackSource,
    /requireRunnableTarget\(deployTarget\)/,
    'remote targets must fail before resource registration',
  )
  const outputBlock = stackSource.slice(stackSource.lastIndexOf('return {'))
  assert.doesNotMatch(
    outputBlock,
    /DATABASE_URL|SECRET|TOKEN|PASSWORD/,
    'stack outputs must contain only public URLs',
  )
}

const assertDatabasePolicy = (databaseSource) => {
  assert.match(
    databaseSource,
    /Docker\.RemoteImage/,
    'local database must declare Docker.RemoteImage',
  )
  assert.match(databaseSource, /Docker\.Volume/, 'local database must declare Docker.Volume')
  assert.match(databaseSource, /Docker\.Container/, 'local database must declare Docker.Container')
  assert.match(databaseSource, /tag: ["']18-alpine["']/, 'local database must use PostgreSQL 18')
  assert.doesNotMatch(
    databaseSource,
    /cmd: \[\s*["']CMD-SHELL["']/,
    'healthcheck cmd goes to --health-cmd; a CMD-SHELL prefix doubles it and the container never turns healthy',
  )
  assert.match(databaseSource, /external: 55433/, 'local database must bind host port 55433')
  assert.match(databaseSource, /POSTGRES_DB: ["']vivid["']/, 'local database name must be vivid')
  assert.match(databaseSource, /POSTGRES_USER: ["']vivid["']/, 'local database user must be vivid')
  assert.match(
    databaseSource,
    /Config\.Redacted\(["']DATABASE_URL["']\)/,
    'remote database URL must be required through Effect Config',
  )
}

const assertMigrationPolicy = (migrationSource) => {
  const serverMigration = migrationSource.search(/name: ["']server["']/)
  // The product tables moved from the Flue runtime into the server as a second migration owner
  // with its own history; it still runs after the server's auth and tenancy tables.
  const productMigration = migrationSource.search(/name: ["']server-product["']/)
  const connectorMigration = migrationSource.search(/name: ["']connectors["']/)
  assert.ok(
    serverMigration >= 0 &&
      serverMigration < productMigration &&
      productMigration < connectorMigration,
    'migration order must be server → server-product → connectors',
  )
  assert.doesNotMatch(migrationSource, /\bgenerate\b/, 'startup must never generate migrations')
}

const assertRepositoryPolicy = (root) => {
  assert.equal(
    NodeFS.existsSync(NodePath.join(root, 'apps/web/wrangler.jsonc')),
    false,
    'Wrangler config must be removed',
  )
  const workflowDirectory = NodePath.join(root, '.github/workflows')
  const workflowNames = NodeFS.existsSync(workflowDirectory)
    ? NodeFS.readdirSync(workflowDirectory)
    : []
  assert.deepEqual(
    workflowNames.filter((name) => name.startsWith('deploy')),
    [],
    'deploy workflows must not be added while remote deployment is disabled',
  )
  assert.ok(
    NodeFS.existsSync(NodePath.join(root, '.agents/skills/infra/SKILL.md')),
    'infra operator skill is missing',
  )
  assert.ok(
    NodeFS.existsSync(NodePath.join(root, 'docs/19-infrastructure.md')),
    'infrastructure documentation is missing',
  )
}

export const verifyInfrastructure = ({ root = defaultRoot } = {}) => {
  validateTargets(readTargetDocument(root))
  assertPackagePolicy(decodePackageDocument(source(root, 'package.json')))
  const stackSource = source(root, 'alchemy.run.ts')
  const databaseSource = source(root, 'infra/database.ts')
  const infrastructureSources = [
    stackSource,
    databaseSource,
    source(root, 'infra/env.ts'),
    source(root, 'infra/targets.ts'),
  ].join('\n')
  assertStackPolicy(stackSource, infrastructureSources)
  assertDatabasePolicy(databaseSource)
  assertEnvironmentWiring(root, stackSource)
  assertMigrationPolicy(source(root, 'scripts/migrate.mjs'))
  assertRepositoryPolicy(root)
  return { targets: targetKeys.length, serverEnvironmentVariables: 7, result: 'ok' }
}

const invokedUrl =
  process.argv[1] === undefined ? '' : NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href
if (import.meta.url === invokedUrl) {
  const result = verifyInfrastructure()
  console.log(`Infrastructure verification passed (${result.targets} targets)`)
}
