/** Ported from opencode `packages/codemode/src/tool-runtime.ts` at 3884062 (MIT). */
import type { Raised } from "./model.ts"
import { Cause, Effect } from "effect"
import { ToolRefusal, toolRefusal } from "./refusal.ts"
import {
  decodeInput as decodeToolInput,
  decodeOutput as decodeToolOutput,
} from "./schema.ts"
import { isDefinition as isToolDefinition, type Definition } from "./tool.ts"
import {
  SandboxDate,
  SandboxMap,
  SandboxPromise,
  SandboxRegExp,
  SandboxSet,
  SandboxURL,
  SandboxURLSearchParams,
} from "./values.ts"


export type HostTool<R = never> = (...args: Array<unknown>) => Effect.Effect<unknown, Raised, R>

export type HostTools<R = never> = {
  [name: string]: HostTool<R> | Definition<R> | HostTools<R>
}

export type Services<Tools> = ServicesOf<Tools, []>

type ServicesOf<Tools, Depth extends ReadonlyArray<unknown>> = Depth["length"] extends 8
  ? never
  : Tools extends (...args: Array<unknown>) => Effect.Effect<unknown, Raised, infer R>
    ? R
    : Tools extends {
          readonly _tag: "ProgramTool"
          readonly run: (input: unknown) => Effect.Effect<unknown, Raised, infer R>
        }
      ? R
      : Tools extends object
        ? string extends keyof Tools
          ? ServicesOf<Tools[string], [...Depth, unknown]>
          : ServicesOf<Tools[keyof Tools], [...Depth, unknown]>
        : never

/** Minimal audit record retained for each admitted tool call. */
export type ToolCall = {
  readonly name: string
}

/** Decoded tool call observed immediately before tool execution. */
export type ToolCallStarted = {
  readonly index: number
  readonly name: string
  readonly input: unknown
}

/** Completed tool call observed immediately after tool execution settles. */
export type ToolCallEnded = {
  readonly index: number
  readonly name: string
  readonly input: unknown
  readonly durationMs: number
  readonly outcome: "success" | "failure"
  /** Model-safe failure message; present only when `outcome` is `"failure"`. */
  readonly message?: string
}

/** Non-throwing observation hooks fired around each admitted tool call. */
export type ToolCallHooks<R = never> = {
  readonly onToolCallStart?: ((call: ToolCallStarted) => Effect.Effect<void, never, R>) | undefined
  readonly onToolCallEnd?: ((call: ToolCallEnded) => Effect.Effect<void, never, R>) | undefined
}

export type SafeObject = Record<string, unknown>

export class ToolReference {
  constructor(readonly path: ReadonlyArray<string>) {}
}

/**
 * Maximum nesting depth for values crossing a data boundary. Fixed (not a configurable
 * limit) purely because it produces a clearer diagnostic than a native stack-overflow
 * RangeError would.
 */
const MAX_VALUE_DEPTH = 32

export class ToolRuntimeError extends Error {
  constructor(
    readonly kind:
      | "UnknownTool"
      | "InvalidToolInput"
      | "InvalidToolOutput"
      | "InvalidDataValue"
      | "ToolCallLimitExceeded",
    message: string,
    readonly suggestions: ReadonlyArray<string> = [],
  ) {
    super(message)
    this.name = "ToolRuntimeError"
  }
}

const isDefinition = <R>(value: HostTool<R> | Definition<R> | HostTools<R>): value is Definition<R> =>
  isToolDefinition<R>(value)

const runHost = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, ToolRefusal, R> =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
      const error = Cause.squash(cause)
      return Effect.fail(error instanceof ToolRefusal ? error : toolRefusal("Tool execution failed", error))
    }),
  )

const blockedMemberNames = new Set(["__proto__", "constructor", "prototype"])

export const isBlockedMember = (name: string): boolean => blockedMemberNames.has(name)

