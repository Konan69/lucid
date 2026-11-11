import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeURL from 'node:url'

/**
 * The gate exports through the image's publisher, without Hermes bytecode (`--no-bytecode` in
 * `publish.mjs` says why). Each miss replaces its private output so old runtime versions and
 * publish timestamps cannot accumulate in the next Turbo cache entry.
 */
const directory = NodeURL.fileURLToPath(new URL('../.cache/updates', import.meta.url))
NodeFS.rmSync(directory, { recursive: true, force: true })
// Metro's default is os.tmpdir()/metro-cache. Keep transforms private to this tree and outside
// the cached update artifact so one session cannot reuse another session's transforms.
const temporary = NodeURL.fileURLToPath(new URL('../.cache/metro', import.meta.url))
NodeFS.mkdirSync(temporary, { recursive: true })
const environment = { ...process.env, TMPDIR: temporary, CI: '1', EXPO_NO_TELEMETRY: '1' }
// A gate checks artifacts, including uncommitted snapshots, without publishing their maps.
delete environment.SENTRY_AUTH_TOKEN
const result = NodeChildProcess.spawnSync(
  process.execPath,
  [NodeURL.fileURLToPath(new URL('./publish.mjs', import.meta.url)), directory, '--no-bytecode'],
  { stdio: 'inherit', env: environment },
)
if (result.error !== undefined) throw result.error
process.exit(result.status === null ? 1 : result.status)
