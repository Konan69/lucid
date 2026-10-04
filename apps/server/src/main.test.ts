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
 * Configuration refusal must precede even config loading: the real entry exits EX_CONFIG (78)
 * with the overriding flag, while the same empty-environment control reaches missing app config
 * and exits 1. Layer acquisition remains downstream of that config, as main.ts defines it. Each
 * independent case owns one graph-loading child; launching both at once unnecessarily competes
 * with the suite's other native processes and obscures the startup ordering being checked.
 */
it.effect.each([
  {
    name: 'refuses extraction configuration first',
    flags: ['--max-old-space-size-percentage=50'],
    code: 78,
  },
  { name: 'uses the default failure exit with supported options', flags: [], code: 1 },
])('$name', ({ flags, code }) =>
  Effect.gen(function* () {
    expect(yield* startupExit(flags)).toBe(code)
  }),
)
