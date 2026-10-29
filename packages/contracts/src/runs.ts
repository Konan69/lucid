import { Schema } from 'effect'
import { RunId, ThreadId } from './identity.js'

/**
 * Why a Run failed, in the terms a Person would act on. Waiting helps with `RateLimited`; trying
 * again helps with `TimedOut` and `NoAnswer` (the model returned nothing at all); `ModelUnavailable`
 * needs whoever runs this Vivid. `Unexplained` is the honest remainder: the runtime reported a
 * failure Vivid has no name for, and it is never used to hide one of the others.
 */
export const RunFailure = Schema.Literals([
  'Delivery',
  'RateLimited',
  'ModelUnavailable',
  'NoAnswer',
  'TimedOut',
  'Unexplained',
])
export type RunFailure = typeof RunFailure.Type

/** The model-specific Run reasons shared by typed provider failures and telemetry's allowlist. */
export const ModelFailureReason = RunFailure.pick([
  'RateLimited',
  'ModelUnavailable',
  'NoAnswer',
  'TimedOut',
])

/**
 * What a helper Run may do. Each kind is a fixed subset of Vivid's own tools, chosen by the
 * runtime (`packages/agent/runtime/src/children.ts`), never by the model's arguments:
 *
 * - `ReadOnly`: read files on the Computer, read pages, the Library, documents and memory.
 * - `Researcher`: read supplied pages, the Library, documents and memory; no Computer.
 * - `Executor`: what `ReadOnly` does, plus commands, file writes, Integration tools and documents.
 * - `ComputerUse`: drive Vivid's own browser and desktop. One at a time per Person.
 *
 * No kind asks the Person, notifies them, posts, suggests replies, writes memory or starts
 * another helper. What a helper cannot settle alone goes back to the Run that started it.
 */
export const WorkerKind = Schema.Literals(['ReadOnly', 'Researcher', 'Executor', 'ComputerUse'])
export type WorkerKind = typeof WorkerKind.Type

/**
 * The finite budget one helper works within. `seconds` is wall time from its start; past it the
 * helper is aborted and fails with `DeadlinePassed`. `toolCalls` is how many tool calls it may
 * make; past it further calls are refused and it is told to answer with what it has. Spend in
 * tokens and money is measured (`ChildUsage`), not capped: no public Pi boundary stops a request
 * on spend (docs: the Child Runs scope, section 4).
 */
export const ChildBudget = Schema.Struct({
  seconds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(30), Schema.isLessThanOrEqualTo(1800)),
  toolCalls: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)),
})
export interface ChildBudget extends Schema.Schema.Type<typeof ChildBudget> {}

/** The budget a helper gets when Vivid names none: five minutes and thirty tool calls. */
export const DEFAULT_CHILD_BUDGET: ChildBudget = { seconds: 300, toolCalls: 30 }

/**
 * Why a helper failed.
 *
 * - `Delivery`: its work could not be started in the runtime.
 * - `Model`: the model failed it, for the reason a Run would name.
 * - `DeadlinePassed`: it ran out of its `ChildBudget.seconds` and was aborted.
 * - `RuntimeFault`: the runtime reported an ending it has no name for.
 */
export const ChildFailure = Schema.TaggedUnion({
  Delivery: {},
  Model: { reason: RunFailure },
  DeadlinePassed: {},
  RuntimeFault: {},
})
export type ChildFailure = typeof ChildFailure.Type

/**
 * Who stopped a helper. `Vivid`: the Run that started it (`cancel_run`). `Person`: someone in the
 * Thread, by its own Stop or by stopping the whole Thread.
 */
export const ChildStopCause = Schema.Literals(['Vivid', 'Person'])
export type ChildStopCause = typeof ChildStopCause.Type

/**
 * Where a helper stands. `Reserved` exists before the runtime accepted its work; `Stopping`
 * after a stop was asked for and before the runtime said its work ended. The three terminal
 * states never change again.
 */
export const ChildRunState = Schema.TaggedUnion({
  Reserved: {},
  Working: { startedAt: Schema.Finite },
  Stopping: { requestedAt: Schema.Finite, by: ChildStopCause },
  Completed: { finishedAt: Schema.Finite },
  Failed: { finishedAt: Schema.Finite, reason: ChildFailure },
  Stopped: { finishedAt: Schema.Finite, by: ChildStopCause },
})
export type ChildRunState = typeof ChildRunState.Type

