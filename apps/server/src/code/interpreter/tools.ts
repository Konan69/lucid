/** Ported from opencode `packages/codemode/src/tool-runtime.ts` at 3884062 (MIT). */
import { runHost } from './host.ts'
import type { Raised } from './model.ts'
import { Effect, Option, Predicate } from 'effect'
import { ToolRefusal } from './refusal.ts'
import { decodeInput as decodeToolInput, decodeOutput as decodeToolOutput } from './schema.ts'
import type { Definition } from './tool.ts'
import {
  isSandboxValue,
  SandboxDate,
  SandboxMap,
  SandboxPromise,
  SandboxRegExp,
  SandboxSet,
  SandboxURL,
  SandboxURLSearchParams,
} from './values.ts'

export type HostTool<R = never> = (...args: Array<unknown>) => Effect.Effect<unknown, Raised, R>

export type HostTools<R = never> = {
  [name: string]: HostTool<R> | Definition<R> | HostTools<R>
}

export type Services<Tools> = ServicesOf<Tools, []>

type ServicesOf<Tools, Depth extends ReadonlyArray<unknown>> = Depth['length'] extends 8
  ? never
  : Tools extends (...args: Array<unknown>) => Effect.Effect<unknown, Raised, infer R>
    ? R
    : Tools extends {
          readonly _tag: 'ProgramTool'
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
  readonly outcome: 'success' | 'failure'
  /** Model-safe failure message; present only when `outcome` is `"failure"`. */
  readonly message?: string
}

/** Non-throwing observation hooks fired around each admitted tool call. */
export type ToolCallHooks<R = never> = {
  readonly onToolCallStart?: ((call: ToolCallStarted) => Effect.Effect<void, never, R>) | undefined
  readonly onToolCallEnd?: ((call: ToolCallEnded) => Effect.Effect<void, never, R>) | undefined
}

export type SafeObject = Record<string, unknown>

/** The plain-data checkpoint also admits confined built-ins for intra-program operations. */
export type CheckpointValue =
  | undefined
  | null
  | string
  | number
  | boolean
  | SafeObject
  | Array<unknown>
  | SandboxDate
  | SandboxRegExp
  | SandboxMap
  | SandboxSet
  | SandboxURL
  | SandboxURLSearchParams

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
      | 'UnknownTool'
      | 'InvalidToolInput'
      | 'InvalidToolOutput'
      | 'InvalidDataValue'
      | 'ToolCallLimitExceeded',
    message: string,
    readonly suggestions: ReadonlyArray<string> = [],
  ) {
    super(message)
    this.name = 'ToolRuntimeError'
  }
}

const isDefinition = <R>(
  value: HostTool<R> | Definition<R> | HostTools<R>,
): value is Definition<R> =>
  typeof value === 'object' && value !== null && Predicate.isTagged(value, 'ProgramTool')

const blockedMemberNames = new Set(['__proto__', 'constructor', 'prototype'])

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
 *   stdlib/value.ts): standard-library value instances pass through untouched (treated as leaves,
 *   contents not walked), so values flowing through `Object.*` helpers, coercion inputs, and
 *   other in-sandbox checkpoints stay fully usable (`.getTime()`, `.has()`, ...).
 *
 * Both modes reject un-awaited promises with an await-hinting diagnostic.
 */
export const copyIn = (value: unknown, label: string, preserveSandboxValues = false): unknown =>
  copyBounded(value, { label, preserveSandboxValues }, 0, new Set())

/** Intermediate non-finite numbers stay admitted until copyOut normalizes them at egress. */
const isPrimitive = (value: unknown): value is null | undefined | string | number | boolean =>
  value === null ||
  value === undefined ||
  typeof value === 'string' ||
  typeof value === 'boolean' ||
  typeof value === 'number'

type CopyContext = { readonly label: string; readonly preserveSandboxValues: boolean }

