import assert from "node:assert/strict"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const defaultRoot = resolve(scriptDirectory, "..")
const targetKeys = ["local", "preview", "production"]
const physicalNameKeys = [
  "stackName",
  "stage",
  "postgresImageId",
  "postgresVolumeName",
  "postgresContainerName",
  "migrationsId",
  "serverProcessId",
  "runtimeProcessId",
  "webId"
]

const source = (root, relativePath) => readFileSync(join(root, relativePath), "utf8")

export const readTargetDocument = (root = defaultRoot) => {
  const targetSource = source(root, "infra/targets.ts")
  const match = targetSource.match(/deploymentTargetsJson = String\.raw`([\s\S]*?)`/)
  assert.notEqual(match, null, "infra/targets.ts must expose deploymentTargetsJson")
  return JSON.parse(match[1])
}

export const validateTargets = (targets) => {
  assert.deepEqual(Object.keys(targets).sort(), [...targetKeys].sort(), "target keys changed")

  for (const key of targetKeys) {
    const target = targets[key]
    assert.equal(target.key, key, `${key} must decode to its own key`)
    assert.equal(typeof target.runnable, "boolean", `${key}.runnable must be boolean`)
    assert.equal(typeof target.destroyOnTeardown, "boolean", `${key}.destroyOnTeardown must be boolean`)
    assert.ok(["docker", "required"].includes(target.database), `${key}.database is invalid`)
    for (const property of [...physicalNameKeys, "serverUrl", "runtimeUrl", "webUrl"]) {
      assert.equal(typeof target[property], "string", `${key}.${property} must be a string`)
      assert.ok(target[property].length > 0, `${key}.${property} must not be empty`)
    }
  }

  assert.equal(targets.local.runnable, true, "local must be runnable")
  assert.equal(targets.local.database, "docker", "local must own Docker PostgreSQL")
  assert.equal(targets.preview.runnable, false, "preview remote deployment must be disabled")
  assert.equal(targets.production.runnable, false, "production remote deployment must be disabled")
  assert.equal(targets.preview.database, "required", "preview must require DATABASE_URL")
  assert.equal(targets.production.database, "required", "production must require DATABASE_URL")
  assert.equal(targets.production.destroyOnTeardown, false, "production teardown must be protected")

  for (const property of physicalNameKeys) {
    const values = targetKeys.map((key) => targets[key][property])
    assert.equal(new Set(values).size, values.length, `${property} values must be unique across targets`)
  }
}

const walkTypeScript = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const entryPath = join(directory, entry.name)
  if (entry.isDirectory()) return walkTypeScript(entryPath)
  if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) return []
  return [entryPath]
})

