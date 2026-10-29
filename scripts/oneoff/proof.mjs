import * as NodeChildProcess from 'node:child_process'
import * as NodeURL from 'node:url'
import * as NodeReadline from 'node:readline'
import { openRunDatabase } from '../gate/database.mjs'

/** Wait for this image's listener receipt, then close only the log follower this proof spawned. */
async function ready(container) {
  const logs = NodeChildProcess.spawn('docker', ['logs', '--follow', container])
  try {
    await new Promise((resolve, reject) => {
      for (const stream of [logs.stdout, logs.stderr]) {
        const lines = NodeReadline.createInterface({ input: stream })
        lines.on('line', (line) => {
          if (line.includes('HTTP server listening')) resolve()
        })
      }
      logs.once('error', reject)
      logs.once('close', () => reject(new Error('Helix exited before its HTTP listener started')))
    })
  } finally {
    logs.kill('SIGTERM')
  }
}

/** Both sources and native cell SQLite are disposable. Cleanup owns only captured resources. */
const root = NodeURL.fileURLToPath(new URL('../../', import.meta.url))
const run = `history_${Date.now()}`
const database = await openRunDatabase(root, process.env, run)
let helix
try {
  helix = NodeChildProcess.execFileSync(
    'docker',
    [
      'create',
      '--name',
      `vivid-${run}`,
      '--label',
      `vivid.oneoff=${run}`,
      '--publish',
      '127.0.0.1::8080',
      'ghcr.io/helixdb/helixdb:v0.0.5',
    ],
    { encoding: 'utf8' },
  ).trim()
  NodeChildProcess.execFileSync('docker', ['start', helix])
  await ready(helix)
  const address = NodeChildProcess.execFileSync('docker', ['port', helix, '8080/tcp'], {
    encoding: 'utf8',
  }).trim()
  process.exitCode = await new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      process.execPath,
      ['node_modules/vitest/vitest.mjs', 'run', '--config', 'scripts/oneoff/vitest.config.ts'],
      {
        cwd: root,
        env: {
          ...process.env,
          VIVID_TEST_DATABASE_URL: database.url,
          VIVID_TEST_HELIX_URL: `http://${address}`,
        },
        stdio: 'inherit',
      },
    )
    child.once('error', reject)
    child.once('close', (code) => resolve(code === null ? 1 : code))
  })
} finally {
  try {
    if (helix !== undefined)
      NodeChildProcess.execFileSync('docker', ['rm', '--force', '--volumes', helix])
  } finally {
    await database.close()
  }
}