/** Preserve confined built-ins and wrap native counterparts only for intra-program checkpoints. */
const preserveBuiltIn = <Value extends object>(
  value: Value,
  context: CopyContext,
  depth: number,
  seen: Set<object>,
): Option.Option<CheckpointValue> => {
  const { label } = context
  if (isSandboxValue(value)) return Option.some(value)
  // Host instances cannot normally reach an intra-sandbox checkpoint (tool results cross
  // the boundary first), but wrap them defensively rather than degrading to JSON forms.
  if (value instanceof Date) return Option.some(new SandboxDate(value.getTime()))
  if (value instanceof RegExp) return Option.some(new SandboxRegExp(value.source, value.flags))
  if (value instanceof Map) {
    const wrapped = new SandboxMap()
    for (const [key, item] of value.entries()) {
      wrapped.map.set(
        copyBounded(key, { label, preserveSandboxValues: true }, depth + 1, seen),
        copyBounded(item, { label, preserveSandboxValues: true }, depth + 1, seen),
      )
    }
    return Option.some(wrapped)
  }
  if (value instanceof Set) {
    const wrapped = new SandboxSet()
    for (const item of value.values())
      wrapped.set.add(copyBounded(item, { label, preserveSandboxValues: true }, depth + 1, seen))
    return Option.some(wrapped)
  }
  if (value instanceof URL) return Option.some(new SandboxURL(new URL(value.href)))
  if (value instanceof URLSearchParams)
    return Option.some(new SandboxURLSearchParams(new URLSearchParams(value)))
  return Option.none()
}

/** Built-ins without a JSON representation become empty data objects, in reference test order. */
const isOpaqueBuiltIn = <Value extends object>(value: Value): boolean =>
  value instanceof SandboxRegExp ||
  value instanceof SandboxMap ||
  value instanceof SandboxSet ||
  value instanceof SandboxURLSearchParams ||
  value instanceof RegExp ||
  value instanceof Map ||
  value instanceof Set ||
  value instanceof URLSearchParams

/** Serialize supported built-ins exactly as the reference boundary; ordinary containers keep walking. */
const serializeBuiltIn = <Value extends object>(value: Value): Option.Option<CheckpointValue> => {
  // Sandbox value types (and their host counterparts, which a host tool may legitimately
  // return) serialize exactly as JSON.stringify would at the data boundary: Date/URL use
  // toJSON(), while RegExp/Map/Set/URLSearchParams have no JSON form beyond {}.
  if (value instanceof SandboxDate) {
    return Option.some(Number.isFinite(value.time) ? new Date(value.time).toISOString() : null)
  }
  if (value instanceof Date) {
    return Option.some(Number.isFinite(value.getTime()) ? value.toISOString() : null)
  }
  if (value instanceof SandboxURL) return Option.some(value.url.href)
  if (value instanceof URL) return Option.some(value.href)
  if (isOpaqueBuiltIn(value)) {
    return Option.some(Object.create(null) as SafeObject)
  }

  return Option.none()
}

/** Validate depth, cycles, prototypes, and blocked keys before copying a value across a checkpoint. */
const copyBounded = (
  value: unknown,
  context: CopyContext,
  depth: number,
  seen: Set<object>,
): CheckpointValue => {
  const { label, preserveSandboxValues } = context
  if (depth > MAX_VALUE_DEPTH) {
    throw new ToolRuntimeError(
      'InvalidDataValue',
      `${label} exceeds the maximum value depth of ${MAX_VALUE_DEPTH}.`,
    )
  }
  if (isPrimitive(value)) return value

  if (typeof value !== 'object') {
    throw new ToolRuntimeError('InvalidDataValue', `${label} must contain data only.`)
  }

  // An un-awaited promise never crosses a data checkpoint as `{}`; the diagnostic tells the
  // model exactly how to fix the program instead.
  if (value instanceof SandboxPromise) {
    throw new ToolRuntimeError(
      'InvalidDataValue',
      `${label} contains an un-awaited Promise; await tool calls (e.g. \`const result = await tools.ns.tool(...)\`) before using their results.`,
    )
  }

  if (preserveSandboxValues) {
    const preserved = preserveBuiltIn(value, context, depth, seen)
    if (Option.isSome(preserved)) return preserved.value
  }
  const serialized = serializeBuiltIn(value)
  if (Option.isSome(serialized)) return serialized.value
  return copyContainer(value, context, depth, seen)
}

