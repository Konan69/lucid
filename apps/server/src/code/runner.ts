import * as NodeWorkerThreads from 'node:worker_threads'
import { CodeFailure } from '@vivid/contracts'
import { Cause, Context, Effect, Layer, Queue, type Scope } from 'effect'
import { budgets, bytes } from './budgets.ts'
import {
  decodeWorker,
  encodeParent,
  type ParentMessage,
  PipeFailure,
  type WorkerMessage,
} from './protocol.ts'

/** One program's thread, as its supervisor uses it. */
export interface Runner {
  /** The next message from the program's thread. Fails `closed` once the thread has ended. */
  readonly read: Effect.Effect<WorkerMessage, PipeFailure>
  /** Hands the thread one message: the program to run, an answer to a call, or the order to stop. */
  readonly send: (message: ParentMessage) => Effect.Effect<void, PipeFailure>
  /** Ends a thread the server has given up on, and says why the program has no result. */
  readonly stopped: Effect.Effect<CodeFailure>
}

/**
 * Starts the thread one program is interpreted on (`worker.ts`), and ends it with the scope.
 *
 * The thread exists for two things the interpreter cannot do for itself. Its heap is capped
 * (`heap`, in MiB), so a program cannot take the server's memory by building ever more data.
 * The cap covers the JavaScript heap only; what one built-in may write in a single step is
 * bounded where the built-in is called (`interpreter/work.ts`). And it can be ended from outside, so a program that is inside one long built-in (a regular
 * expression that takes minutes on some input) does not hold the server's own thread, and stops
 * at the deadline like any other. Messages are JSON text in both directions: a call's arguments
 * and its answer are JSON anyway, and text is what the size limits are counted in.
 *
 * `tsx` is imported in the thread because the server runs from TypeScript source; a thread does
 * not inherit the loader the main program was started with.
 */
const openRunner = Effect.fn('Code.openRunner')(function* (heap: number) {
  const messages = yield* Queue.unbounded<string, PipeFailure>()
  const ended = { memory: false, exited: false }
  /**
   * Ends the thread and waits until it is over. The wait is on the thread's own `exit`, which
   * comes once whether it ended by itself, ran out of memory or was ended here; a thread already
   * over is not waited for.
   */
  const over = (started: NodeWorkerThreads.Worker) =>
    Effect.callback<void>((resume) => {
      if (ended.exited) return resume(Effect.void)
      started.once('exit', () => resume(Effect.void))
      void started.terminate()
    })
  const thread = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const started = new NodeWorkerThreads.Worker(new URL('./worker.ts', import.meta.url), {
        execArgv: ['--import', 'tsx'],
        resourceLimits: { maxOldGenerationSizeMb: heap },
      })
      started.on('message', (text: string) => {
        // The thread measures what it sends, so a longer message is a fault in it. It is not
        // kept: the program ends on its size, and nothing that large waits in the queue.
        if (text.length > budgets.wire)
          Queue.failCauseUnsafe(messages, Cause.fail(new PipeFailure({ reason: 'size' })))
        else Queue.offerUnsafe(messages, text)
      })
      started.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ERR_WORKER_OUT_OF_MEMORY') ended.memory = true
      })
      // After the last message it sent: what was queued before the end is still read.
      started.on('exit', () => {
        ended.exited = true
        Queue.failCauseUnsafe(messages, Cause.fail(new PipeFailure({ reason: 'closed' })))
      })
      return started
    }),
    // Ending the thread is the only cleanup there is: a program has nothing outside it.
    (started) => over(started),
  )
  const runner: Runner = {
    read: Effect.gen(function* () {
      const text = yield* Queue.take(messages)
      if (bytes(text) > budgets.wire) return yield* new PipeFailure({ reason: 'size' })
      return yield* decodeWorker(text).pipe(
        Effect.mapError(() => new PipeFailure({ reason: 'invalid' })),
      )
    }),
    send: (message) =>
      encodeParent(message).pipe(
        Effect.mapError(() => new PipeFailure({ reason: 'invalid' })),
        Effect.map((text) => {
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- A worker thread's port has no target origin; that argument is a window's.
          thread.postMessage(text)
        }),
      ),
    stopped: over(thread).pipe(
      Effect.map(() =>
        ended.memory
          ? CodeFailure.cases.OverLimit.make({ limit: 'memory' })
          : CodeFailure.cases.Unavailable.make({}),
      ),
    ),
  }
  return runner
})

export interface CodeRunnerService {
  /** A thread for one program. It is ended when the scope closes. */
  readonly open: Effect.Effect<Runner, never, Scope.Scope>
}

/**
 * Where a program's thread comes from. It is a service so that the supervisor's handling of a
 * thread that is lost, or that says something it should not, can be shown with a scripted one:
 * a real thread cannot be made to die at a chosen moment.
 */
export class CodeRunner extends Context.Service<CodeRunner, CodeRunnerService>()(
  'vivid/CodeRunner',
) {}

export const codeRunnerLayer = Layer.succeed(
  CodeRunner,
  CodeRunner.of({ open: openRunner(budgets.heap) }),
)
