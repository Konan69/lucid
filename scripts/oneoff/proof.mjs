import * as NodeChildProcess from 'node:child_process'
import * as NodeURL from 'node:url'
import { openRunDatabase } from '../gate/database.mjs'

/** This proof owns a disposable PostgreSQL invocation and drops it even when Vitest fails. */
const root = NodeURL.fileURLToPath(new URL('../../', import.meta.url))
const database = await openRunDatabase(root, process.env, `history_${Date.now()}`)
try {
  process.exitCode = await new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      process.execPath,
      ['node_modules/vitest/vitest.mjs', 'run', '--config', 'scripts/oneoff/vitest.config.ts'],
      {
        cwd: root,
        env: { ...process.env, VIVID_TEST_DATABASE_URL: database.url },
        stdio: 'inherit',
      },
    )
    child.once('error', reject)
    child.once('close', (code) => resolve(code === null ? 1 : code))
  })
} finally {
  await database.close()
}
