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
  Layer,
  Option,
  Schema,
  Semaphore,
} from 'effect'
import { isCodeName } from '../observability/messages.ts'
import type { CodeBoundary } from './authority.ts'
import { boundedLogs, encodedPrefix } from './logs.ts'
import { budgets, bytes } from './budgets.ts'
import { Program, Tool, toolRefusal } from './interpreter/index.ts'

/**
 * One call a program made: which of its tools, and the arguments as JSON. It carries data only;
 * the Person and the Thread it acts for are bound on the server and never come from the program.
 */
export const ProgramCall = Schema.Struct({ kind: CodeCallKind, input: Schema.Json })
export interface ProgramCall extends Schema.Schema.Type<typeof ProgramCall> {}

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
 * moved, and any decision that ended it. The program supplies none of it. A call that changes
 * something and was still running when the program was lost is uncertain.
 */
export class Execution {
  readonly calls: CodeCall[] = []
  // Until the interpreter hands back what was printed, the printed output is not known to be whole.
  private logs = CodeLogs.make({ logs: [], logsTruncated: true })
  private terminal: Option.Option<CodeOutcome> = Option.none()
  /** Rebuilds the decision's snapshot once the calls that were already running have reported. */
  private decision: Option.Option<() => CodeOutcome> = Option.none()
  /** Calls dispatched and not yet returned. A decision waits for these; it never interrupts them. */
  private flying = 0
  private data = 0
  private reserved = 0

  /** A limit or a policy decision closes admission; nothing is dispatched after either. */
  get accepting() {
    return Option.isNone(this.terminal) && Option.isNone(this.decision)
  }

  /** What the program printed, fitted to its allowance. The interpreter keeps every line. */
  printed(lines: ReadonlyArray<string>) {
    this.logs = boundedLogs(lines, budgets.logs, false)
  }

  /** A limit is a permanent latch: receipts are fixed as they stand and no later call is admitted. */
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

  /** Supervision owns recovery when the interpreter itself fails; receipts still decide uncertainty. */
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

