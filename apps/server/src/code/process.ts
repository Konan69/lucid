import * as NodeChildProcess from 'node:child_process'
import * as NodeProcess from 'node:process'
import * as NodeURL from 'node:url'
import * as NodePath from 'node:path'
import {
  CodeCall,
  CodeOutcome,
  CodeFailure,
  type RunCodeRequest,
  type ThreadId,
  ApprovalId,
} from '@vivid/contracts'
import {
  Config,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Schema,
  Semaphore,
} from 'effect'
import { budgets, bytes } from './budgets.ts'
import { prepareWorker } from './source.ts'
import { checkProgramHost } from './host.ts'
import { FrameReader, writeFrame } from './pipe.ts'
import {
  decodeWorker,
  encodeParent,
  ParentMessage,
  PipeFailure,
  WorkerMessage,
} from './protocol.ts'

/** A completed callback has a receipt; decisions stop admission before anything returns to the VM. */
export const CallOutcome = Schema.TaggedUnion({
  Returned: {
    value: Schema.Json,
    end: Schema.Literals(['completed', 'refused']),
    summary: Schema.String,
  },
  ApprovalRequired: { approvalId: ApprovalId, summary: Schema.String },
  Blocked: { rule: Schema.String, summary: Schema.String },
  Unknown: { summary: Schema.String },
})
export type CallOutcome = typeof CallOutcome.Type
export type Dispatch = (call: typeof WorkerMessage.cases.Call.Type) => Effect.Effect<CallOutcome>

/** Provider JSON may itself look like a CodeOutcome; it must never be mistaken for a host decision. */
const CallStep = Schema.TaggedUnion({
  Continue: { value: Schema.Json },
  Stop: { outcome: CodeOutcome },
})
type CallStep = typeof CallStep.Type

export interface CodeProcessService {
  readonly run: (
    input: { readonly request: RunCodeRequest; readonly boundary: ThreadId },
    dispatch: Dispatch,
  ) => Effect.Effect<CodeOutcome>
}

/** A supervised interpreter is an authority seam, not a reusable guest session. */
export class CodeProcess extends Context.Service<CodeProcess, CodeProcessService>()(
  'vivid/CodeProcess',
) {}

/** Mount only executable dependencies, contracts and this adapter, never the repository or live state. */
function command(runtimeDirectory: string, unit: string, source: string) {
  const root = NodeURL.fileURLToPath(new URL('../../../../', import.meta.url))
  const server = NodePath.join(root, 'apps/server')
  const mounts = [
    '/usr',
    '/lib',
    '/lib64',
    NodePath.join(root, 'node_modules'),
    NodePath.join(server, 'node_modules'),
    NodePath.join(server, 'package.json'),
  ]
  const args = [
    '--user',
    '--pipe',
    '--wait',
    '--quiet',
    `--unit=${unit}`,
    '-p',
    `MemoryMax=${budgets.child}`,
    '-p',
    'MemorySwapMax=0',
    '-p',
    'TasksMax=32',
    '-p',
    'CPUQuota=100%',
    '-p',
    // Isolation must outlive the parent deadline so it can collect the worker's final receipt.
    `RuntimeMaxSec=${budgets.seconds + 5}`,
    '-p',
    'KillMode=control-group',
    '-p',
    'KillSignal=SIGKILL',
    '/usr/bin/bwrap',
    '--unshare-all',
    '--die-with-parent',
    '--new-session',
    '--clearenv',
    '--setenv',
    'PATH',
    '/usr/bin:/bin',
    '--setenv',
    'NODE_NO_WARNINGS',
    '1',
  ]
  for (const path of mounts) args.push('--ro-bind', path, path)
  args.push(
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--ro-bind',
    source,
    source,
    '--chdir',
    '/tmp',
    '/usr/bin/prlimit',
    `--cpu=${budgets.seconds + 5}`,
    '--',
    NodeProcess.execPath,
    // Node 24 defaults to 128 parallel WASM compilation tasks; this cgroup has one CPU.
    // Keep compilation serial so background optimizer work cannot starve VM/pipe callbacks.
    '--wasm-num-compilation-tasks=1',
    NodePath.join(source, 'start.mjs'),
  )
  return { args, env: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: runtimeDirectory } }
}

