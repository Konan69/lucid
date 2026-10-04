import * as NodeFS from 'node:fs'
import NodeProcess from 'node:process'
import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeWorkerRunner from '@effect/platform-node/NodeWorkerRunner'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as RpcServer from 'effect/unstable/rpc/RpcServer'
import { ExtractionFaulted, ExtractionRpcs } from '../extraction/contract.ts'
import { Fixture, FixtureArgument } from './mode.ts'
import { RECEIPT_FD } from './process/mode.ts'

/** `fork` builds argv as `[execPath, modulePath, ...args]` (Node v24.14.1 lib/child_process.js:160). */
const input = Schema.decodeUnknownSync(FixtureArgument)(NodeProcess.argv[2])

/**
 * Capture the parent at load, then compare it with the default process object's live `ppid` getter.
 * A namespace import copies `ppid` at load and cannot detect a dead test runner in the blocked loop.
 */
const parent = NodeProcess.ppid

/**
 * The handler-entry receipt: one synchronous write on the launcher's extra pipe, made by the RPC
 * handler itself. A process that never reached its handler closes the pipe without data.
 */
const enter = (): void => {
  NodeFS.writeSync(RECEIPT_FD, 'entered')
}

/**
 * Block JavaScript after the receipt, so the parent's interrupt message can never be handled and
 * only a kill ends the process. `process.ppid` is read from the kernel on every access; when the
 * test runner dies the process is re-parented, the loop ends and the process exits, so a dead
 * runner leaves no orphan. This depends on the default process object retaining live getters such
 * as `ppid`, not the namespace import's snapshot.
 */
const spin = (): ReadonlyArray<string> => {
  enter()
  while (NodeProcess.ppid === parent) {
    // Deliberately empty: the loop must never yield to the event loop.
  }
  return NodeProcess.exit(1)
}

/**
 * Retained ordinary objects exhaust V8's old generation, which is what `--max-old-space-size` caps;
 * typed-array backing stores would not. The receipt comes first, so the heap death is known to
 * follow handler entry and not a loader failure.
 */
const grow = (): ReadonlyArray<string> => {
  enter()
  const retained: Array<ReadonlyArray<{ value: number }>> = []
  for (;;) retained.push(Array.from({ length: 10_000 }, (_, value) => ({ value })))
}

/** The same signal as a heap death, without Node's OOM handler and so without its report. */
const abort = (): ReadonlyArray<string> => {
  enter()
  return NodeProcess.abort()
}

/** An ordinary exit from inside a real RPC handler. */
const exit = (): ReadonlyArray<string> => {
  enter()
  return NodeProcess.exit(1)
}

/**
 * An idle fixture (`defect`, `faulted`, or any case before its request) is kept alive by `runMain`.
 * It leaves when the IPC channel closes, so a test runner that died leaves no orphan.
 */
NodeProcess.once('disconnect', () => NodeProcess.exit(0))

/** Exit before the handshake: the SDK never receives a ready message from this process. */
if (Fixture.guards.absent(input)) NodeProcess.exit(1)

/** All fixtures use the production RPC contract and the official runner, including handler death. */
const handlers = ExtractionRpcs.toLayer({
  ExtractPdf: () =>
    Fixture.match<Effect.Effect<ReadonlyArray<string>, ExtractionFaulted>>(input, {
      spin: () => Effect.sync(spin),
      grow: () => Effect.sync(grow),
      abort: () => Effect.sync(abort),
      exit: () => Effect.sync(exit),
      defect: () =>
        Effect.sync(() => {
          throw new Error('Extraction fixture defect')
        }),
      faulted: () => Effect.fail(new ExtractionFaulted()),
      absent: () => Effect.sync(exit),
    }),
})
const server = RpcServer.layer(ExtractionRpcs).pipe(
  Layer.provide(handlers),
  Layer.provide(RpcServer.layerProtocolWorkerRunner),
  Layer.provide(NodeWorkerRunner.layer),
)

/**
 * The fixture is a real process with a real runtime and the official child-process worker runner
 * (NodeWorkerRunner.ts:35-45); the tests own every process they launch and never signal one.
 */
NodeRuntime.runMain(Layer.launch(server))