  /**
   * Counts a call and its arguments against the program's allowances before it is dispatched.
   * `size` is the UTF-8 length of the arguments as JSON. Passing a limit ends the program.
   */
  reserve(size: number): Option.Option<CodeOutcome> {
    if (Option.isSome(this.terminal)) return this.terminal
    if (++this.reserved > budgets.calls)
      return Option.some(this.terminate(CodeFailure.cases.OverLimit.make({ limit: 'calls' })))
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
   * interpreter starts each one on its own fiber where the program wrote it, at most eight at
   * once (`interpreter/evaluate.ts`, `createToolCallPromise`). Admission is checked immediately
   * before dispatch.
   */
  readonly call = Effect.fn('Code.dispatchFrame')(function* (
    this: Execution,
    call: ProgramCall,
    dispatch: Dispatch,
    stopped: Deferred.Deferred<CodeOutcome>,
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
  private land(index: number, call: ProgramCall, result: CallOutcome): CallStep {
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

  /**
   * The outcome of a program the interpreter ran to its own end. A decision taken on the way
   * wins over whatever the program went on to return.
   */
  finish(result: Program.Result): CodeOutcome {
    this.printed(result.logs === undefined ? [] : result.logs)
    const decided = this.settled()
    if (Option.isSome(decided)) return decided.value
    return result.ok ? this.completed(result.value) : this.failed(failureOf(result.error))
  }
}

/**
 * Why the interpreter stopped a program, in the words of the contract. Its diagnostics that are
 * the program's own fault (it does not parse, uses syntax a program may not, names a tool that
 * does not exist, threw) are one case: the model reads the message and writes a better program.
 */
function failureOf(diagnostic: Program.Diagnostic): CodeFailure {
  switch (diagnostic.kind) {
    case 'TimeoutExceeded':
      return CodeFailure.cases.TimedOut.make({ seconds: budgets.seconds })
    case 'WorkLimitExceeded':
      return CodeFailure.cases.OverLimit.make({ limit: 'work' })
    case 'ToolCallLimitExceeded':
      return CodeFailure.cases.OverLimit.make({ limit: 'calls' })
    case 'ParseError':
    case 'UnsupportedSyntax':
    case 'UnknownTool':
    case 'InvalidToolInput':
    case 'InvalidToolOutput':
    case 'InvalidDataValue':
    case 'ToolFailure':
    case 'ExecutionFailure':
      return CodeFailure.cases.Threw.make({ message: diagnostic.message.slice(0, 500) })
  }
}

const decodeInput = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

/**
 * One of the program's four tools, as the interpreter calls it. The effect never completes once
 * the program has been ended (a limit, an Approval, a block, an unknown outcome): the interpreter
 * shows a failed tool to the program as an error it may catch, and a program must not be able to
 * catch its own end. `stopped` then ends the interpreter from outside.
 *
 * When a call brings a decision, calls already running are left to finish and the decision is
 * reported only when the last of them has returned (`Execution.call`). Interrupting them would
 * turn a real result into "unknown".
 */
const programTool = (
  kind: CodeCallKind,
  execution: {
    readonly state: Execution
    readonly dispatch: Dispatch
    readonly stopped: Deferred.Deferred<CodeOutcome>
  },
) =>
  Tool.make({
    description: kind,
    // The arguments are checked where each call is checked as the Person (`calls.ts`).
    input: { type: 'object' },
    run: Effect.fn('Code.runCall')(function* (input) {
      const { state, dispatch, stopped } = execution
      // What reaches here is the interpreter's plain data; a JSON round trip makes it the value
      // the checks and the provider will see, and gives the size it is counted by.
      // `undefined` has no JSON form; a program that passes nothing passes null.
      const text = JSON.stringify(input === undefined ? null : input)
      const refused = state.reserve(bytes(text))
      if (Option.isSome(refused)) {
        // A decision is reported by the landing of its last running call, not from here.
        if (!state.decided) yield* Deferred.succeed(stopped, refused.value)
        return yield* Effect.never
      }
      if (!state.accepting) return yield* Effect.never
      const decoded = yield* decodeInput(text).pipe(
        Effect.mapError(() => toolRefusal('Tool arguments must be JSON.')),
      )
      const call = ProgramCall.make({ kind, input: decoded })
      const landed = yield* state.call(call, dispatch, stopped)
      if (state.decided || Option.isNone(landed)) return yield* Effect.never
      const step = landed.value
      if (CallStep.guards.Continue(step)) return step.value
      yield* Deferred.succeed(stopped, step.outcome)
      return yield* Effect.never
    }),
  })

/**
 * Runs one program in this process, in the interpreter ported from opencode
 * (`interpreter/`). The program can do one thing outside itself: call its four tools, each of
 * which is checked on the way as the Person. The deadline, the step count and the amount of data
 * it may make are the interpreter's limits; calls and the data they move are counted here.
 * No failure path replays a program.
 */
const execute = Effect.fn('Code.supervise')(function* (
  input: { readonly request: RunCodeRequest; readonly boundary: CodeBoundary },
  dispatch: Dispatch,
) {
  const state = new Execution()
  const stopped = yield* Deferred.make<CodeOutcome>()
  const execution = { state, dispatch, stopped }
  const interpreted = Program.execute({
    code: input.request.code,
    tools: {
      find_tools: programTool('find_tools', execution),
      use_tool: programTool('use_tool', execution),
      browse: programTool('browse', execution),
      read_page: programTool('read_page', execution),
    },
    limits: {
      timeoutMs: budgets.seconds * 1_000,
      maxToolCalls: budgets.calls,
      maxSteps: budgets.steps,
      maxGrowth: budgets.growth,
    },
  }).pipe(Effect.map((result) => state.finish(result)))
  return yield* state.supervise(Effect.raceFirst(interpreted, Deferred.await(stopped)))
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
