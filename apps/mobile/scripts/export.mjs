import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeURL from 'node:url'

/**
 * The gate exports through the image's publisher. Each miss replaces its private output so old
 * runtime versions and publish timestamps cannot accumulate in the next Turbo cache entry.
 */
const directory = NodeURL.fileURLToPath(new URL('../.cache/updates', import.meta.url))
NodeFS.rmSync(directory, { recursive: true, force: true })
const result = NodeChildProcess.spawnSync(
  process.execPath,
  [NodeURL.fileURLToPath(new URL('./publish.mjs', import.meta.url)), directory],
  { stdio: 'inherit', env: { ...process.env, EXPO_NO_TELEMETRY: '1' } },
)
if (result.error !== undefined) throw result.error
process.exit(result.status === null ? 1 : result.status)
