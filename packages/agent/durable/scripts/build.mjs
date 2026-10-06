import * as NodeChildProcess from 'node:child_process'
import * as NodeFSP from 'node:fs/promises'
import * as NodeURL from 'node:url'

const directory = NodeURL.fileURLToPath(new URL('../', import.meta.url))

// Clean both output and incremental state so removed modules never survive a later pack,
// and the compiler cannot skip emission after its output directory has been removed.
await NodeFSP.rm(new URL('../dist/', import.meta.url), { recursive: true, force: true })
await NodeFSP.rm(new URL('../.cache/typescript/build.tsbuildinfo', import.meta.url), {
  force: true,
})
const result = NodeChildProcess.spawnSync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.build.json'], {
  cwd: directory,
  stdio: 'inherit',
})
if (result.error !== undefined) throw result.error
if (result.status !== 0) throw new Error(`Package compiler failed: ${result.status}`)
