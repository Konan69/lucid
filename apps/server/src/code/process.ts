import {
  CodeCall,
  CodeCallKind,
  CodeOutcome,
  CodeFailure,
  CodeLogs,
  type RunCodeRequest,
  type ThreadId,
  ApprovalId,
} from '@vivid/contracts'
import {
  Cause,
  Predicate,
  Result,
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
import { CodeTiming } from '@vivid/contracts/code'
import { isCodeName } from '../observability/messages.ts'
import type { CodeBoundary } from './authority.ts'
import { boundedLogs, encodedPrefix } from './logs.ts'
import { budgets, bytes } from './budgets.ts'
import { openRunner, type Runner } from './runner.ts'
import { ParentMessage, PipeFailure, WorkerMessage } from './protocol.ts'

/** A completed call has a receipt; decisions stop admission before anything returns to the program. */
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
/**
 * One call a program made, as the check of it sees it: which of its tools, and the arguments as
 * JSON. It carries data only; the Person and the Thread it acts for are bound on the server and
 * never come from the program.
 */
export const ProgramCall = Schema.Struct({ kind: CodeCallKind, input: Schema.Json })
export interface ProgramCall extends Schema.Schema.Type<typeof ProgramCall> {}
export type Dispatch = (call: ProgramCall) => Effect.Effect<CallOutcome>

/** Provider JSON may itself look like a CodeOutcome; it must never be mistaken for a host decision. */
const CallStep = Schema.TaggedUnion({
  Continue: { value: Schema.Json },
  Stop: { outcome: CodeOutcome },
})
type CallStep = typeof CallStep.Type

export interface CodeProcessService {
  readonly run: (
    input: { readonly request: RunCodeRequest; readonly boundary: CodeBoundary },
    dispatch: Dispatch,
  ) => Effect.Effect<CodeOutcome>
}

/** A supervised program is an authority seam, not a reusable session. */
export class CodeProcess extends Context.Service<CodeProcess, CodeProcessService>()(
  'vivid/CodeProcess',
) {}

/** Failure keeps every admitted receipt and fits logs into the remaining final-result bytes. */
function boundedFailure(failure: CodeFailure, calls: readonly CodeCall[], printed: CodeLogs) {
  const base = CodeOutcome.cases.Failed.make({
    failure,
    calls: calls.slice(),
    logs: [],
    // false is one byte longer than true; reserve the longest possible encoding.
    logsTruncated: false,
  })
  const available = budgets.result - bytes(JSON.stringify(base)) + 2
  const logs = boundedLogs(printed.logs, Math.min(budgets.logs, available), printed.logsTruncated)
  return CodeOutcome.cases.Failed.make({
    failure,
    calls: calls.slice(),
    logs: logs.logs,
    logsTruncated: logs.logsTruncated,
  })
}

/**
 * Inspect only the first sixteen Effect-owned reasons. Fail tags must be own data properties and
 * code names (at most 120 characters); messages, inherited accessors and every Die payload stay
 * unread. Result.try contains a revoked Proxy's descriptor trap, like the observability guard.
 */
function supervisionTags<E>(cause: Cause.Cause<E>) {
  return cause.reasons
    .slice(0, 16)
    .flatMap((reason) => {
      if (!Cause.isFailReason(reason)) return []
      return Result.getOrElse(
        Result.try(() => {
          if (!Predicate.isObject(reason.error)) return []
          const descriptor = Object.getOwnPropertyDescriptor(reason.error, '_tag')
          if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) return []
          const tag: unknown = descriptor.value
          return Predicate.isString(tag) && isCodeName(tag) ? [tag] : []
        }),
        () => [],
      )
    })
    .join(',')
}

/**
 * What the server knows about one running program: the receipts of its calls, the data it has
 * moved, and any decision that ended it. None of it is supplied by the program's thread. A call
 * that changes something and was still running when the program was lost is uncertain.
 */
export class Execution {
  readonly calls: CodeCall[] = []
  readonly finished = Deferred.makeUnsafe<void>()
  // Until the program's final message arrives, what it printed may have been lost.
  private logs = CodeLogs.make({ logs: [], logsTruncated: true })
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

  /** The program's end and a policy decision independently close admission; a late decision wins. */
  get accepting() {
    return Option.isNone(this.terminal) && Option.isNone(this.ending)
  }

  /** Close before waiting for an in-flight receipt; queued work never reaches an authority service. */
  end(message: typeof WorkerMessage.cases.Done.Type | typeof WorkerMessage.cases.Failed.Type) {
    this.ending = Option.some(message)
    this.logs = boundedLogs(message.logs, budgets.logs, message.logsTruncated)
    // A deadline latches receipts before cancellation; only its printed-output channel may update.
    if (Option.isSome(this.terminal) && CodeOutcome.guards.Failed(this.terminal.value)) {
      const outcome = this.terminal.value
      this.terminal = Option.some(boundedFailure(outcome.failure, outcome.calls, this.logs))
    }
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
    return boundedFailure(failure, this.calls, this.logs)
  }

