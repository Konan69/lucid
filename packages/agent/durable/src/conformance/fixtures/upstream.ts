import * as NodeChildProcess from 'node:child_process'
import * as NodeEvents from 'node:events'
import * as NodeURL from 'node:url'
import { Effect, type Scope } from 'effect'
import { expect } from 'vitest'
import { FixtureFailed } from '../../fixtures/harness.ts'
import type { Replay } from '../../core.ts'

/** Pi harness-tools-recovery.test.ts:136; crash only the child whose persisted intent it announced.
 * Cleanup owns that handle, and every exit listener is installed before SIGKILL. */
export const interrupt = Effect.fn('Test.interrupt')(function* (
  file: string,
  policy: Replay,
): Effect.fn.Return<void, FixtureFailed, Scope.Scope> {
  const child = yield* Effect.acquireRelease(
    Effect.sync(() =>
      NodeChildProcess.spawn(
        process.execPath,
        [NodeURL.fileURLToPath(new URL('./crash.ts', import.meta.url)), file, policy],
        { stdio: ['ignore', 'pipe', 'inherit'] },
      ),
    ),
    (spawned) =>
      Effect.promise(() => {
        if (spawned.exitCode !== null || spawned.signalCode !== null) return Promise.resolve([])
        const exited = NodeEvents.EventEmitter.once(spawned, 'exit')
        spawned.kill('SIGKILL')
        return exited
      }).pipe(Effect.asVoid),
  )
  const [data] = yield* Effect.tryPromise({
    try: () => NodeEvents.EventEmitter.once(child.stdout, 'data'),
    catch: (cause) => new FixtureFailed({ cause }),
  })
  if (!Buffer.isBuffer(data))
    return yield* new FixtureFailed({ cause: new Error('Expected execution receipt') })
  expect(data.toString()).toContain('executing')
  const exited = NodeEvents.EventEmitter.once(child, 'exit')
  child.kill('SIGKILL')
  return yield* Effect.asVoid(
    Effect.tryPromise({ try: () => exited, catch: (cause) => new FixtureFailed({ cause }) }),
  )
})