/** Stop precisely the transient unit we created. Its whole cgroup dies, including WASM workers. */
const stop = Effect.fn('Code.stopProcess')((unit: string, env: NodeJS.ProcessEnv) =>
  Effect.callback<void>((resume) => {
    const stopping = NodeChildProcess.spawn('/usr/bin/systemctl', ['--user', 'stop', unit], {
      env,
      stdio: 'ignore',
    })
    stopping.on('error', () => resume(Effect.void))
    stopping.on('close', () => resume(Effect.void))
  }),
)

/** Failed units retain their resource result until we read it; cleanup then releases that record. */
const reset = Effect.fn('Code.resetProcess')((unit: string, env: NodeJS.ProcessEnv) =>
  Effect.callback<void>((resume) => {
    const resetting = NodeChildProcess.spawn(
      '/usr/bin/systemctl',
      ['--user', 'reset-failed', unit],
      { env, stdio: 'ignore' },
    )
    resetting.on('error', () => resume(Effect.void))
    resetting.on('close', () => resume(Effect.void))
  }),
)

/** An OOM is distinguishable from installation/protocol failure; raw journal/driver text is never exposed. */
const resourceFailure = Effect.fn('Code.resourceFailure')((unit: string, env: NodeJS.ProcessEnv) =>
  Effect.callback<CodeFailure>((resume) => {
    const inspect = NodeChildProcess.spawn(
      '/usr/bin/systemctl',
      ['--user', 'show', unit, '--property=Result', '--value'],
      { env, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    let result = ''
    inspect.stdout.on('data', (chunk: Buffer) => {
      result = (result + chunk.toString('utf8')).slice(0, 100)
    })
    inspect.on('error', () => resume(Effect.succeed(CodeFailure.cases.Unavailable.make({}))))
    inspect.on('close', () => {
      if (result.trim() === 'oom-kill')
        return resume(Effect.succeed(CodeFailure.cases.OverLimit.make({ limit: 'memory' })))
      if (result.trim() === 'timeout')
        return resume(Effect.succeed(CodeFailure.cases.TimedOut.make({ seconds: budgets.seconds })))
      resume(Effect.succeed(CodeFailure.cases.Unavailable.make({})))
    })
  }),
)

/** Cancellation owns this captured process and unit; it never searches for someone else's PID. */
const launch = Effect.fn('Code.launchProcess')(function* (
  runtimeDirectory: string,
  source: string,
) {
  const unit = `vivid-code-${crypto.randomUUID()}`
  const options = command(runtimeDirectory, unit, source)
  const child = yield* Effect.acquireRelease(
    Effect.callback<
      NodeChildProcess.ChildProcessByStdio<
        import('node:stream').Writable,
        import('node:stream').Readable,
        null
      >,
      PipeFailure
    >((resume) => {
      const spawned = NodeChildProcess.spawn('/usr/bin/systemd-run', options.args, {
        env: options.env,
        stdio: ['pipe', 'pipe', 'ignore'],
      })
      spawned.on('error', () => resume(Effect.fail(new PipeFailure({ reason: 'closed' }))))
      spawned.once('spawn', () => resume(Effect.succeed(spawned)))
    }),
    (spawned) =>
      Effect.gen(function* () {
        spawned.stdin.destroy()
        yield* stop(unit, options.env)
        yield* reset(unit, options.env)
        spawned.kill('SIGTERM')
      }),
  )
  return { child, unit, env: options.env }
})

/** Parent state is never supplied by the worker. Pending consequential calls are uncertain on loss. */
class Execution {
  readonly calls: CodeCall[] = []
  private terminal: Option.Option<CodeOutcome> = Option.none()
  /** Rebuilds the decision's snapshot once the calls that were already running have reported. */
  private decision: Option.Option<() => CodeOutcome> = Option.none()
  /** Calls dispatched and not yet returned. A decision waits for these; it never interrupts them. */
  private flying = 0
  private data = 0
  private next = 1
  private reserved = 0
  private ending: Option.Option<
    typeof WorkerMessage.cases.Done.Type | typeof WorkerMessage.cases.Failed.Type
  > = Option.none()

  /** Guest completion and a policy decision independently close admission; a late decision wins. */
  get accepting() {
    return Option.isNone(this.terminal) && Option.isNone(this.ending)
  }

  /** Close before waiting for an in-flight receipt; queued work never reaches an authority service. */
  end(message: typeof WorkerMessage.cases.Done.Type | typeof WorkerMessage.cases.Failed.Type) {
    this.ending = Option.some(message)
  }

  /** A deadline is a permanent host latch set before child fibers are interrupted. */
  terminate(failure: CodeFailure) {
    const outcome = this.failed(failure)
    this.terminal = Option.some(outcome)
    return outcome
  }

  /** Failure cannot replace a latched decision. Copy receipts so late callbacks cannot rewrite its snapshot. */
  failed(failure: CodeFailure): CodeOutcome {
    if (Option.isSome(this.terminal)) return this.terminal.value
    if (this.calls.some((call) => call.end === 'unknown'))
      return CodeOutcome.cases.OutcomeUnknown.make({ calls: this.calls.slice() })
    return CodeOutcome.cases.Failed.make({ failure, calls: this.calls.slice() })
  }

  /** Reserve bounded queue space before forking; arguments count even if completion cancels the call. */
  reserve(call: typeof WorkerMessage.cases.Call.Type): Option.Option<CodeOutcome> {
    if (Option.isSome(this.terminal)) return this.terminal
    if (call.id !== this.next++)
      return Option.some(this.terminate(CodeFailure.cases.Unavailable.make({})))
    if (++this.reserved > budgets.calls)
      return Option.some(this.terminate(CodeFailure.cases.OverLimit.make({ limit: 'calls' })))
    const size = bytes(JSON.stringify(call.input))
    if (size > budgets.frame)
      return Option.some(this.terminate(CodeFailure.cases.OverLimit.make({ limit: 'data' })))
    this.data += size
    if (this.data > budgets.data)
      return Option.some(this.terminate(CodeFailure.cases.OverLimit.make({ limit: 'data' })))
    return Option.none()
  }

  /** A policy decision is waiting for the calls that were already running. */
  get decided() {
    return Option.isSome(this.decision)
  }

  /**
   * The decision with every receipt as it finally stands. A call that was running beside the one
   * that asked has its real outcome here, not the provisional `unknown` it had when the decision
   * was taken.
   */
  settled(): Option.Option<CodeOutcome> {
    return Option.map(this.decision, (make) => {
      const outcome = make()
      this.terminal = Option.some(outcome)
      return outcome
    })
  }

  /**
   * Only dispatched calls receive effect receipts. Calls from one program run at the same time, as
   * in pi code mode (`@earendil-works/pi-codemode` 1.0.0 `runtime/host.js`, `handleCall`: each call
   * is started when its message arrives and tracked by id, with no queue). Admission is checked
   * immediately before dispatch.
   */
  readonly call = Effect.fn('Code.dispatchFrame')(function* (
    this: Execution,
    call: typeof WorkerMessage.cases.Call.Type,
    dispatch: Dispatch,
    stopped: Deferred.Deferred<CodeOutcome, PipeFailure>,
  ) {
    const index = this.calls.length
    this.calls.push(
      CodeCall.make({
        kind: call.kind,
        summary: 'Checking the request',
        end: call.kind === 'find_tools' || call.kind === 'read_page' ? 'refused' : 'unknown',
      }),
    )
    this.flying++
    const landing = { step: Option.none<CallStep>() }
    // The finalizer runs however the dispatch ends, and without a yield inside it: the receipt, any
    // decision and the in-flight count change together, so a sibling can never snapshot this call
    // as unknown after it has really finished. An interrupted dispatch keeps its provisional
    // receipt and still counts as landed, so a waiting decision is never left unreported.
    yield* dispatch(call).pipe(
      Effect.onExit((exit) =>
        Effect.suspend(() => {
          if (Exit.isSuccess(exit)) landing.step = Option.some(this.land(index, call, exit.value))
          this.flying--
          if (this.flying > 0) return Effect.void
          return Option.match(this.settled(), {
            onNone: () => Effect.void,
            onSome: (outcome) => Deferred.succeed(stopped, outcome).pipe(Effect.asVoid),
          })
        }),
      ),
    )
    return landing.step
  })

  /** Records what one finished call did. Synchronous: it is one step of the landing transition. */
  private land(
    index: number,
    call: typeof WorkerMessage.cases.Call.Type,
    result: CallOutcome,
  ): CallStep {
    const summary = result.summary.slice(0, 200)
    return CallOutcome.match<CallStep>(result, {
      Returned: ({ value, end }) => {
        this.calls[index] = CodeCall.make({ kind: call.kind, summary, end })
        const size = bytes(JSON.stringify(value))
        this.data += size
        if (size > budgets.frame || this.data > budgets.data)
          return CallStep.cases.Stop.make({
            outcome: this.terminate(CodeFailure.cases.OverLimit.make({ limit: 'data' })),
          })
        return CallStep.cases.Continue.make({ value })
      },
      ApprovalRequired: ({ approvalId }) =>
        this.latch(
          () =>
            CodeOutcome.cases.ApprovalRequired.make({
              approvalId,
              summary,
              calls: this.calls.slice(),
            }),
          index,
          CodeCall.make({ kind: call.kind, summary, end: 'needs approval' }),
        ),
      Blocked: ({ rule }) =>
        this.latch(
          () => CodeOutcome.cases.Blocked.make({ rule, calls: this.calls.slice() }),
          index,
          CodeCall.make({ kind: call.kind, summary, end: 'refused' }),
        ),
      Unknown: () =>
        this.latch(
          () => CodeOutcome.cases.OutcomeUnknown.make({ calls: this.calls.slice() }),
          index,
          CodeCall.make({ kind: call.kind, summary, end: 'unknown' }),
        ),
    })
  }

  /** This synchronous transition precedes pipe replies and prevents catch/finally from admitting work. */
  private latch(make: () => CodeOutcome, index: number, receipt: CodeCall) {
    this.calls[index] = receipt
    // The first decision is the one reported; a sibling that also asks keeps its own receipt. A
    // deadline or a limit that already ended the program is not replaced by a later decision.
    if (Option.isNone(this.decision) && Option.isNone(this.terminal))
      this.decision = Option.some(make)
    const outcome = Option.getOrElse(this.terminal, make)
    this.terminal = Option.some(outcome)
    return CallStep.cases.Stop.make({ outcome })
  }

  /** Even a small guest value must fit the final aggregate with all partial-effect receipts. */
  completed(result: Schema.Json): CodeOutcome {
    if (Option.isSome(this.terminal)) return this.terminal.value
    const outcome = CodeOutcome.cases.Completed.make({
      result,
      calls: this.calls.slice(),
      truncated: false,
    })
    return bytes(JSON.stringify(outcome)) > budgets.result
      ? this.failed(CodeFailure.cases.OverLimit.make({ limit: 'result' }))
      : outcome
  }
}

/** The reader continues during an action, so a Done frame closes queued admission immediately. */
const readCalls = Effect.fn('Code.readCalls')(function* (
  child: Pick<NodeChildProcess.ChildProcessWithoutNullStreams, 'stdin' | 'stdout'>,
  execution: {
    readonly state: Execution
    readonly dispatch: Dispatch
    readonly stopped: Deferred.Deferred<CodeOutcome, PipeFailure>
  },
) {
  const reader = new FrameReader(child.stdout)
  // Calls overlap, so their replies can finish together; one writer keeps each frame whole.
  const writes = yield* Semaphore.make(1)
  const running: Fiber.Fiber<void, PipeFailure>[] = []
  const { state, stopped } = execution
  while (true) {
    const message = yield* reader.read().pipe(
      Effect.flatMap((text) => decodeWorker(text, { onExcessProperty: 'error' })),
      Effect.catchTag('SchemaError', () => Effect.fail(new PipeFailure({ reason: 'invalid' }))),
      Effect.tapError(() =>
        Effect.sync(() =>
          state.end(
            WorkerMessage.cases.Failed.make({ failure: CodeFailure.cases.Unavailable.make({}) }),
          ),
        ),
      ),
    )
    if (WorkerMessage.isAnyOf(['Done', 'Failed'])(message)) {
      state.end(message)
      yield* Effect.forEach(running, (fiber) => Fiber.join(fiber), { concurrency: 'unbounded' })
      const decided = state.settled()
      if (Option.isSome(decided)) return decided.value
      return WorkerMessage.guards.Done(message)
        ? state.completed(message.result)
        : state.failed(message.failure)
    }
    const refused = state.reserve(message)
    // After a decision nothing new is admitted, but returning here would interrupt the calls that
    // are still running. Wait for the decision instead; the last of them reports it.
    if (Option.isSome(refused))
      return state.decided ? yield* Deferred.await(stopped) : refused.value
    const call = runCall(child, message, { ...execution, writes }).pipe(
      Effect.catchTag('CodePipeFailure', (failure) =>
        Effect.gen(function* () {
          state.end(
            WorkerMessage.cases.Failed.make({ failure: CodeFailure.cases.Unavailable.make({}) }),
          )
          yield* Deferred.fail(stopped, failure)
        }),
      ),
    )
    running.push(yield* Effect.forkChild(call, { startImmediately: true }))
  }
})

/**
 * Admission precedes dispatch and live authority refresh; replies cease once the guest ends. When a
 * call brings a decision (an Approval, a block, an unknown outcome), the program stops being
 * answered at once, but calls already running are left to finish and the decision is reported only
 * when the last of them has returned. Interrupting them would turn a real result into "unknown".
 */
const runCall = Effect.fn('Code.runCall')(function* (
  child: Pick<NodeChildProcess.ChildProcessWithoutNullStreams, 'stdin' | 'stdout'>,
  message: typeof WorkerMessage.cases.Call.Type,
  execution: {
    readonly state: Execution
    readonly dispatch: Dispatch
    readonly stopped: Deferred.Deferred<CodeOutcome, PipeFailure>
    readonly writes: Semaphore.Semaphore
  },
) {
  const { state, dispatch, stopped, writes } = execution
  if (!state.accepting) return yield* Effect.void
  const landed = yield* state.call(message, dispatch, stopped)
  // A decision is reported by the landing of the last running call, not from here.
  if (state.decided || Option.isNone(landed)) return yield* Effect.void
  const step = landed.value
  if (CallStep.guards.Stop(step))
    return yield* Deferred.succeed(stopped, step.outcome).pipe(Effect.asVoid)
  // Admission is checked again inside the permit: a reply that waited behind another frame must
  // not reach the program after a decision has closed it.
  return yield* writes.withPermit(
    Effect.suspend(() =>
      state.accepting
        ? writeFrame(
            child.stdin,
            encodeParent(ParentMessage.cases.Reply.make({ id: message.id, value: step.value })),
            'request',
          )
        : Effect.void,
    ),
  )
})

/** Policy decisions race the reader independently, so queued frames can never hide an Approval. */
const exchange = Effect.fn('Code.exchange')(function* (
  child: Pick<NodeChildProcess.ChildProcessWithoutNullStreams, 'stdin' | 'stdout'>,
  state: Execution,
  dispatch: Dispatch,
) {
  const stopped = yield* Deferred.make<CodeOutcome, PipeFailure>()
  return yield* Effect.raceFirst(
    readCalls(child, { state, dispatch, stopped }),
    Deferred.await(stopped),
  )
})

/** The parent clock includes tools and process startup. No failure path replays a program. */
const execute = Effect.fn('Code.supervise')(function* (
  runtimeDirectory: string,
  source: string,
  request: RunCodeRequest,
  dispatch: Dispatch,
) {
  const state = new Execution()
  const failed = (failure: CodeFailure) => state.failed(failure)
  const program = Effect.scoped(
    Effect.gen(function* () {
      const launched = yield* launch(runtimeDirectory, source)
      yield* writeFrame(
        launched.child.stdin,
        encodeParent(ParentMessage.cases.Start.make({ code: request.code })),
        'request',
      )
      return yield* exchange(launched.child, state, dispatch).pipe(
        Effect.catchTag('CodePipeFailure', (failure) =>
          failure.reason === 'size'
            ? Effect.succeed(state.failed(CodeFailure.cases.OverLimit.make({ limit: 'data' })))
            : resourceFailure(launched.unit, launched.env).pipe(Effect.map(failed)),
        ),
      )
    }),
  ).pipe(
    Effect.catchCause((cause) =>
      Effect.logError('Program supervision failed', cause).pipe(
        Effect.as(state.failed(CodeFailure.cases.Unavailable.make({}))),
      ),
    ),
  )
  const deadline = Effect.sleep(`${budgets.seconds} seconds`).pipe(
    Effect.map(() =>
      state.terminate(CodeFailure.cases.TimedOut.make({ seconds: budgets.seconds })),
    ),
  )
  return yield* Effect.raceFirst(program, deadline)
})

/** Fail-fast capacity avoids running stale requests after another program has finished. */
export const codeProcessLayer = Layer.effect(
  CodeProcess,
  Effect.gen(function* () {
    const runtimeDirectory = yield* Config.option(Config.String('XDG_RUNTIME_DIR'))
    const source = yield* checkProgramHost(runtimeDirectory).pipe(
      Effect.andThen(prepareWorker()),
      Effect.map(Option.some),
      // The shared CodeFailure.Unavailable is the model-visible host capability refusal.
      // Contracts are unchanged; the precise tagged prerequisite error stays in startup diagnostics.
      Effect.catchTag('CodeIsolationUnavailable', (error) =>
        Effect.logError('Programs are unavailable on this host', error.reason, error).pipe(
          Effect.as(Option.none<string>()),
        ),
      ),
      Effect.catchTag('CodeAssetsUnavailable', (error) =>
        Effect.logError('Program worker assets could not be prepared', error).pipe(
          Effect.as(Option.none<string>()),
        ),
      ),
    )
    const capacity = yield* Semaphore.make(budgets.processes)
    const active = new Set<ThreadId>()
    return CodeProcess.of({
      run: Effect.fn('Code.run')(function* ({ request, boundary }, dispatch) {
        const unavailable = CodeOutcome.cases.Failed.make({
          failure: CodeFailure.cases.Unavailable.make({}),
          calls: [],
        })
        if (bytes(request.code) > budgets.source)
          return CodeOutcome.cases.Failed.make({
            failure: CodeFailure.cases.Threw.make({ message: 'Program source exceeds 16 KiB.' }),
            calls: [],
          })
        if (Option.isNone(runtimeDirectory) || Option.isNone(source) || active.has(boundary))
          return unavailable
        active.add(boundary)
        const admitted = yield* capacity
          .withPermitsIfAvailable(1)(
            execute(runtimeDirectory.value, source.value, request, dispatch),
          )
          .pipe(Effect.ensuring(Effect.sync(() => active.delete(boundary))))
        return Option.getOrElse(admitted, () => unavailable)
      }),
    })
  }),
)
