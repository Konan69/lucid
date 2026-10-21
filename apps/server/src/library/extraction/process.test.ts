import * as Layer from 'effect/Layer'
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeProcess from 'node:process'
import * as NodeStream from 'node:stream'
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import { expect } from 'vitest'
import { layer as testLayer } from '@effect/vitest'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import * as RpcClient from 'effect/rpc/RpcClient'
import * as Worker from 'effect/workers/Worker'
import { WorkerError, WorkerReceiveError } from 'effect/workers/WorkerError'
import { EXTRACTION_HEAP_MB } from '../extraction.ts'
import { CRASH_TIMEOUT_MS, NativeMode, RECEIPT_FD } from '../fixtures/process/mode.ts'
import { ExtractionRpcs } from './contract.ts'
import {
  ProcessEnd,
  type Running,
  forkExtractor,
  heapEvidence,
  layer,
  processOptions,
  start,
  stop,
} from './process.ts'

/** Fixture budget only: the heap proof needs a real OOM, not the 512 MB production policy. */
const FIXTURE_HEAP_MB = 64

/** What one test may look at while its process is owned: the adapter's record and two receipts. */
interface Held {
  readonly running: Running
  readonly reportDir: string
  readonly entered: Deferred.Deferred<boolean>
}

/**
 * Fork the native fixture through the production options plus one receipt pipe. The receipt
 * listeners are added in the same synchronous step as `fork`, so neither data nor close is missed.
 * `entered` is true when the fixture's own code wrote to the pipe, false when the pipe closed
 * without data (the process died in the loader). The test never signals a process.
 */
const launch = (mode: typeof NativeMode.Type, reportDir: string) => {
  const entered = Deferred.makeUnsafe<boolean>()
  const settle = (value: boolean) => () => {
    Deferred.doneUnsafe(entered, Effect.succeed(value))
  }
  const spawn = () => {
    const options = processOptions({ heapMb: FIXTURE_HEAP_MB, reportDir })
    const child = NodeChildProcess.fork(
      new URL('../fixtures/process/native.ts', import.meta.url),
      [mode],
      { ...options, stdio: [...options.stdio, 'pipe'] },
    )
    const receipt = child.stdio[RECEIPT_FD]
    if (receipt instanceof NodeStream.Readable) {
      receipt.once('data', settle(true))
      receipt.once('close', settle(false))
      receipt.once('error', settle(false))
    } else {
      settle(false)()
    }
    return child
  }
  return { spawn, entered }
}

/**
 * The lifecycle the production caller will use: report directory first, then the process, so the
 * directory is removed last. Three observations are taken at fixed points and returned:
 * - `end`: the exit receipt, read without waiting, straight after `stop` returned. `None` here
 *   means `stop` came back before the process ended.
 * - `kept`: the report directory still exists after the process ended.
 * - `removed`: the report directory is gone once the scope closed.
 */
const inScope = <A>(
  mode: typeof NativeMode.Type,
  use: (held: Held) => Effect.Effect<A, never, FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const reportDir = yield* fs.makeTempDirectoryScoped({ prefix: 'vivid-extraction-' })
    const fixture = launch(mode, reportDir)
    const held = yield* Effect.acquireUseRelease(
      start(fixture.spawn),
      (running) =>
        use({ running, reportDir, entered: fixture.entered }).pipe(
          Effect.map((used) => ({ running, used })),
        ),
      (running) => stop(running),
    )
    const end = (yield* Deferred.isDone(held.running.ended))
      ? Option.some(yield* Deferred.await(held.running.ended))
      : Option.none()
    return {
      used: held.used,
      end,
      reportDir,
      pid: held.running.pid,
      kept: yield* fs.exists(reportDir),
    }
  })

/** Close the scope, then look at the directory once more from outside it. */
const owned = <A>(
  mode: typeof NativeMode.Type,
  use: (held: Held) => Effect.Effect<A, never, FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const inside = yield* Effect.scoped(inScope(mode, use))
    return { ...inside, removed: !(yield* fs.exists(inside.reportDir)) }
  })