/**
 * Validates and copies a value against the plain-data contract (depth, circularity, plain
 * objects only, blocked properties, data-only leaves).
 *
 * Two modes share the walk:
 * - **Boundary** (`preserveSandboxValues` false, the default): the host<->sandbox boundary -
 *   final results, tool-call arguments, `JSON.stringify`. Sandbox value types serialize
 *   exactly as JSON.stringify would: Date/URL -> strings, the remaining value types -> {}.
 * - **Intra-sandbox checkpoint** (`preserveSandboxValues` true; see `boundedData` in
 *   program.ts): standard-library value instances pass through untouched (treated as leaves,
 *   contents not walked), so values flowing through `Object.*` helpers, coercion inputs, and
 *   other in-sandbox checkpoints stay fully usable (`.getTime()`, `.has()`, ...).
 *
 * Both modes reject un-awaited promises with an await-hinting diagnostic.
 */
export const copyIn = (value: unknown, label: string, preserveSandboxValues = false): unknown =>
  copyBounded(value, label, 0, new Set(), preserveSandboxValues)

const copyBounded = (
  value: unknown,
  label: string,
  depth: number,
  seen: Set<object>,
  preserveSandboxValues: boolean,
): unknown => {
  if (depth > MAX_VALUE_DEPTH) {
    throw new ToolRuntimeError("InvalidDataValue", `${label} exceeds the maximum value depth of ${MAX_VALUE_DEPTH}.`)
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    // NaN/Infinity are allowed to exist as in-sandbox intermediates (matching real JS and a real
    // engine) so defensive guards like `Number.isNaN(x)` / `parseInt(x) || 0` can run. They are
    // normalized to `null` when the value leaves the sandbox - see copyOut - exactly as
    // JSON.stringify already does at any tool boundary.
    typeof value === "number"
  ) {
    return value
  }

  if (typeof value !== "object") {
    throw new ToolRuntimeError("InvalidDataValue", `${label} must contain data only.`)
  }

  // An un-awaited promise never crosses a data checkpoint as `{}`; the diagnostic tells the
  // model exactly how to fix the program instead.
  if (value instanceof SandboxPromise) {
    throw new ToolRuntimeError(
      "InvalidDataValue",
      `${label} contains an un-awaited Promise; await tool calls (e.g. \`const result = await tools.ns.tool(...)\`) before using their results.`,
    )
  }

  if (preserveSandboxValues) {
    // Intra-sandbox checkpoints keep sandbox value instances alive as leaves; their contents
    // are never walked here (Map/Set members are validated where mutation happens, and the
    // real boundary still serializes them below).
    if (
      value instanceof SandboxDate ||
      value instanceof SandboxRegExp ||
      value instanceof SandboxMap ||
      value instanceof SandboxSet ||
      value instanceof SandboxURL ||
      value instanceof SandboxURLSearchParams
    ) {
      return value
    }
    // Host instances cannot normally reach an intra-sandbox checkpoint (tool results cross
    // the boundary first), but wrap them defensively rather than degrading to JSON forms.
    if (value instanceof Date) return new SandboxDate(value.getTime())
    if (value instanceof RegExp) return new SandboxRegExp(value.source, value.flags)
    if (value instanceof Map) {
      const wrapped = new SandboxMap()
      for (const [key, item] of value.entries()) {
        wrapped.map.set(copyBounded(key, label, depth + 1, seen, true), copyBounded(item, label, depth + 1, seen, true))
      }
      return wrapped
    }
    if (value instanceof Set) {
      const wrapped = new SandboxSet()
      for (const item of value.values()) wrapped.set.add(copyBounded(item, label, depth + 1, seen, true))
      return wrapped
    }
    if (value instanceof URL) return new SandboxURL(new URL(value.href))
    if (value instanceof URLSearchParams) return new SandboxURLSearchParams(new URLSearchParams(value))
  }

  // Sandbox value types (and their host counterparts, which a host tool may legitimately
  // return) serialize exactly as JSON.stringify would at the data boundary: Date/URL use
  // toJSON(), while RegExp/Map/Set/URLSearchParams have no JSON form beyond {}.
  if (value instanceof SandboxDate) {
    return Number.isFinite(value.time) ? new Date(value.time).toISOString() : null
  }
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null
  }
  if (value instanceof SandboxURL) return value.url.href
  if (value instanceof URL) return value.href
  if (
    value instanceof SandboxRegExp ||
    value instanceof SandboxMap ||
    value instanceof SandboxSet ||
    value instanceof SandboxURLSearchParams ||
    value instanceof RegExp ||
    value instanceof Map ||
    value instanceof Set ||
    value instanceof URLSearchParams
  ) {
    return Object.create(null) as SafeObject
  }

  if (seen.has(value)) {
    throw new ToolRuntimeError("InvalidDataValue", `${label} contains a circular value.`)
  }

  seen.add(value)

  if (Array.isArray(value)) {
    const copied = value.map((item) => copyBounded(item, label, depth + 1, seen, preserveSandboxValues))
    seen.delete(value)
    return copied
  }

  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ToolRuntimeError("InvalidDataValue", `${label} must contain plain objects only.`)
  }

  const copied: SafeObject = Object.create(null) as SafeObject
  for (const [key, item] of Object.entries(value)) {
    if (isBlockedMember(key)) {
      throw new ToolRuntimeError("InvalidDataValue", `${label} contains blocked property '${key}'.`)
    }
    copied[key] = copyBounded(item, label, depth + 1, seen, preserveSandboxValues)
  }
  seen.delete(value)
  return copied
}

