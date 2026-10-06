import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as NodeChildProcess from 'node:child_process'
import * as NodeProcess from 'node:process'
import * as NodeURL from 'node:url'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

/**
 * Exports the app's JavaScript as one over-the-air update, in the directory layout the server
 * reads (`apps/server/src/updates/release.ts`):
 *
 *   <root>/<runtime version>/<publish time, epoch seconds>/
 *     metadata.json     written by `expo export`: the bundle and assets of each platform
 *     expoConfig.json   the public Expo config, served to the app as `extra.expoClient`
 *     _expo/, assets/   the files themselves
 *
 * Ported from `expo-updates-server/scripts/publish.sh` and `exportClientExpoConfig.js` in
 * expo/custom-expo-updates-server. Two changes: the runtime version comes from expo-updates' own
 * resolver instead of being typed by hand, and the directory is named by the publish time, which
 * the server uses as the update's `createdAt` (the reference reads the file's birth time, which a
 * container image layer does not keep).
 */
const root = NodeURL.fileURLToPath(new URL('../', import.meta.url))
const platforms = ['ios', 'android']
const target = process.argv[2]
if (target === undefined) throw new Error('Usage: node scripts/publish.mjs <updates directory>')

/** Runs one command in the app directory and returns what it printed; a failure ends the publish. */
function capture(command, args) {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: NodeProcess.platform === 'win32',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
  return result.stdout
}

/**
 * What `expo-updates runtimeversion:resolve` prints: one JSON line, the `runtimeVersionInfo` that
 * `resolveRuntimeVersion` in `expo-updates/cli/build/resolveRuntimeVersion.js` (57.0.24) passes to
 * `console.log(JSON.stringify(...))`. `resolveRuntimeVersionAsync` returns `runtimeVersion: null`
 * when the app config sets none; that is not publishable, because the version names the directory
 * the server reads, so null and the empty string fail the decode. `fingerprintSources` and
 * `workflow` are also printed and are not read here.
 */
const RuntimeVersionInfo = Schema.Struct({ runtimeVersion: Schema.NonEmptyString })
const decodeRuntimeVersionInfo = Schema.decodeUnknownOption(
  Schema.fromJsonString(RuntimeVersionInfo),
)

/**
 * Resolves one platform's runtime version through expo-updates' own resolver. The printed line is
 * decoded once, here; the failure names the platform and never the rejected output.
 */
function resolveRuntimeVersion(platform) {
  const info = decodeRuntimeVersionInfo(
    capture('pnpm', ['exec', 'expo-updates', 'runtimeversion:resolve', '--platform', platform]),
  )
  if (Option.isNone(info))
    throw new Error(`expo-updates did not resolve a runtime version for ${platform}`)
  return info.value.runtimeVersion
}

/**
 * One export carries both platforms, so both must resolve to the same runtime version. That holds
 * under the `appVersion` policy in `app.json`; a policy that differs by platform would need one
 * export for each, and this stops instead of mislabelling one of them.
 */
const versions = new Set(platforms.map(resolveRuntimeVersion))
if (versions.size !== 1)
  throw new Error(`Platforms disagree on the runtime version: ${[...versions].join(', ')}`)
const [runtimeVersion] = versions

const directory = NodePath.resolve(target, runtimeVersion, String(Math.floor(Date.now() / 1000)))
const exported = NodeChildProcess.spawnSync(
  'pnpm',
  [
    'exec',
    'expo',
    'export',
    ...platforms.flatMap((platform) => ['--platform', platform]),
    '--output-dir',
    directory,
    // Maps for Sentry (`metro.config.js`). Without them a report's frames name offsets in the
    // bundle instead of the source they came from. The export writes the maps beside their
    // bundles; `metadata.json` does not list them, so the app never downloads them.
    '--source-maps',
    'external',
  ],
  { cwd: root, stdio: 'inherit', shell: NodeProcess.platform === 'win32' },
)
if (exported.error) throw exported.error
if (exported.status !== 0) process.exit(exported.status ?? 1)
NodeFS.writeFileSync(
  NodePath.join(directory, 'expoConfig.json'),
  capture('pnpm', ['exec', 'expo', 'config', '--json', '--type', 'public']),
)

// The maps go to Sentry so its reports come back with readable stack frames; the bundle and its
// map already carry the debug ID that pairs them (`metro.config.js`). Uploading is the root
// script's job, so the credentials and the idempotent behaviour live in one place. Without
// `SENTRY_AUTH_TOKEN` it leaves the maps on disk and reports, and the publish still stands: the
// update itself is complete without them, only Sentry's frames stay unreadable.
NodeChildProcess.spawnSync(
  'node',
  [NodePath.join(root, '../../scripts/sentry-upload.mjs'), 'vivid-mobile', directory],
  { stdio: 'inherit' },
)

// Anything metadata.json does not name stays unread by the app, and the map files are the only
// such files an export leaves (`--source-maps external` above): a map is for the server's Sentry
// upload only, never for a phone. Keeping the export to what `metadata.json` names keeps the
// server's release directory honest, and sources are not shipped where they are not used.
const metadata = JSON.parse(NodeFS.readFileSync(NodePath.join(directory, 'metadata.json'), 'utf8'))
const named = new Set(
  Object.values(metadata.fileMetadata)
    .flatMap((platform) => [platform.launchAsset.path, ...platform.assets.map((asset) => asset.path)])
    .map((path) => NodePath.resolve(directory, path)),
)
for (const file of findMaps(directory)) {
  if (!named.has(NodePath.resolve(directory, file))) NodeFS.rmSync(NodePath.resolve(directory, file))
}

/** Every `.map` below `directory`, through the relative paths this script and the server both use. */
function findMaps(directory) {
  const maps = []
  const visit = (relative) => {
    for (const name of NodeFS.readdirSync(NodePath.join(directory, relative), {
      withFileTypes: true,
    })) {
      const path = NodePath.join(relative, name.name)
      if (name.isDirectory()) visit(path)
      else if (path.endsWith('.map')) maps.push(path)
    }
  }
  visit('.')
  return maps
}

console.log(`Published runtime ${runtimeVersion} to ${directory}`)