const extractEnvironmentNames = (text) => new Set(
  [...text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map((match) => match[1])
)

const assertEnvironmentWiring = (root, stackSource) => {
  const serverConfig = source(root, "apps/server/src/config.ts")
  const serverNames = new Set(
    [...serverConfig.matchAll(/(?:required|optional)\("([A-Z][A-Z0-9_]*)"/g)].map((match) => match[1])
  )

  const runtimeFiles = [
    ...walkTypeScript(join(root, "packages/agent-runtime/src")),
    ...walkTypeScript(join(root, "packages/connectors/src"))
  ]
  const runtimeNames = new Set(runtimeFiles.flatMap((file) => [...extractEnvironmentNames(readFileSync(file, "utf8"))]))
  const runtimeExample = source(root, "packages/agent-runtime/.env.example")
  for (const match of runtimeExample.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)) runtimeNames.add(match[1])

  for (const name of new Set([...serverNames, ...runtimeNames])) {
    assert.match(stackSource, new RegExp(`\\b${name}\\s*:`), `${name} is read by an app but not wired by Alchemy`)
  }
}

export const verifyInfrastructure = ({ root = defaultRoot } = {}) => {
  const targets = readTargetDocument(root)
  validateTargets(targets)

  const packageDocument = JSON.parse(source(root, "package.json"))
  assert.equal(packageDocument.devDependencies.alchemy, "2.0.0-beta.76", "root Alchemy version must stay pinned")
  assert.equal(packageDocument.devDependencies.effect, "4.0.0-rc.112", "root Effect version must match Alchemy")
  assert.match(packageDocument.scripts["infra:dev"], /alchemy dev/, "infra:dev must use alchemy dev")
  assert.match(packageDocument.scripts["infra:destroy"], /VIVID_DEPLOY_TARGET=local/, "infra:destroy must be local-only")
  assert.equal(packageDocument.scripts["infra:deploy"], undefined, "remote deploy script must not exist")
  assert.equal(packageDocument.scripts["infra:preview"], undefined, "remote preview script must not exist")

  const stackSource = source(root, "alchemy.run.ts")
  const infrastructureSources = [
    stackSource,
    source(root, "infra/database.ts"),
    source(root, "infra/env.ts"),
    source(root, "infra/targets.ts")
  ].join("\n")
  assert.doesNotMatch(infrastructureSources, /alchemy\/(Cloudflare|Railway|Neon)/, "removed cloud providers must not be imported")
  assert.doesNotMatch(stackSource, /Alchemy\.remote\s*\(/, "local stack must not opt into live AWS")
  assert.doesNotMatch(infrastructureSources, /AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)/, "local stack must not require AWS credentials")
  assert.match(stackSource, /AWS\.Website\.StaticSite/, "web SPA must use the AWS Website local implementation")
  assert.match(stackSource, /Command\.Dev\(target\.serverProcessId/, "server must be an Alchemy-managed process")
  assert.match(stackSource, /Command\.Dev\(target\.runtimeProcessId/, "runtime must be an Alchemy-managed process")
  assert.match(stackSource, /Alchemy\.localState\(\)/, "stack state must remain local")
  assert.match(stackSource, /requireRunnableTarget\(deployTarget\)/, "remote targets must fail before resource registration")

  const databaseSource = source(root, "infra/database.ts")
  assert.match(databaseSource, /Docker\.RemoteImage/, "local database must declare Docker.RemoteImage")
  assert.match(databaseSource, /Docker\.Volume/, "local database must declare Docker.Volume")
  assert.match(databaseSource, /Docker\.Container/, "local database must declare Docker.Container")
  assert.match(databaseSource, /tag: "18-alpine"/, "local database must use PostgreSQL 18")
  assert.match(databaseSource, /external: 55433/, "local database must bind host port 55433")
  assert.match(databaseSource, /POSTGRES_DB: "vivid"/, "local database name must be vivid")
  assert.match(databaseSource, /POSTGRES_USER: "vivid"/, "local database user must be vivid")
  assert.match(databaseSource, /Config\.redacted\("DATABASE_URL"\)/, "remote database URL must be required through Effect Config")

  assertEnvironmentWiring(root, stackSource)

  const migrationSource = source(root, "scripts/migrate.mjs")
  const serverMigration = migrationSource.indexOf('name: "server"')
  const runtimeMigration = migrationSource.indexOf('name: "agent-runtime"')
  const connectorMigration = migrationSource.indexOf('name: "connectors"')
  assert.ok(serverMigration >= 0 && serverMigration < runtimeMigration && runtimeMigration < connectorMigration, "migration order must be server → agent-runtime → connectors")
  assert.doesNotMatch(migrationSource, /\bgenerate\b/, "startup must never generate migrations")

  assert.equal(existsSync(join(root, "apps/web/wrangler.jsonc")), false, "Wrangler config must be removed")
  const workflowDirectory = join(root, ".github/workflows")
  const workflowNames = existsSync(workflowDirectory) ? readdirSync(workflowDirectory) : []
  assert.deepEqual(workflowNames.filter((name) => name.startsWith("deploy")), [], "deploy workflows must not be added while remote deployment is disabled")
  assert.ok(existsSync(join(root, ".agents/skills/infra/SKILL.md")), "infra operator skill is missing")
  assert.ok(existsSync(join(root, "docs/19-infrastructure.md")), "infrastructure documentation is missing")

  const outputBlock = stackSource.slice(stackSource.lastIndexOf("return {"))
  assert.doesNotMatch(outputBlock, /DATABASE_URL|SECRET|TOKEN|PASSWORD/, "stack outputs must contain only public URLs")

  return {
    targets: targetKeys.length,
    serverEnvironmentVariables: 7,
    result: "ok"
  }
}

const invokedUrl = process.argv[1] === undefined ? "" : pathToFileURL(resolve(process.argv[1])).href
if (import.meta.url === invokedUrl) {
  const result = verifyInfrastructure()
  console.log(`Infrastructure verification passed (${result.targets} targets)`)
}