export const copyOut = (value: unknown, undefinedAsNull = false): unknown => {
  if (value === undefined && undefinedAsNull) return null
  // Normalize non-finite numbers to null as the value crosses out of the sandbox (final return
  // and tool-call arguments both funnel through here), matching JSON semantics - NaN/Infinity
  // have no JSON representation, so JSON.stringify would produce null anyway.
  if (typeof value === "number" && !Number.isFinite(value)) {
    return null
  }
  if (Array.isArray(value)) {
    return value.map((item) => copyOut(item, undefinedAsNull))
  }

  if (value !== null && typeof value === "object" && !(value instanceof ToolReference)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copyOut(item, undefinedAsNull)]))
  }

  return value
}

/**
 * The enumerable names at one node of the callable tool tree - namespace names at the root,
 * tool/namespace names below - powering `Object.keys(tools)` and `for...in` over tool
 * references. A callable tool is a leaf and enumerates as `[]` (like `Object.keys` of a
 * function in JS). An unknown path is an `UnknownTool` error pointing at the working
 * discovery idioms, mirroring how calling an unknown tool fails.
 */
const namespaceKeys = <R>(tools: HostTools<R>, path: ReadonlyArray<string>): ReadonlyArray<string> => {
  let value: HostTool<R> | Definition<R> | HostTools<R> = tools
  for (const segment of path) {
    if (
      isBlockedMember(segment) ||
      typeof value === "function" ||
      isDefinition(value) ||
      !Object.hasOwn(value, segment)
    ) {
      throw new ToolRuntimeError("UnknownTool", `Unknown tool namespace '${path.join(".")}'.`, [
        "Object.keys(tools) lists the available namespaces; tools.find_tools({query}) finds described tools.",
      ])
    }
    value = value[segment] as HostTool<R> | Definition<R> | HostTools<R>
  }
  if (typeof value === "function" || isDefinition(value)) return []
  return Object.keys(value)
}

const resolve = <R>(tools: HostTools<R>, path: ReadonlyArray<string>): HostTool<R> | Definition<R> => {
  let value: HostTool<R> | Definition<R> | HostTools<R> = tools

  for (const segment of path) {
    if (
      isBlockedMember(segment) ||
      typeof value === "function" ||
      isDefinition(value) ||
      !Object.hasOwn(value, segment)
    ) {
      throw new ToolRuntimeError("UnknownTool", `Unknown tool '${path.join(".")}'.`, [
        "Use tools.find_tools({query}) to find available described tools.",
      ])
    }
    value = value[segment] as HostTool<R> | Definition<R> | HostTools<R>
  }

  if (typeof value !== "function" && !isDefinition(value)) {
    throw new ToolRuntimeError("UnknownTool", `Tool '${path.join(".")}' is not callable.`)
  }

  return value
}

