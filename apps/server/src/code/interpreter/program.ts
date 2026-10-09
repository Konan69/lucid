/** Ported from opencode `packages/codemode/src/codemode.ts` at 3884062 (MIT). */
import { Effect, Schema } from "effect"
import { executeWithLimits } from "./evaluate.ts"
import { type Services, type ToolCallStarted, type ToolCallEnded } from "./tools.ts"
import type { Definition } from "./tool.ts"

/** A tool call admitted during an execution. */
export type { ToolCall, ToolCallEnded, ToolCallHooks, ToolCallStarted } from "./tools.ts"

/** Resource budgets enforced independently during each Program program execution. */
export type ExecutionLimits = {
  /** Maximum wall-clock execution time in milliseconds. No default: absent means no timeout. */
  readonly timeoutMs?: number
  /** Maximum number of tool calls admitted by the runtime. No default: absent means unlimited. */
  readonly maxToolCalls?: number
  /** Maximum UTF-8 bytes of model-facing output. No default: absent means no truncation. */
  readonly maxOutputBytes?: number
  /** Maximum statements and expressions evaluated. No default: absent means unlimited. */
  readonly maxSteps?: number
  /** Maximum characters and items of data the program may make. No default: absent means unlimited. */
  readonly maxGrowth?: number
}

type ToolTree<R = never> = {
  readonly [name: string]: Definition<R> | ToolTree<R>
}

export type ResolvedExecutionLimits = {
  readonly timeoutMs: number | undefined
  readonly maxToolCalls: number | undefined
  readonly maxOutputBytes: number | undefined
  readonly maxSteps: number | undefined
  readonly maxGrowth: number | undefined
}

/** Options for one Program execution. */
export type ExecuteOptions<Tools extends Record<string, unknown> = {}> = {
  /** Source for one program in the supported JavaScript subset. */
  code: string
  /** Explicit tool tree exposed to the program as `tools`. */
  tools?: Tools & ToolTree<Services<Tools>>
  /** Per-execution overrides for the default resource limits. */
  limits?: ExecutionLimits
  /** Observes decoded tool input immediately before tool execution. */
  onToolCallStart?: (call: ToolCallStarted) => Effect.Effect<void, never, Services<Tools>>
  /** Observes each admitted tool call as it settles, with outcome and duration. */
  onToolCallEnd?: (call: ToolCallEnded) => Effect.Effect<void, never, Services<Tools>>
}

/** A JSON value that can cross the confined interpreter boundary. */
export type DataValue = Schema.Json

export const DiagnosticKind = Schema.Literals([
  "ParseError",
  "UnsupportedSyntax",
  "UnknownTool",
  "InvalidToolInput",
  "InvalidToolOutput",
  "InvalidDataValue",
  "ToolCallLimitExceeded",
  "TimeoutExceeded",
  "WorkLimitExceeded",
  "ToolFailure",
  "ExecutionFailure",
])
/** Stable categories produced by program, schema, tool, and limit failures. */
export type DiagnosticKind = typeof DiagnosticKind.Type

export const Diagnostic = Schema.Struct({
  kind: DiagnosticKind,
  message: Schema.String,
  location: Schema.optionalKey(Schema.Struct({ line: Schema.Number, column: Schema.Number })),
  suggestions: Schema.optionalKey(Schema.Array(Schema.String)),
})
/** A normalized program diagnostic safe to return across an agent tool boundary. */
export type Diagnostic = typeof Diagnostic.Type

const ToolCallSchema = Schema.Struct({ name: Schema.String })
export const Success = Schema.Struct({
  ok: Schema.Literal(true),
  value: Schema.Json,
  logs: Schema.optionalKey(Schema.Array(Schema.String)),
  truncated: Schema.optionalKey(Schema.Boolean),
  toolCalls: Schema.Array(ToolCallSchema),
})
/** Successful execution after the result has crossed the plain-data boundary. */
export type Success = typeof Success.Type

export const Failure = Schema.Struct({
  ok: Schema.Literal(false),
  error: Diagnostic,
  logs: Schema.optionalKey(Schema.Array(Schema.String)),
  truncated: Schema.optionalKey(Schema.Boolean),
  toolCalls: Schema.Array(ToolCallSchema),
})
/** Failed execution with calls admitted before the diagnostic was produced. */
export type Failure = typeof Failure.Type

/** Schema for the structured success or diagnostic returned by Program execution. */
export const Result = Schema.Union([Success, Failure])
/** Result of executing a Program program. Program failures are data, not Effect failures. */
export type Result = typeof Result.Type

const validateLimit = <Value extends number | undefined>(
  name: keyof ExecutionLimits,
  value: Value,
  minimum: number,
): Value => {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum)) {
    throw new RangeError(`${name} must be a safe integer greater than or equal to ${minimum}.`)
  }
  return value
}

const resolveExecutionLimits = (limits?: ExecutionLimits): ResolvedExecutionLimits => ({
  timeoutMs: validateLimit("timeoutMs", limits?.timeoutMs, 1),
  maxToolCalls: validateLimit("maxToolCalls", limits?.maxToolCalls, 0),
  maxOutputBytes: validateLimit("maxOutputBytes", limits?.maxOutputBytes, 0),
  maxSteps: validateLimit("maxSteps", limits?.maxSteps, 1),
  maxGrowth: validateLimit("maxGrowth", limits?.maxGrowth, 1),
})

/** Executes one Effect-native Program program without constructing a reusable runtime. */
export const execute = <const Tools extends Record<string, unknown>>(
  options: ExecuteOptions<Tools>,
): Effect.Effect<Result, never, Services<Tools>> => {
  return executeWithLimits(options, resolveExecutionLimits(options.limits))
}

