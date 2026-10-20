import * as NodeAssert from 'node:assert/strict'
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import * as Schema from 'effect/Schema'
import { verifyImage } from './images.mjs'

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
  database: Schema.Literals(['docker', 'railway', 'required']),
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
    'infra:deploy': Schema.String,
    'infra:preview': Schema.optionalKey(Schema.String),
  }),
})
const decodeTargetDocument = Schema.decodeUnknownSync(Schema.fromJsonString(TargetDocument))
const decodePackageDocument = Schema.decodeUnknownSync(Schema.fromJsonString(PackageDocument))
const decodeContainerCommand = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Schema.String)),
)
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
  assert.equal(targets.production.runnable, true, 'production must be runnable on Railway')
  assert.equal(targets.preview.database, 'required', 'preview must require DATABASE_URL')
  assert.equal(targets.production.database, 'railway', 'production must own Railway PostgreSQL')
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

/**
 * The settings an image sets for itself with `ENV NAME=value`, one per line, in the stage the
 * image is (its last) and the stages that one is built `FROM`. A setting only the image can know,
 * such as the commit it was built from (`VIVID_BUILD_COMMIT`), is wired by the image and not by
 * the deploy graph: a host variable of the same name would replace it. A stage the last one does
 * not descend from (a build stage it only copies files out of) sets nothing in the image.
 */
export const imageSettings = (dockerfile) => {
  const stages = []
  for (const line of dockerfile.split('\n')) {
    const from = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i.exec(line)
    if (from !== null) stages.push({ base: from[1], name: from[2], settings: [] })
    const set = /^ENV\s+([A-Z][A-Z0-9_]*)=/.exec(line)
    if (set !== null && stages.length > 0) stages[stages.length - 1].settings.push(set[1])
  }
  const settings = new Set()
  // Each stage can only name one before it, so the walk back ends.
  for (let index = stages.length - 1; index >= 0;) {
    const stage = stages[index]
    for (const name of stage.settings) settings.add(name)
    index = stages.slice(0, index).findLastIndex((earlier) => earlier.name === stage.base)
  }
  return settings
}

/**
 * The names an app reads that nothing sets. The local process graph and the Railway graph wire a
 * name when either sets it. The server image wires a name only the server reads: the runtime is
 * another image, so a name it reads too must still be sent to it by a graph.
 */
export const unwiredNames = ({ serverNames, runtimeNames, wiringSource, serverImage }) =>
  [...new Set([...serverNames, ...runtimeNames])].filter(
    (name) =>
      !(serverImage.has(name) && !runtimeNames.has(name)) &&
      !new RegExp(`\\b${name}\\s*:`).test(wiringSource),
  )