export type ToolRuntime<R = never> = {
  readonly root: ToolReference
  readonly calls: Array<ToolCall>
  readonly invoke: (path: ReadonlyArray<string>, args: Array<unknown>) => Effect.Effect<unknown, Raised, R>
  /** Enumerable namespace/tool names at one node of the callable tool tree; see `namespaceKeys`. */
  readonly keys: (path: ReadonlyArray<string>) => ReadonlyArray<string>
}

export const make = <R>(
  tools: HostTools<R>,
  /** Undefined means unlimited tool calls. */
  maxToolCalls: number | undefined,
  hooks?: ToolCallHooks<R>,
): ToolRuntime<R> => {
  const calls: Array<ToolCall> = []
  // Wraps the settling portion of a tool call so onToolCallEnd observes success and failure
  // symmetrically. Interruption (e.g. the execution timeout) fires neither outcome.
  const observeEnd = <A, E>(effect: Effect.Effect<A, E, R>, call: ToolCallStarted): Effect.Effect<A, E, R> => {
    const onEnd = hooks?.onToolCallEnd
    if (onEnd === undefined) return effect
    const startedAt = Date.now()
    return effect.pipe(
      Effect.tap(() => onEnd({ ...call, durationMs: Date.now() - startedAt, outcome: "success" })),
      Effect.tapError((error) => {
        const message =
          error instanceof ToolRefusal || error instanceof ToolRuntimeError ? error.message : "Tool execution failed"
        return onEnd({
          ...call,
          durationMs: Date.now() - startedAt,
          outcome: "failure",
          message,
        })
      }),
    )
  }

  const decodeOutput = (value: unknown, name: string) =>
    Effect.try({
      try: () => copyIn(value, `Result from tool '${name}'`),
      catch: () => new ToolRuntimeError("InvalidToolOutput", `Invalid output from tool '${name}'.`),
    })

  const recordCall = (call: ToolCall): void => {
    if (maxToolCalls !== undefined && calls.length >= maxToolCalls) {
      throw new ToolRuntimeError("ToolCallLimitExceeded", `Execution exceeded its tool-call limit of ${maxToolCalls}.`)
    }
    calls.push(call)
  }

  return {
    root: new ToolReference([]),
    calls,
    keys: (path) => namespaceKeys(tools, path),
    invoke: (path, args) =>
      Effect.gen(function* () {
        const name = path.join(".")
        const externalArgs = args.map((arg) => copyOut(copyIn(arg, `Arguments for tool '${name}'`)))
        const call = { name }
        const recordAndObserve = (input: unknown) =>
          Effect.sync(() => {
            recordCall(call)
            return calls.length - 1
          }).pipe(Effect.tap((index) => hooks?.onToolCallStart?.({ index, name, input }) ?? Effect.void))
        const tool = resolve(tools, path)
        let describedInput: unknown
        if (isDefinition(tool)) {
          if (externalArgs.length !== 1)
            throw new ToolRuntimeError("InvalidToolInput", `Tool '${name}' expects exactly one input object.`)
          describedInput = yield* decodeToolInput(tool, externalArgs[0]).pipe(
            Effect.mapError((cause) => new ToolRuntimeError("InvalidToolInput", `Invalid input for tool '${name}': ${String(cause)}`)),
          )
        }
        const input = isDefinition(tool) ? describedInput : externalArgs
        const index = yield* recordAndObserve(input)
        const currentCall = { index, name, input }
        if (isDefinition(tool)) {
          return yield* observeEnd(
            Effect.gen(function* () {
              const raw = yield* runHost(Effect.suspend(() => tool.run(describedInput)))
              const result = yield* decodeToolOutput(tool, raw).pipe(
                Effect.mapError(() => new ToolRuntimeError("InvalidToolOutput", `Invalid output from tool '${name}'.`)),
              )
              return yield* decodeOutput(result, name)
            }),
            currentCall,
          )
        }
        return yield* observeEnd(
          Effect.gen(function* () {
            return yield* decodeOutput(yield* runHost(Effect.suspend(() => tool(...externalArgs))), name)
          }),
          currentCall,
        )
      }),
  }
}

export * as ToolRuntime from "./tools.ts"
