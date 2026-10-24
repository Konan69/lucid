import * as NodeChildProcess from 'node:child_process'
import * as NodeProcess from 'node:process'
import * as NodeURL from 'node:url'
import { expect, layer } from '@effect/vitest'
import * as Context from 'effect/Context'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import { StartupReceipt, StartupRequest } from '../tests/startup/protocol.ts'

/** Startup could not be observed; no environment, path or native error detail is retained. */
class StartupLaunchFailed extends Schema.TaggedError<StartupLaunchFailed>()(
  'StartupLaunchFailed',
  {},
  { title: 'Server startup test process unavailable' },
) {}

/** The prepared process exposes only the command that starts its real server entry. */
interface StartupProcess {
  readonly run: Effect.Effect<number | null, StartupLaunchFailed>
}

/** The file scope owns one prepared process through its final close receipt. */
class Startup extends Context.Service<Startup, StartupProcess>()('ServerStartup.test.process') {}

const decodeStartupReceipt = Schema.decodeUnknownResult(StartupReceipt)

/**
 * Dependency loading belongs to scoped layer acquisition, before the assertion's clock starts.
 * The public tsx loader runs with no inherited app credentials or addresses. Native listeners
 * attach in the spawn tick so even an early preparation failure settles readiness. Cleanup
 * kills only this captured child when needed and awaits close before releasing its scope.
 */
const startupLayer = Layer.effect(
  Startup,
  Effect.gen(function* () {
    const owned = yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          const ready = Deferred.makeUnsafe<void, StartupLaunchFailed>()
          const ended = Deferred.makeUnsafe<number | null, StartupLaunchFailed>()
          const closed = Deferred.makeUnsafe<void>()
          const child = NodeChildProcess.spawn(
            NodeProcess.execPath,
            [
              '--import',
              'tsx',
              '--max-old-space-size-percentage=50',
              NodeURL.fileURLToPath(new URL('../tests/startup/main.ts', import.meta.url)),
            ],
            {
              cwd: NodeURL.fileURLToPath(new URL('..', import.meta.url)),
              env: {},
              stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
            },
          )
          child.on('message', (message) => {
            const receipt = decodeStartupReceipt(message)
            Result.match(receipt, {
              onFailure: () => Deferred.doneUnsafe(ready, Effect.fail(new StartupLaunchFailed())),
              onSuccess: (value) =>
                StartupReceipt.match(value, {
                  Ready: () => Deferred.doneUnsafe(ready, Effect.void),
                }),
            })
          })
          child.once('exit', (code) => {
            Deferred.doneUnsafe(ended, Effect.succeed(code))
            Deferred.doneUnsafe(ready, Effect.fail(new StartupLaunchFailed()))
          })
          child.on('error', () => {
            Deferred.doneUnsafe(ended, Effect.fail(new StartupLaunchFailed()))
            Deferred.doneUnsafe(ready, Effect.fail(new StartupLaunchFailed()))
          })
          child.once('close', () => Deferred.doneUnsafe(closed, Effect.void))
          return { child, ready, ended, closed }
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
    yield* Deferred.await(owned.ready)
    /** Readiness precedes this command; the real entry's exit code is the assertion receipt. */
    const run = Effect.fn('StartupTest.run')(function* () {
      yield* Effect.try({
        try: () => owned.child.send(StartupRequest.cases.Run.make({})),
        catch: () => new StartupLaunchFailed(),
      })
      return yield* Deferred.await(owned.ended)
    })
    return Startup.of({ run: run() })
  }),
)

// Preparation and the actual startup retain separate instances of the existing 30 s budget.
const STARTUP_TIMEOUT_MS = 30_000
layer(startupLayer, { timeout: STARTUP_TIMEOUT_MS })('Server entry', (it) => {
  /** Only the production main program's extraction refusal selects 78 before config loading. */
  it.effect(
    'refuses extraction configuration first',
    () =>
      Effect.gen(function* () {
        const startup = yield* Startup
        expect(yield* startup.run).toBe(78)
      }),
    STARTUP_TIMEOUT_MS,
  )
})