const assertEnvironmentWiring = (root, stackSource) => {
  const serverConfig = source(root, 'apps/server/src/config.ts')
  const serverNames = new Set(
    [
      ...serverConfig.matchAll(
        /(?:requiredSetting|optionalSetting)\(\s*["']([A-Z][A-Z0-9_]*)["']/g,
      ),
    ].map((match) => match[1]),
  )
  // A setting the server does not start without is read by the adapter that owns it, anywhere
  // under the server's sources. Each one must be wired as well: a required setting the deploy
  // never sends is a server that cannot start, and before it was required it was a part of the
  // product that was silently off in production (the Computer, until 5 October 2026).
  for (const file of walkTypeScript(NodePath.join(root, 'apps/server/src'))) {
    const text = NodeFS.readFileSync(file, 'utf8')
    for (const match of text.matchAll(/requiredSetting\(\s*["']([A-Z][A-Z0-9_]*)["']/g))
      serverNames.add(match[1])
  }

  const runtimeFiles = [
    ...walkTypeScript(NodePath.join(root, 'packages/agent/runtime/src')),
    ...walkTypeScript(NodePath.join(root, 'apps/server/src/connections')),
  ]
  const runtimeNames = new Set()
  for (const file of runtimeFiles) {
    for (const name of extractEnvironmentNames(NodeFS.readFileSync(file, 'utf8')))
      runtimeNames.add(name)
  }
  const runtimeExample = source(root, 'packages/agent/runtime/.env.example')
  for (const match of runtimeExample.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)) runtimeNames.add(match[1])

  // `VIVID_WEB_DIST` exists only where the server serves the built web app, which is hosted only.
  const unwired = unwiredNames({
    serverNames,
    runtimeNames,
    wiringSource: `${stackSource}\n${source(root, 'infra/railway.ts')}`,
    serverImage: imageSettings(source(root, 'apps/server/Dockerfile')),
  })
  for (const name of unwired) assert.fail(`${name} is read by an app but not wired by Alchemy`)
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
  // A hosted deploy creates billed resources, so the script must name its target explicitly.
  assert.match(
    packageDocument.scripts['infra:deploy'],
    /VIVID_DEPLOY_TARGET=production .*alchemy deploy --stage production/,
    'infra:deploy must deploy only the production target',
  )
  // Alchemy loads `.env` unless told otherwise, and `.env` holds a developer's local values. A
  // production deploy once shipped those (a model with no key, a missing Executor key), so the
  // script names the production file and fails when it is absent.
  assert.match(
    packageDocument.scripts['infra:deploy'],
    /--env-file \.env\.production\b/,
    'infra:deploy must load production settings from .env.production',
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
    /alchemy\/(Cloudflare|Neon)/,
    'removed cloud providers must not be imported',
  )
  // Railway is the one hosted provider. It may be loaded only for a Railway target, so
  // `alchemy dev` on the local target never needs a Railway credential.
  assert.match(
    stackSource,
    /deployTarget\.database === 'railway' \? railwayStack\(\) : localStack\(\)/,
    'Railway providers must load only for a Railway target',
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
  // The local stack's resources are the machine's own Docker and processes, so its state stays in
  // that checkout. Production's state lives in the hosted store (`infra/state.ts`): read from a
  // checkout's `.alchemy`, every other machine would plan to create production again.
  assert.equal(
    [...stackSource.matchAll(/Alchemy\.localState\(\)/g)].length,
    1,
    'only the local stack may keep its state in the checkout',
  )
  assert.match(
    stackSource,
    /state: hostedState\(deployTarget\.stackName\)/,
    'the hosted stack must read the hosted state store',
  )
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
  assert.ok(
    serverMigration >= 0 && serverMigration < productMigration,
    'migration order must be server → server-product',
  )
  assert.doesNotMatch(
    migrationSource,
    /name: ["']connectors["']/,
    'connector migration owner was dissolved',
  )
  assert.doesNotMatch(migrationSource, /\bgenerate\b/, 'startup must never generate migrations')
}

/** The paths a Dockerfile copies out of the repository; a copy from another stage is not one. */
const copiedPaths = (dockerfile) =>
  dockerfile
    .split('\n')
    .filter((line) => /^(COPY|ADD) /.test(line) && !line.includes('--from='))
    .flatMap((line) =>
      line
        .split(/\s+/)
        .slice(1, -1)
        .filter((word) => !word.startsWith('--')),
    )

/**
 * Whether one of Railway's watch patterns names a path. The patterns are gitignore-style and
 * start at the repository's root (Railway "Watch Paths"). Only the forms this stack writes are
 * read: a literal path, `*` for one segment, and a closing `/**` for a directory and all in it.
 */
const watches = (pattern, path) => {
  const under = pattern.endsWith('/**')
  const literal = (under ? pattern.slice(0, -3) : pattern)
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replaceAll('*', '[^/]*')
  return new RegExp(`^${literal}${under ? '(/.*)?' : ''}$`).test(`/${path}`)
}

/**
 * What an image is built from that its service's watch patterns miss. Railway starts no build
 * for a push that touches only unwatched paths, so a path listed here would change the image's
 * inputs without production ever being rebuilt. The Dockerfile and `.dockerignore` are inputs
 * too, though no `COPY` names them.
 */
export const unwatchedPaths = (dockerfile, dockerfilePath, patterns, configInputs) =>
  [
    ...new Set([...copiedPaths(dockerfile), ...configInputs, dockerfilePath, '.dockerignore']),
  ].filter((path) => !patterns.some((pattern) => watches(pattern, path)))

/**
 * Railway startCommand overrides image CMD. Verify their parity so the offline image proof
 * exercises the deployed entry. Railway builds both images from the repository on a push to
 * `main` (`builtFromMain` in `infra/railway.ts`), so each service must watch every path its
 * Dockerfile copies.
 */
const assertContainerPolicy = (root) => {
  const railwaySource = source(root, 'infra/railway.ts')
  const trigger = railwaySource.match(/^const builtFromMain = \{([\s\S]*?)^\} as const/m)
  assert.notEqual(trigger, null, 'the repository source must be declared once')
  assert.ok(trigger[1].includes("branch: 'main'"), 'production is built from main')
  assert.ok(trigger[1].includes('autoUpdates: true'), 'a push to main must deploy')
  for (const [name, dockerfilePath, stages] of [
    ['Runtime', 'packages/agent/runtime/Dockerfile', { build: ['@vivid/agent-runtime'] }],
    [
      'Server',
      'apps/server/Dockerfile',
      { build: ['@vivid/server', '@vivid/web'], updates: ['@vivid/mobile'] },
    ],
  ]) {
    const declaration = railwaySource.match(
      new RegExp(`Railway\\.Service\\('${name}', \\{([\\s\\S]*?)^  \\}\\)`, 'm'),
    )
    assert.notEqual(declaration, null, `${name} must declare a Railway Service`)
    const block = declaration[1]
    assert.ok(block.includes('...builtFromMain'), `${name} must be built from the repository`)
    assert.ok(!block.includes('context:'), `${name} must not upload a working tree`)
    const named = block.match(/watchPatterns: (\w+)/)
    assert.notEqual(named, null, `${name} must say which paths rebuild it`)
    const listed = railwaySource.match(new RegExp(`^const ${named[1]} = \\[([\\s\\S]*?)^\\]`, 'm'))
    assert.notEqual(listed, null, `${name} must list its watched paths in infra/railway.ts`)
    const patterns = [...listed[1].matchAll(/'([^']+)'/g)].map((found) => found[1])
    const configInputs = verifyImage({ root, dockerfile: source(root, dockerfilePath), stages })
    assert.deepEqual(
      unwatchedPaths(source(root, dockerfilePath), dockerfilePath, patterns, configInputs),
      [],
      `${name} copies paths that would not rebuild it`,
    )
    assert.ok(
      block.includes(`dockerfilePath: '${dockerfilePath}'`),
      `${name} must select its checked-in Dockerfile`,
    )
    const entry = source(root, dockerfilePath).match(/^CMD (\[.*\])$/m)
    assert.notEqual(entry, null, `${name} Dockerfile must declare its production command`)
    const command = decodeContainerCommand(entry[1]).join(' ')
    assert.ok(
      block.includes(`startCommand: '${command}'`),
      `${name} Railway startCommand must match image CMD`,
    )
  }
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
  assertContainerPolicy(root)
  assertRepositoryPolicy(root)
  return { targets: targetKeys.length, serverEnvironmentVariables: 7, result: 'ok' }
}

const invokedUrl =
  process.argv[1] === undefined ? '' : NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href
if (import.meta.url === invokedUrl) {
  const result = verifyInfrastructure()
  console.log(`Infrastructure verification passed (${result.targets} targets)`)
}
