import * as NodeChildProcess from 'node:child_process'
import * as NodeEvents from 'node:events'
import * as NodeURL from 'node:url'

import { expect, onTestFinished } from 'vitest'

/** Pi harness-tools-recovery.test.ts:136; crash only the child whose persisted intent it announced.
 * Reuse the existing faux-only process fixture, retaining the real SQLite task and stored policy. */
export async function interrupt(file: string, policy: 'safe' | 'unsafe') {
  const child = NodeChildProcess.spawn(
    process.execPath,
    [NodeURL.fileURLToPath(new URL('./crash.ts', import.meta.url)), file, policy],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  )
  onTestFinished(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = NodeEvents.EventEmitter.once(child, 'exit')
    child.kill('SIGKILL')
    await exited
  })
  const [data] = await NodeEvents.EventEmitter.once(child.stdout, 'data')
  if (!Buffer.isBuffer(data)) throw new Error('Expected execution receipt')
  expect(data.toString()).toContain('executing')
  const exited = NodeEvents.EventEmitter.once(child, 'exit')
  child.kill('SIGKILL')
  await exited
}
