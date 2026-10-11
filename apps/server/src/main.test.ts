import * as NodeChildProcess from 'node:child_process'
import * as NodeProcess from 'node:process'
import * as NodeURL from 'node:url'
import { expect, it } from '@effect/vitest'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

/** Startup could not be observed; no environment, path or native error detail is retained. */
class StartupLaunchFailed extends Schema.TaggedError<StartupLaunchFailed>()(
  'StartupLaunchFailed',
  {},
  { title: 'Server startup test process unavailable' },
) {}

/**
 * Observe the shipped server entry with no app credentials or addresses. The absolute executable
 * and public tsx loader require no inherited environment. Listeners attach in the spawn tick;
 * scope kills only this captured child when needed and awaits native close before releasing it.
 */
const startupExit = Effect.fn('ServerStartup.test.exit')(function* (flags: ReadonlyArray<string>) {
  const owned = yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        const ended = Deferred.makeUnsafe<number | null, StartupLaunchFailed>()
        const closed = Deferred.makeUnsafe<void>()
        const child = NodeChildProcess.spawn(
          NodeProcess.execPath,
          [
            '--import',
            'tsx',
            ...flags,
            NodeURL.fileURLToPath(new URL('./main.ts', import.meta.url)),
          ],
          { cwd: NodeURL.fileURLToPath(new URL('..', import.meta.url)), env: {}, stdio: 'ignore' },
        )
        child.once('exit', (code) => Deferred.doneUnsafe(ended, Effect.succeed(code)))
        child.once('error', () =>
          Deferred.doneUnsafe(ended, Effect.fail(new StartupLaunchFailed())),
        )
        child.once('close', () => Deferred.doneUnsafe(closed, Effect.void))
        return { child, ended, closed }
      },
      catch: () => new StartupLaunchFailed(),
    }),
    (resource) =>
      Effect.gen(function* () {
        if (!(yield* Deferred.isDone(resource.closed))) {
          yield* Effect.sync(() => resource.child.kill('SIGKILL'))
          yield* Deferred.await(resource.closed)
        }
      }),
  )
  return yield* Deferred.await(owned.ended)
})

/**
 * The bound for one real start of the server entry. The child loads the whole server graph
 * through tsx before it can exit, which takes about four seconds alone on a developer machine
 * (measured 3.7 to 3.9 s on 4 October 2026) and longer beside the rest of the suite, so the
 * runner's five-second default failed correct runs. The test still waits on the child's own
 * exit and never sleeps.
 */
const STARTUP_TIMEOUT_MS = 30_000

/**
 * Configuration refusal must precede even config loading: the real entry exits EX_CONFIG (78)
 * with the overriding flag. A generic exit 1 also accepts import failures and does not prove
 * configuration ordering, so only the distinct extraction refusal is asserted here.
 */
it.effect(
  'refuses extraction configuration first',
  () =>
    Effect.gen(function* () {
      expect(yield* startupExit(['--max-old-space-size-percentage=50'])).toBe(78)
    }),
  STARTUP_TIMEOUT_MS,
)