/** Copy only own data, with cycle and prototype guards applied before recursive descent. */
const copyContainer = <Value extends object>(
  value: Value,
  context: CopyContext,
  depth: number,
  seen: Set<object>,
): CheckpointValue => {
  const { label } = context
  if (seen.has(value)) {
    throw new ToolRuntimeError('InvalidDataValue', `${label} contains a circular value.`)
  }

  seen.add(value)

  if (Array.isArray(value)) {
    const copied = value.map((item) => copyBounded(item, context, depth + 1, seen))
    seen.delete(value)
    return copied
  }

  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ToolRuntimeError('InvalidDataValue', `${label} must contain plain objects only.`)
  }

  const copied: SafeObject = Object.create(null) as SafeObject
  for (const [key, item] of Object.entries(value)) {
    if (isBlockedMember(key)) {
      throw new ToolRuntimeError('InvalidDataValue', `${label} contains blocked property '${key}'.`)
    }
    copied[key] = copyBounded(item, context, depth + 1, seen)
  }
  seen.delete(value)
  return copied
}

/** Normalization preserves unchecked leaves; copyIn owns validation before a real data boundary. */
type Normalized<Value> = Value | null | string | number | SafeObject | Array<unknown>

/** Normalize undefined and non-finite numbers recursively; copyIn remains the authority for admission. */
export const copyOut = <Value>(value: Value, undefinedAsNull = false): Normalized<Value> => {
  if (value === undefined && undefinedAsNull) return null
  // Normalize non-finite numbers to null as the value crosses out of the sandbox (final return
  // and tool-call arguments both funnel through here), matching JSON semantics - NaN/Infinity
  // have no JSON representation, so JSON.stringify would produce null anyway.
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return null
  }
  if (Array.isArray(value)) {
    return value.map((item) => copyOut(item, undefinedAsNull))
  }

  if (value !== null && typeof value === 'object' && !(value instanceof ToolReference)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, copyOut(item, undefinedAsNull)]),
    )
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
const namespaceKeys = <R>(
  tools: HostTools<R>,
  path: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  let value: HostTool<R> | Definition<R> | HostTools<R> = tools
  for (const segment of path) {
    if (
      isBlockedMember(segment) ||
      typeof value === 'function' ||
      isDefinition(value) ||
      !Object.hasOwn(value, segment)
    ) {
      throw new ToolRuntimeError('UnknownTool', `Unknown tool namespace '${path.join('.')}'.`, [
        'Object.keys(tools) lists the available namespaces; tools.find_tools({query}) finds described tools.',
      ])
    }
    value = value[segment] as HostTool<R> | Definition<R> | HostTools<R>
  }
  if (typeof value === 'function' || isDefinition(value)) return []
  return Object.keys(value)
}

/** Walk only own unblocked tool-tree segments and reject namespaces at a callable leaf. */
const resolve = <R>(
  tools: HostTools<R>,
  path: ReadonlyArray<string>,
): HostTool<R> | Definition<R> => {
  let value: HostTool<R> | Definition<R> | HostTools<R> = tools

  for (const segment of path) {
    if (
      isBlockedMember(segment) ||
      typeof value === 'function' ||
      isDefinition(value) ||
      !Object.hasOwn(value, segment)
    ) {
      throw new ToolRuntimeError('UnknownTool', `Unknown tool '${path.join('.')}'.`, [
        'Use tools.find_tools({query}) to find available described tools.',
      ])
    }
    value = value[segment] as HostTool<R> | Definition<R> | HostTools<R>
  }

  if (typeof value !== 'function' && !isDefinition(value)) {
    throw new ToolRuntimeError('UnknownTool', `Tool '${path.join('.')}' is not callable.`)
  }

  return value
}