/**
 * For a fixture that ends by itself: wait for its own end, then ask for heap evidence twice, once
 * for its pid and once for this test process's pid, which no child report can name.
 */
const settled = ({ running, reportDir, entered }: Held) =>
  Effect.gen(function* () {
    const began = yield* Deferred.await(entered)
    yield* Deferred.await(running.ended)
    return {
      began,
      heap: yield* heapEvidence(reportDir, running.pid),
      foreign: yield* heapEvidence(reportDir, NodeProcess.pid),
    }
  })

// FileSystem is stateless; each case owns its process and report-directory scope.
testLayer(NodeFileSystem.layer)((it) => {
  /** P0a: a real V8 heap OOM under the cap writes a report that names the process that died. */

  it.effect(
    'finds heap evidence in the report of a process that exhausted its heap',
    () =>
      Effect.gen(function* () {
        const seen = yield* owned('grow', settled)
        expect(seen.used).toEqual({ began: true, heap: true, foreign: false })
        expect(seen.end).toEqual(Option.some(ProcessEnd.cases.Signaled.make({ signal: 'SIGABRT' })))
        expect(seen.pid).not.toBe(NodeProcess.pid)
        expect([seen.kept, seen.removed]).toEqual([true, true])

        // The OOM ended only the child: this process starts and observes the next one normally.
        const next = yield* owned('exit', settled)
        expect(next.used).toEqual({ began: true, heap: false, foreign: false })
        expect(next.end).toEqual(Option.some(ProcessEnd.cases.Exited.make({ code: 1 })))
      }),
    CRASH_TIMEOUT_MS,
  )

  /** P0b: the same signal without Node's OOM handler is not heap evidence. */

  it.effect(
    'finds no heap evidence when a process aborts without exhausting its heap',
    () =>
      Effect.gen(function* () {
        const seen = yield* owned('abort', settled)
        expect(seen.used).toEqual({ began: true, heap: false, foreign: false })
        expect(seen.end).toEqual(Option.some(ProcessEnd.cases.Signaled.make({ signal: 'SIGABRT' })))
        expect([seen.kept, seen.removed]).toEqual([true, true])
      }),
    CRASH_TIMEOUT_MS,
  )

  /** P0b: an ordinary exit is reported by code and is not heap evidence. */

  it.effect('finds no heap evidence when a process exits', () =>
    Effect.gen(function* () {
      const seen = yield* owned('exit', settled)
      expect(seen.used).toEqual({ began: true, heap: false, foreign: false })
      expect(seen.end).toEqual(Option.some(ProcessEnd.cases.Exited.make({ code: 1 })))
      expect([seen.kept, seen.removed]).toEqual([true, true])
    }),
  )

  /**
   * A process that would never end by itself is ended by `stop`, and `stop` returns only with the
   * exit receipt: `end` is read without waiting. The report directory outlives the process.
   */

  it.effect('stops a running process and returns only after its exit', () =>
    Effect.gen(function* () {
      const seen = yield* owned('idle', ({ entered }) => Deferred.await(entered))
      expect(seen.used).toBe(true)
      expect(seen.end).toEqual(Option.some(ProcessEnd.cases.Signaled.make({ signal: 'SIGKILL' })))
      expect([seen.kept, seen.removed]).toEqual([true, true])
    }),
  )

  /**
   * One run of the SDK's worker on the owned platform, with a handler that is never reached. `run`
   * never succeeds (Worker.ts:48-56); its typed failure is the observation.
   */
  const runOnce = (running: Running) =>
    Effect.gen(function* () {
      const context = yield* Layer.build(layer(running))
      const workers = yield* Worker.WorkerPlatform.pipe(Effect.provide(context))
      const run = Effect.flatMap(workers.spawn(0), (worker) => worker.run(() => Effect.void))
      return yield* Effect.flip(run).pipe(Effect.provide(context))
    }).pipe(Effect.scoped)

  /**
   * The process is already gone when the SDK first attaches. Both runs are made after the native end
   * was observed, the second standing for the SDK's retry of a failed run (RpcClient.ts:1337).
   */
  const attachedLate = ({ running, entered }: Held) =>
    Effect.gen(function* () {
      const began = yield* Deferred.await(entered)
      yield* Deferred.await(running.ended)
      return { began, first: yield* runOnce(running), retry: yield* runOnce(running) }
    })

  /**
   * Death before the SDK attaches. The official platform would register its `exit` listener too late
   * and never fail this run (NodeWorker.ts:93-102). Here each run fails with the SDK's typed
   * `WorkerError`, at once and without a new process: nothing is thrown, the `TestClock` is never
   * moved, and a red run shows as a hang, not as a wrong answer.
   */

  it.effect(
    'fails every SDK run with a typed error when the process ended before it attached',
    () =>
      Effect.gen(function* () {
        const seen = yield* owned('exit', attachedLate)
        expect(seen.used.began).toBe(true)
        expect(seen.end).toEqual(Option.some(ProcessEnd.cases.Exited.make({ code: 1 })))
        for (const failure of [seen.used.first, seen.used.retry]) {
          expect(failure).toBeInstanceOf(WorkerError)
          expect(failure.reason).toBeInstanceOf(WorkerReceiveError)
          expect(failure.message).toBe('Extraction process ended')
        }
      }),
  )

  /**
   * Fork the production entry and record its first native message with the test's own listener,
   * added in the same synchronous step as `fork`. `None` means the process ended without sending one.
   */
  const readied = (reportDir: string) => {
    const first = Deferred.makeUnsafe<Option.Option<NodeChildProcess.Serializable>>()
    const spawn = () => {
      const child = forkExtractor(EXTRACTION_HEAP_MB)(reportDir)
      child.once('message', (message) => {
        Deferred.doneUnsafe(first, Effect.succeedSome(message))
      })
      child.once('exit', () => {
        Deferred.doneUnsafe(first, Effect.succeedNone)
      })
      return child
    }
    return { spawn, first }
  }

  /**
   * Attach the official worker RPC only after the ready message `[0]` (NodeWorkerRunner.ts:120) has
   * already been emitted natively, then extract a real PDF. A lost ready message would leave the
   * request in the SDK buffer for ever (Worker.ts:234-241).
   */
  const askedLate = (
    running: Running,
    first: Deferred.Deferred<Option.Option<NodeChildProcess.Serializable>>,
  ) =>
    Effect.gen(function* () {
      const ready = yield* Deferred.await(first)
      const protocol = yield* RpcClient.makeProtocolWorker({ size: 1 }).pipe(
        Effect.provide(yield* Layer.build(layer(running))),
      )
      const client = yield* RpcClient.make(ExtractionRpcs).pipe(
        Effect.provideService(RpcClient.Protocol, protocol),
      )
      const bytes = NodeFS.readFileSync(new URL('../fixtures/readable.pdf', import.meta.url))
      return { ready, pages: yield* client.ExtractPdf({ bytes: new Uint8Array(bytes) }) }
    })

  /**
   * Readiness before the SDK attaches, through the production entry, the official runner and the
   * official RPC. The inbox held the early `[0]` and handed it over at attach, so the call is answered.
   * The `TestClock` is never moved; a red run shows as a hang.
   */

  it.effect(
    'answers over the official RPC when the process was ready before the SDK attached',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const reportDir = yield* fs.makeTempDirectoryScoped({ prefix: 'vivid-extraction-' })
        const early = readied(reportDir)
        const asked = yield* Effect.acquireUseRelease(
          start(early.spawn),
          (running) => askedLate(running, early.first),
          (running) => stop(running),
        )
        expect(asked.ready).toEqual(Option.some([0]))
        expect(asked.pages).toEqual(['Vivid extraction fixture'])
      }),
  )
})