/**
 * One helper: a bounded Run Vivid started from inside another Run to do one self-contained part
 * of the work at the same time as others. It belongs to its Thread through `parentRunId`, acts for
 * the Person that Run acts for, and its result comes back to the Thread as a new delivery.
 *
 * `number` counts a Thread's helpers from one. It is how Vivid's model and a Person refer to one
 * ("helper 2"); the model never sees `id` (docs/22, "What the model is shown").
 */
export const ChildRun = Schema.Struct({
  id: RunId,
  parentRunId: RunId,
  /** The model's tool call that started it, so a client can draw it under that call. */
  parentToolCallId: Schema.String,
  threadId: ThreadId,
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  kind: WorkerKind,
  brief: Schema.String,
  budget: ChildBudget,
  requestedAt: Schema.Finite,
  state: ChildRunState,
}).annotate({ identifier: 'ChildRun', title: 'Helper Run' })
export interface ChildRun extends Schema.Schema.Type<typeof ChildRun> {}

/** Token and cost totals of one helper's own conversation, as Pi measured them (`pi.usage`). */
export const ChildUsage = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
  totalTokens: Schema.Finite,
  cost: Schema.Finite,
})
export interface ChildUsage extends Schema.Schema.Type<typeof ChildUsage> {}

/** How a finished helper ended, with its answer when it gave one. Read from the runtime. */
export const ChildRunResult = Schema.TaggedUnion({
  Completed: { text: Schema.String, usage: ChildUsage },
  Failed: { failure: ChildFailure, usage: ChildUsage },
  Stopped: { by: ChildStopCause, usage: ChildUsage },
})
export type ChildRunResult = typeof ChildRunResult.Type

/** One helper as a client opens it: still at work, or finished with its result. */
export const ChildRunDetail = Schema.TaggedUnion({
  Active: { run: ChildRun },
  Ended: { run: ChildRun, result: ChildRunResult },
})
export type ChildRunDetail = typeof ChildRunDetail.Type

/**
 * The runtime asking for one helper, from inside the Run that is answering. `delivery` is the
 * idempotency key of the delivery being answered, read by the runtime from its own committed
 * inputs, never from the model: it names the parent Run. `toolCallId` is the model's call, so
 * repeating the call reserves the same helper.
 */
export const SpawnChildRunRequest = Schema.Struct({
  delivery: Schema.String.check(Schema.isNonEmpty()),
  toolCallId: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
  kind: WorkerKind,
  brief: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(8000)),
  budget: ChildBudget,
})
export interface SpawnChildRunRequest extends Schema.Schema.Type<typeof SpawnChildRunRequest> {}

/** The runtime's native address of a helper's work, kept with its record for evidence. */
export const ChildReceipt = Schema.Struct({
  conversation: Schema.Finite,
  submission: Schema.Finite,
})
export interface ChildReceipt extends Schema.Schema.Type<typeof ChildReceipt> {}

/**
 * How a helper's work ended, as the runtime saw it. `Aborted` is a stop; who asked for it is the
 * server's record (`ChildStopCause`).
 */
export const ChildEnding = Schema.TaggedUnion({
  Completed: {},
  Failed: { failure: ChildFailure },
  Aborted: {},
})
export type ChildEnding = typeof ChildEnding.Type

/**
 * What the runtime reports about one helper. `Started`: its work was admitted. `Ended`: its work
 * ended. `wake` says whether the parent still needs to hear the result as a new delivery; it is
 * false when the parent already read it by waiting (`wait_runs`).
 */
export const ChildReport = Schema.TaggedUnion({
  Started: { receipt: ChildReceipt },
  Ended: { ending: ChildEnding, wake: Schema.Boolean },
})
export type ChildReport = typeof ChildReport.Type

export const SettleChildRunRequest = Schema.Struct({ id: RunId, report: ChildReport })
export interface SettleChildRunRequest extends Schema.Schema.Type<typeof SettleChildRunRequest> {}

/** Opening or stopping one helper, by its id. */
export const ChildRunRequest = Schema.Struct({ id: RunId })
export interface ChildRunRequest extends Schema.Schema.Type<typeof ChildRunRequest> {}

/**
 * The runtime's view of one helper's work: still running, or ended with what Pi recorded.
 * `Absent`: the runtime never started work for it (it was stopped before its first step).
 */
export const RuntimeChildAnswer = Schema.TaggedUnion({
  Absent: {},
  Running: {},
  Completed: { text: Schema.String, usage: ChildUsage },
  Failed: { failure: ChildFailure, usage: ChildUsage },
  Aborted: { usage: ChildUsage },
})
export type RuntimeChildAnswer = typeof RuntimeChildAnswer.Type
