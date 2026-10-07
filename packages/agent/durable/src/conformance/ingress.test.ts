import * as NodeChildProcess from 'node:child_process'
import * as NodeEvents from 'node:events'
import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'

/** Every process fixture must validate its disposable storage argument before opening anything.
 * A temporary cwd makes an accidental database named "undefined" observable; a captured spawn
 * handle owns cancellation even if setup fails. These guards already landed in the conversion. */
it.live.each([
  '../fixtures/answer.ts',
  '../fixtures/crash.ts',
  '../fixtures/reconnect.ts',
  '../fixtures/sequential.ts',
  '../fixtures/task.ts',
  './fixtures/crash.ts',
  './fixtures/generation.ts',
  './fixtures/toolsapproval.mjs',
  './fixtures/toolscrash.mjs',
])('child %s refuses a missing storage argument without writing a database', (file) =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'durable-ingress-'))),
      (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
    )
    const child = yield* Effect.acquireRelease(
      Effect.sync(() =>
        NodeChildProcess.spawn(
          process.execPath,
          [NodeURL.fileURLToPath(new URL(file, import.meta.url))],
          {
            cwd: directory,
            stdio: ['ignore', 'ignore', 'pipe'],
          },
        ),
      ),
      (value) =>
        Effect.sync(() => {
          if (value.exitCode === null && value.signalCode === null) value.kill('SIGKILL')
        }),
    )
    if (child.stderr === null) throw new Error('Expected stderr pipe')
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    const [code, signal] = yield* Effect.promise(() => NodeEvents.EventEmitter.once(child, 'close'))
    expect(code).not.toBe(0)
    expect(signal).toBeNull()
    expect(stderr).toMatch(/Expected (a disposable|disposable|database)|usage: crash\.ts/u)
    expect(yield* Effect.promise(() => NodeFSP.readdir(directory))).toEqual([])
  }),
)
