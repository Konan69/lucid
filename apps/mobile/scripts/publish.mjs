import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as NodeChildProcess from 'node:child_process'
import * as NodeProcess from 'node:process'
import * as NodeURL from 'node:url'

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
 * One export carries both platforms, so both must resolve to the same runtime version. That holds
 * under the `appVersion` policy in `app.json`; a policy that differs by platform would need one
 * export for each, and this stops instead of mislabelling one of them.
 */
const versions = new Set(
  platforms.map(
    (platform) =>
      JSON.parse(
        capture('pnpm', ['exec', 'expo-updates', 'runtimeversion:resolve', '--platform', platform]),
      ).runtimeVersion,
  ),
)
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
  ],
  { cwd: root, stdio: 'inherit', shell: NodeProcess.platform === 'win32' },
)
if (exported.error) throw exported.error
if (exported.status !== 0) process.exit(exported.status ?? 1)
NodeFS.writeFileSync(
  NodePath.join(directory, 'expoConfig.json'),
  capture('pnpm', ['exec', 'expo', 'config', '--json', '--type', 'public']),
)
console.log(`Published runtime ${runtimeVersion} to ${directory}`)
