import { copyJson } from '@earendil-works/chord'
import { awaitWithContext, withAbortSignal, type Context } from '@earendil-works/chord/context'
import { Type, type ToolResultMessage } from '@earendil-works/pi-ai'
import {
  defineTool as durableTool,
  type ToolExecutionResult,
  type ToolRegistration,
} from '@earendil-works/pi-durable'
import { toJsonSchema } from '@valibot/to-json-schema'
import { Effect, Result, Schema } from 'effect'
import { ToolDeadline, ToolOutputInvalid } from './failure.ts'
import * as v from 'valibot'
import type { ToolResult } from './result.ts'

export interface ContentResult {
  readonly content: ToolResultMessage['content']
  readonly details: Schema.Json
  readonly terminate?: boolean
}

/** A failed execute result is model text; throwing would make Pi wrap it in a harness diagnostic. */
export function errorResult(message: string): ToolExecutionResult {
  return { output: [{ type: 'text', text: message }], isError: true }
}

const decodeJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Json))
const invalidOutputMessage =
  'The tool ran, but its result could not be represented as JSON. Check before running it again.'

/** Match main's JSON.stringify semantics before Pi persists strict JSON: omit undefined keys,
 * turn non-finite numbers into null, and represent a missing root as null. Cycles and BigInt
 * get an explicit refusal after execution rather than suggesting that the action did not run. */
function jsonOutput(value: Schema.Json) {
  const serialized = Result.try({
    try: () => JSON.stringify(value),
    catch: () =>
      new ToolOutputInvalid({
        message: invalidOutputMessage,
      }),
  })
  return Result.flatMap(serialized, (text) =>
    Result.mapError(
      decodeJson(text === undefined ? 'null' : text),
      () =>
        new ToolOutputInvalid({
          message: invalidOutputMessage,
        }),
    ),
  )
}

/** Pi's three result channels preserve model content, display receipts and response control. */
export function toolResult(name: string, result: ToolResult | ContentResult): ToolExecutionResult {
  const normalized = jsonOutput('content' in result ? result.details : result.output)
  if (Result.isFailure(normalized)) return errorResult(normalized.failure.message)
  const value = copyJson(normalized.success, { omitUndefinedProperties: true })
  const mapped =
    'content' in result
      ? { output: result.content, details: value }
      : {
          output: [{ type: 'text' as const, text: JSON.stringify(value) }],
          details: { customTool: name, output: value },
        }
  if (result.terminate === true) return { ...mapped, control: { terminate: true } }
  return mapped
}

/** Preserve parent cancellation; ordinary failures use main's plain model-visible text. */
export function executionResult(run: Promise<ToolExecutionResult>, context: Context) {
  // The rejected value is from the SDK execution boundary; only Error.message crosses to Pi.
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Promise rejection is unsafe adapter ingress, narrowed immediately.
  return run.catch((failure: unknown) => {
    if (context.abortSignal !== undefined && context.abortSignal.aborted) throw failure
    return errorResult(failure instanceof Error ? failure.message : 'The tool failed.')
  })
}

/** Keep reference issue wording without exposing the received argument object in Pi diagnostics. */
function invalid(name: string, issues: readonly v.BaseIssue<unknown>[]) {
  const summary = issues
    .map((issue) => {
      if (issue.path === undefined || issue.path.length === 0) return issue.message
      return `${issue.message} (at ${issue.path.map((part) => String(part.key)).join('.')})`
    })
    .join('; ')
  return new Error(
    `Arguments for tool "${name}" do not match the required schema: ${summary}. Call the tool again with corrected arguments.`,
  )
}

/** SDK boundary races even signal-deaf work; late settlements are consumed by awaitWithContext. */
export function executeCall<A>(
  run: (signal: AbortSignal) => Promise<A>,
  context: Context,
  deadline: { readonly name: string; readonly timeoutMs?: number },
): Promise<A> {
  const parent =
    context.abortSignal === undefined ? new AbortController().signal : context.abortSignal
  if (parent.aborted)
    return Promise.reject(new DOMException('The operation was aborted', 'AbortError'))
  if (deadline.timeoutMs === undefined)
    return awaitWithContext(
      Promise.resolve().then(() => {
        parent.throwIfAborted()
        return run(parent)
      }),
      withAbortSignal(parent, context),
    )
  const expiry = new AbortController()
  const timeoutMs = deadline.timeoutMs
  const timer = setTimeout(
    () => expiry.abort(new DOMException('Deadline exceeded', 'TimeoutError')),
    timeoutMs,
  )
  const signal = AbortSignal.any([parent, expiry.signal])
  return awaitWithContext(
    Promise.resolve().then(() => {
      signal.throwIfAborted()
      return run(signal)
    }),
    withAbortSignal(signal, context),
  )
    .catch((failure) => {
      if (expiry.signal.aborted && !parent.aborted)
        throw new ToolDeadline({
          message: `Tool "${deadline.name}" timed out after ${timeoutMs}ms`,
        })
      throw failure
    })
    .finally(() => clearTimeout(timer))
}

/** Valibot decodes once after Pi's coercion and validation. Plain JSON Schema is
 * accepted by pi-ai's Compile path; converter options match the installed reference exactly.
 * Replay is intentionally omitted, so an unfinished external action is interrupted, never rerun. */
export function defineTool<
  S extends v.GenericSchema,
  E extends { readonly message: string } = never,
>(definition: {
  readonly name: string
  readonly description: string
  readonly input: S
  readonly timeoutMs?: number
  readonly run: (call: {
    readonly data: v.InferOutput<S>
    readonly signal: AbortSignal
    readonly toolCallId: string
  }) =>
    | ToolResult
    | ContentResult
    | Promise<ToolResult | ContentResult>
    | Effect.Effect<ToolResult | ContentResult, E>
}): ToolRegistration & { readonly input: S } {
  const { $schema: _schema, ...json } = toJsonSchema(definition.input, { errorMode: 'ignore' })
  const parameters = Type.Unsafe<v.InferInput<S>>(json)
  const tool = durableTool({
    name: definition.name,
    description: definition.description,
    parameters,
    // Vivid and the Computer tools already bound their output exactly as main did. Pi's generic
    // UTF-8/line cutoff would truncate run_code or change the reference character-count budget.
    outputLimits: { maxBytes: Number.MAX_SAFE_INTEGER, maxLines: Number.MAX_SAFE_INTEGER },
    execute(args, api, context) {
      const parsed = v.safeParse(definition.input, args)
      if (!parsed.success)
        return Promise.resolve({
          output: [{ type: 'text', text: invalid(definition.name, parsed.issues).message }],
          isError: true,
        })
      return executionResult(
        executeCall(
          (signal) => {
            const result = definition.run({ data: parsed.output, signal, toolCallId: api.callId })
            if (!Effect.isEffect(result))
              return Promise.resolve(result).then((value) => toolResult(definition.name, value))
            // The Pi execute callback is the Promise entry point for the owned Computer programs.
            // oxlint-disable-next-line vivid/no-runpromise-in-library -- Pi requires a Promise; domain programs remain Effect values up to this adapter.
            return Effect.runPromise(
              result.pipe(
                Effect.map((value) => toolResult(definition.name, value)),
                Effect.catch((failure) => Effect.succeed(errorResult(failure.message))),
              ),
              { signal },
            )
          },
          context,
          definition,
        ),
        context,
      )
    },
  })
  // Input remains available for existing schema inspection; the executable surface is Pi's.
  return Object.assign(tool, { input: definition.input })
}