  /** Supervision owns recovery after the program's thread closes; receipts still determine uncertainty. */
  supervise<E, R>(program: Effect.Effect<CodeOutcome, E, R>) {
    return program.pipe(
      Effect.catchCause((cause) =>
        // Only reason kinds and bounded Fail tags are read. Never give a logger the foreign failure:
        // rc.116 Cause.pretty runs getters and recursively follows circular causes (guard.ts).
        Effect.annotateLogs(Effect.logError('Program supervision failed'), {
          'vivid.supervision.failures': supervisionTags(cause),
          'vivid.supervision.failed': Cause.hasFails(cause),
          'vivid.supervision.defected': Cause.hasDies(cause),
          'vivid.supervision.interrupted': Cause.hasInterrupts(cause),
        }).pipe(Effect.as(this.failed(CodeFailure.cases.Unavailable.make({})))),
      ),
    )
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
   * Only dispatched calls receive receipts. Calls a program starts together run together: the
   * interpreter starts each where the program wrote it, at most eight at once
   * (`interpreter/evaluate.ts`, `createToolCallPromise`), and each is dispatched here when its
   * message arrives. Admission is checked immediately before dispatch.
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
    // One hundred receipts must fit the final aggregate even for Unicode or escaped summaries.
    // Bound encoded bytes, not code units; metadata cannot consume the returned value's budget.
    const summary = encodedPrefix(result.summary, 200)
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

  /** This synchronous transition precedes any answer to the program, so its catch/finally cannot admit work. */
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

  /** The value and receipts take priority; only logs shrink to fit their remaining UTF-8 budget. */
  completed(result: Schema.Json): CodeOutcome {
    if (Option.isSome(this.terminal)) return this.terminal.value
    const base = CodeOutcome.cases.Completed.make({
      result,
      calls: this.calls.slice(),
      truncated: false,
      logs: [],
      logsTruncated: false,
    })
    const available = budgets.result - bytes(JSON.stringify(base)) + 2
    if (available < 2) return this.failed(CodeFailure.cases.OverLimit.make({ limit: 'result' }))
    const logs = boundedLogs(
      this.logs.logs,
      Math.min(budgets.logs, available),
      this.logs.logsTruncated,
    )
    return CodeOutcome.cases.Completed.make({
      result,
      calls: base.calls,
      truncated: false,
      logs: logs.logs,
      logsTruncated: logs.logsTruncated,
    })
  }

  /** Latch receipts before the order to stop and bound the wait for the final message; missing output stays marked. */
  readonly timeout = Effect.fn('Code.collectDeadlineLogs')(function* (
    this: Execution,
    cancelled: Effect.Effect<void, PipeFailure>,
  ) {
    const failure = CodeFailure.cases.TimedOut.make({ seconds: budgets.seconds })
    this.terminate(failure)
    yield* cancelled.pipe(
      Effect.andThen(Deferred.await(this.finished)),
      Effect.catchTag('CodePipeFailure', () => Effect.void),
      Effect.timeoutOrElse({ duration: CodeTiming.graceMs, orElse: () => Effect.void }),
    )
    return this.failed(failure)
  })
}

/** The reader continues during an action, so a final message closes queued admission immediately. */
const readCalls = Effect.fn('Code.readCalls')(function* (
  runner: Runner,
  execution: {
    readonly state: Execution
    readonly dispatch: Dispatch
    readonly stopped: Deferred.Deferred<CodeOutcome, PipeFailure>
  },
) {
  const running: Fiber.Fiber<void, PipeFailure>[] = []
  const { state, stopped } = execution
  while (true) {
    const message = yield* runner.read.pipe(
      Effect.tapError(() =>
        Effect.sync(() =>
          state.end(
            WorkerMessage.cases.Failed.make({
              failure: CodeFailure.cases.Unavailable.make({}),
              logs: [],
              logsTruncated: true,
            }),
          ),
        ),
      ),
    )
    if (WorkerMessage.isAnyOf(['Done', 'Failed'])(message)) {
      state.end(message)
      yield* Deferred.succeed(state.finished, undefined)
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
    const call = runCall(runner, message, execution).pipe(
      Effect.catchTag('CodePipeFailure', (failure) =>
        Effect.gen(function* () {
          state.end(
            WorkerMessage.cases.Failed.make({
              failure: CodeFailure.cases.Unavailable.make({}),
              logs: [],
              logsTruncated: true,
            }),
          )
          yield* Deferred.fail(stopped, failure)
        }),
      ),
    )
    running.push(yield* Effect.forkChild(call, { startImmediately: true }))
  }
})

/**
 * Admission precedes dispatch and live authority refresh; replies cease once the program ends. When a
 * call brings a decision (an Approval, a block, an unknown outcome), the program stops being
 * answered at once, but calls already running are left to finish and the decision is reported only
 * when the last of them has returned. Interrupting them would turn a real result into "unknown".
 */
const runCall = Effect.fn('Code.runCall')(function* (
  runner: Runner,
  message: typeof WorkerMessage.cases.Call.Type,
  execution: {
    readonly state: Execution
    readonly dispatch: Dispatch
    readonly stopped: Deferred.Deferred<CodeOutcome, PipeFailure>
  },
) {
  const { state, dispatch, stopped } = execution
  if (!state.accepting) return yield* Effect.void
  const landed = yield* state.call(message, dispatch, stopped)
  // A decision is reported by the landing of the last running call, not from here.
  if (state.decided || Option.isNone(landed)) return yield* Effect.void
  const step = landed.value
  if (CallStep.guards.Stop(step))
    return yield* Deferred.succeed(stopped, step.outcome).pipe(Effect.asVoid)
  // Admission is checked again at the moment of answering: a decision taken while this call was
  // landing has closed the program, and it must not hear an answer after that.
  return yield* Effect.suspend(() =>
    state.accepting
      ? runner.send(ParentMessage.cases.Reply.make({ id: message.id, value: step.value }))
      : Effect.void,
  )
})

/** Policy decisions race the reader independently, so queued messages can never hide an Approval. */
const exchange = Effect.fn('Code.exchange')(function* (
  runner: Runner,
  state: Execution,
  dispatch: Dispatch,
) {
  const stopped = yield* Deferred.make<CodeOutcome, PipeFailure>()
  return yield* Effect.raceFirst(
    readCalls(runner, { state, dispatch, stopped }),
    Deferred.await(stopped),
  )
})

/**
 * Runs one program on a thread of its own, in the interpreter ported from opencode
 * (`interpreter/`, started by `runner.ts`). The interpreter is what a program cannot get out of:
 * it has its tools and nothing else. The thread is what a program cannot use up: its memory is
 * capped and it can be ended from here, which a program on the server's own thread could not be
 * (9 October 2026: a regular expression held that thread past its deadline, and 21 small arrays
 * grew the heap by 254 MB in one call, both inside every limit the interpreter counts).
 *
 * The server's clock covers the thread starting and every tool call. No failure path replays a
 * program.
 */
const execute = Effect.fn('Code.supervise')(function* (
  input: { readonly request: RunCodeRequest; readonly boundary: CodeBoundary },
  dispatch: Dispatch,
) {
  const state = new Execution()
  const running = { runner: Option.none<Runner>() }
  const failed = (failure: CodeFailure) => state.failed(failure)
  const program = Effect.scoped(
    Effect.gen(function* () {
      const runner = yield* openRunner(budgets.heap)
      running.runner = Option.some(runner)
      yield* runner.send(ParentMessage.cases.Start.make({ code: input.request.code }))
      return yield* exchange(runner, state, dispatch)
    }).pipe(
      Effect.catchTag('CodePipeFailure', (failure) =>
        failure.reason === 'size'
          ? Effect.succeed(failed(CodeFailure.cases.OverLimit.make({ limit: 'data' })))
          : // The thread is over without a final message. How it ended tells running out of
            // memory apart from the rest.
            Option.match(running.runner, {
              onNone: () => Effect.succeed(failed(CodeFailure.cases.Unavailable.make({}))),
              onSome: (runner) => runner.stopped.pipe(Effect.map(failed)),
            }),
      ),
    ),
  )
  const deadline = Effect.gen(function* () {
    yield* Effect.sleep(`${budgets.seconds} seconds`)
    // Told to stop, the thread still sends what the program printed. A thread that cannot hear
    // (it is inside one long built-in) says nothing within the grace, and the scope ends it.
    const cancelled = Option.match(running.runner, {
      onNone: () => Effect.void,
      onSome: (runner) => runner.send(ParentMessage.cases.Cancel.make({})),
    })
    return yield* state.timeout(cancelled)
  }).pipe(Effect.withSpan('Code.deadline'))
  return yield* Effect.raceFirst(state.supervise(program), deadline)
})

/** Fail-fast capacity avoids running stale requests after another program has finished. */
export const codeProcessLayer = Layer.effect(
  CodeProcess,
  Effect.gen(function* () {
    const capacity = yield* Semaphore.make(budgets.processes)
    const active = new Set<ThreadId>()
    return CodeProcess.of({
      run: Effect.fn('Code.run')(function* (input, dispatch) {
        const unavailable = CodeOutcome.cases.Failed.make({
          failure: CodeFailure.cases.Unavailable.make({}),
          calls: [],
          logs: [],
          logsTruncated: false,
        })
        if (bytes(input.request.code) > budgets.source)
          return CodeOutcome.cases.Failed.make({
            failure: CodeFailure.cases.Threw.make({ message: 'Program source exceeds 16 KiB.' }),
            calls: [],
            logs: [],
            logsTruncated: false,
          })
        const thread = input.boundary.thread
        if (active.has(thread)) return unavailable
        active.add(thread)
        const admitted = yield* capacity
          .withPermitsIfAvailable(1)(execute(input, dispatch))
          .pipe(Effect.ensuring(Effect.sync(() => active.delete(thread))))
        return Option.getOrElse(admitted, () => unavailable)
      }),
    })
  }),
)