export type ToolRuntime<R = never> = {
  readonly root: ToolReference
  readonly calls: Array<ToolCall>
  readonly invoke: (
    path: ReadonlyArray<string>,
    args: Array<unknown>,
  ) => Effect.Effect<unknown, Raised, R>
  /** Enumerable namespace/tool names at one node of the callable tool tree; see `namespaceKeys`. */
  readonly keys: (path: ReadonlyArray<string>) => ReadonlyArray<string>
}

/** Retain explicit schemas and host behavior in the confined runtime without adding discovery authority. */
export const make = <R>(
  tools: HostTools<R>,
  /** Undefined means unlimited tool calls. */
  maxToolCalls: number | undefined,
  hooks?: ToolCallHooks<R>,
): ToolRuntime<R> => {
  const calls: Array<ToolCall> = []
  // Wraps the settling portion of a tool call so onToolCallEnd observes success and failure
  // symmetrically. Interruption (e.g. the execution timeout) fires neither outcome.
  const observeEnd = <A, E>(
    effect: Effect.Effect<A, E, R>,
    call: ToolCallStarted,
  ): Effect.Effect<A, E, R> => {
    const onEnd = hooks?.onToolCallEnd
    if (onEnd === undefined) return effect
    const startedAt = Date.now()
    return effect.pipe(
      Effect.tap(() => onEnd({ ...call, durationMs: Date.now() - startedAt, outcome: 'success' })),
      Effect.tapError((error) => {
        const message =
          error instanceof ToolRefusal || error instanceof ToolRuntimeError
            ? error.message
            : 'Tool execution failed'
        return onEnd({
          ...call,
          durationMs: Date.now() - startedAt,
          outcome: 'failure',
          message,
        })
      }),
    )
  }

  const decodeOutput = (value: unknown, name: string) =>
    Effect.try({
      try: () => copyIn(value, `Result from tool '${name}'`),
      catch: () => new ToolRuntimeError('InvalidToolOutput', `Invalid output from tool '${name}'.`),
    })

  /** Charge the call budget before execution so rejected calls cannot cause host side effects. */
  const recordCall = (call: ToolCall): void => {
    if (maxToolCalls !== undefined && calls.length >= maxToolCalls) {
      throw new ToolRuntimeError(
        'ToolCallLimitExceeded',
        `Execution exceeded its tool-call limit of ${maxToolCalls}.`,
      )
    }
    calls.push(call)
  }

  return {
    root: new ToolReference([]),
    calls,
    keys: (path) => namespaceKeys(tools, path),
    invoke: (path, args) =>
      Effect.gen(function* () {
        const name = path.join('.')
        const externalArgs = args.map((arg) => copyOut(copyIn(arg, `Arguments for tool '${name}'`)))
        const call = { name }
        const recordAndObserve = (input: unknown) =>
          Effect.sync(() => {
            recordCall(call)
            return calls.length - 1
          }).pipe(
            Effect.tap((index) => hooks?.onToolCallStart?.({ index, name, input }) ?? Effect.void),
          )
        const tool = resolve(tools, path)
        let describedInput: unknown
        if (isDefinition(tool)) {
          if (externalArgs.length !== 1)
            throw new ToolRuntimeError(
              'InvalidToolInput',
              `Tool '${name}' expects exactly one input object.`,
            )
          describedInput = yield* decodeToolInput(tool, externalArgs[0]).pipe(
            Effect.mapError(
              (cause) =>
                new ToolRuntimeError(
                  'InvalidToolInput',
                  `Invalid input for tool '${name}': ${String(cause)}`,
                ),
            ),
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
                Effect.mapError(
                  () =>
                    new ToolRuntimeError(
                      'InvalidToolOutput',
                      `Invalid output from tool '${name}'.`,
                    ),
                ),
              )
              return yield* decodeOutput(result, name)
            }),
            currentCall,
          )
        }
        return yield* observeEnd(
          Effect.gen(function* () {
            return yield* decodeOutput(
              yield* runHost(Effect.suspend(() => tool(...externalArgs))),
              name,
            )
          }),
          currentCall,
        )
      }),
  }
}

export * as ToolRuntime from './tools.ts'
