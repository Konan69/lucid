import {
  type ActionReceipt,
  type ActionReconciliationRequired,
  ComputerScreen,
  type ArtifactNotEditable,
  type ArtifactFileRefused,
  type ArtifactFileTooLarge,
  type ArtifactComputerUnavailable,
  type ArtifactRenderUnsupported,
  type ArtifactRenderFailed,
  type ArtifactInspectionStale,
  ComputerSession,
  CoverageReason,
  ResultCoverage,
  type IntegrationResult,
  computerScreenAddress,
  type MemoryForgetStale,
  type NoDeviceConnected,
  type ProjectChanged,
  type ProjectEvidenceMissing,
  type ProjectNotActive,
  type WatchRunRequired,
  type WatchEndConditionRequired,
  type CheckinNotFound,
  type CheckinNotScheduled,
  type OwedResultUndelivered,
} from '@vivid/contracts'
import type { RpcFailure } from '@vivid/contracts/rpc'
import * as Config from 'effect/Config'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Predicate from 'effect/Predicate'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import type * as RpcClientError from 'effect/rpc/RpcClientError'
import { modelText, plain, quiet, refused, translate, type Plain } from './views.ts'
import type { NameMissing, NameAmbiguous } from './names.ts'
import type { NobodyToActFor } from '../client.ts'
import type {
  MemoryConflict,
  MemoryMissing,
  MemoryUnavailable,
  MemorySearchInvalid,
} from '../memory.ts'

export interface ToolResult {
  readonly output: Schema.Json
  readonly integration?: IntegrationResult
  /** Only Computer tools supply a source; Person receipts cannot advertise the cloud viewer. */
  readonly computer?: 'person' | 'vivid'
  readonly terminate?: boolean
  /**
   * The server's receipts for the outward writes this call sent. They are kept in the result's
   * metadata beside the output and never in the model's words: operation ids are references the
   * model has no use for. Only tools that send outward writes supply them.
   */
  readonly receipts?: ReadonlyArray<ActionReceipt>
}

export type ToolFailure =
  | ActionReconciliationRequired
  | ArtifactNotEditable
  | ArtifactFileRefused
  | ArtifactFileTooLarge
  | ArtifactComputerUnavailable
  | ArtifactRenderUnsupported
  | ArtifactRenderFailed
  | ArtifactInspectionStale
  | CheckinNotFound
  | CheckinNotScheduled
  | OwedResultUndelivered
  | WatchRunRequired
  | WatchEndConditionRequired
  | NoDeviceConnected
  | NameMissing
  | NameAmbiguous
  | RpcFailure
  | NobodyToActFor
  | MemoryConflict
  | MemoryMissing
  | MemoryUnavailable
  | MemorySearchInvalid
  | ProjectChanged
  | ProjectNotActive
  | ProjectEvidenceMissing
  | MemoryForgetStale
  | RpcClientError.RpcClientError
  | Config.ConfigError

interface BoundedOutput {
  readonly value: Schema.Json
  readonly truncated: boolean
}

/** Existing model-visible text budget; memory reads page to this limit instead of limiting storage. */
export const TOOL_TEXT_LIMIT = 4000
/** Existing list output budget; retrieval pages must fit without losing their continuation. */
export const TOOL_LIST_LIMIT = 25

/** Each nested list and text is bounded; its containing object records any lost content. */
function bounded(value: Schema.Json): BoundedOutput {
  if (Predicate.isString(value))
    return { value: value.slice(0, TOOL_TEXT_LIMIT), truncated: value.length > TOOL_TEXT_LIMIT }
  if (isList(value)) {
    const items = value.slice(0, TOOL_LIST_LIMIT).map(bounded)
    return {
      value: items.map((item) => item.value),
      truncated: value.length > TOOL_LIST_LIMIT || items.some((item) => item.truncated),
    }
  }
  if (!isObject(value)) return { value, truncated: false }
  return boundedRecord(value)
}

/** Records preserve their object shape and flag any nested loss, including document metadata. */
function boundedRecord(value: Schema.JsonObject) {
  const entries = Object.entries(value).map(([key, entry]) => [key, bounded(entry)] as const)
  const truncated = entries.some(([, entry]) => entry.truncated)
  const result: Record<string, Schema.Json> = Object.fromEntries(
    entries.map(([key, entry]) => [key, entry.value]),
  )
  if (truncated) result.truncated = true
  return { value: result, truncated }
}

/** The JSON union includes readonly arrays; this guard retains their typed elements. */
function isList(value: Schema.Json): value is Schema.JsonArray {
  return Array.isArray(value)
}

/** A typed JSON record guard retains the value contract rather than widening entries to unknown. */
function isObject(value: Schema.Json): value is Schema.JsonObject {
  return Predicate.isObject(value) && !isList(value)
}

/** Scalar and list roots need a containing object to make truncation explicit to the model. */
export function boundOutput(value: Schema.Json): Schema.Json {
  const result = bounded(value)
  if (!result.truncated || (Predicate.isObject(result.value) && !isList(result.value))) {
    return result.value
  }
  return { value: result.value, truncated: true }
}

/** Evidence is never clipped alongside payload. Delivered coverage records clipping and retains source coverage. */
export function boundIntegrationOutput(
  output: Schema.Json,
  result: IntegrationResult,
): Schema.Json {
  const payload = bounded(output)
  const query = ResultCoverage.match(result.coverage, {
    Complete: (entry) => entry.query,
    Partial: (entry) => entry.query,
    Unknown: (entry) => entry.query,
    NotRead: () => null,
    NotApplicable: () => null,
  })
  const coverage = payload.truncated
    ? ResultCoverage.cases.Partial.make({
        query,
        reasons: ResultCoverage.guards.Partial(result.coverage)
          ? [...result.coverage.reasons, CoverageReason.cases.OutputClipped.make({})]
          : [CoverageReason.cases.OutputClipped.make({})],
      })
    : result.coverage
  const value = payload.value
  if (!isObject(value))
    return {
      output: value,
      coverage,
      sourceCoverage: result.coverage,
      asOf: result.asOf,
      observedAt: result.observedAt,
    }
  return Object.fromEntries([
    ...Object.entries(value),
    ['coverage', coverage],
    ['sourceCoverage', result.coverage],
    ['asOf', result.asOf],
    ['observedAt', result.observedAt],
  ])
}

/** Document bodies have their own reading budget; metadata and every other tool retain the ordinary limits. */
function boundDocument(value: Schema.Json): Schema.Json {
  if (!isObject(value) || !Predicate.isString(value.body)) return boundOutput(value)
  const { body, ...metadata } = value
  const fields = boundedRecord(metadata).value
  if (body.length <= 48_000) return { ...fields, body }
  const characters = Predicate.isNumber(fields.characters) ? fields.characters : body.length
  return {
    ...fields,
    body: body.slice(0, 48_000),
    truncated: true,
    characters,
    message: `This document has ${characters} characters in all. Only the first 48,000 characters are shown; this is not the whole document.`,
  }
}

/**
 * A saved procedure is followed step by step, so its instructions are read whole: one cut at the
 * ordinary 4,000-character limit drops the steps and rules at its end, which a Person taught it
 * last. Saving caps them at 20,000 characters (`SaveSkillRequest`), which bounds this read;
 * every other field keeps the ordinary limits.
 */
function boundProcedure(value: Schema.Json): Schema.Json {
  if (!isObject(value) || !Predicate.isString(value.instructions)) return boundOutput(value)
  const { instructions, ...fields } = value
  return { ...boundedRecord(fields).value, instructions }
}

/** Product failures are safe sentences, one for Vivid and one for the Person (`refused`); driver
 * payloads and supplied credentials never escape. */
function failure(message: string, tellThem: Plain) {
  return Effect.succeed<ToolResult>({ output: refused(message, tellThem), terminate: false })
}

/** Only tool identity and the declared failure tag reach logs; payloads and causes stay private. */
export const warnFailure = (tool: string, tag: string) =>
  Effect.logWarning(`Tool failed tool=${tool} tag=${tag}`)

const computerTools = new Set(['browse', 'use_desktop'])
/**
 * The one receipt every Computer tool result carries, as the wire holds it. It is the same value
 * for every call, so it is encoded once at load. Were the contract changed until this value no
 * longer fitted it, the runtime must not start and hand out results without the receipt: the
 * schema's own error ends the load.
 */
const session = Result.getOrThrow(
  Schema.encodeResult(ComputerSession)(
    ComputerSession.make({
      active: true,
      screen: ComputerScreen.cases.Relay.make({ address: computerScreenAddress }),
    }),
  ),
)

/** Only a successful Computer operation proves an active session. Pi's enclosing submission
 * identifies the Thread/Run; the receipt adds no owner handle or provider authority. The relay
 * checks the viewer's own cookie again, including when this receipt is read in a shared Thread.
 */
function withComputer(
  output: Schema.Json,
  tool: string,
  computer: Option.Option<'person' | 'vivid'>,
): Schema.Json {
  return !Option.contains(computer, 'person') &&
    computerTools.has(tool) &&
    isObject(output) &&
    output.ok === true
    ? Object.fromEntries([...Object.entries(output), ['computer', session]])
    : output
}

/** The server bounds programs to 32 KiB, including logs and up to 100 receipts; preserve that result. */
function modelOutput(
  output: Schema.Json,
  tool: string,
  computer: Option.Option<'person' | 'vivid'>,
): Schema.Json {
  if (tool === 'run_code') return output
  if (tool === 'read_document') return boundDocument(output)
  if (tool === 'read_skill') return boundProcedure(output)
  return boundOutput(withComputer(output, tool, computer))
}

/** Only declared product failures are recovered; transport and configuration have fixed safe wording; defects propagate. */
export const settle = Effect.fn('Tools.settle')(function* (
  program: Effect.Effect<ToolResult, ToolFailure>,
  tool: string,
) {
  const result = yield* program.pipe(
    Effect.tapCause((cause) => {
      const error = Cause.findErrorOption(cause)
      const tag = Option.match(error, {
        onSome: (declared) => declared._tag,
        onNone: () => (Cause.hasDies(cause) ? 'Defect' : 'Interrupted'),
      })
      return warnFailure(tool, tag)
    }),
    Effect.catchTags({
      // The exact act was sent earlier in this Thread and its result is not known. Sending it
      // again could do it twice, so the server refused; the model is told not to retry.
      ActionReconciliationRequired: () =>
        failure(
          'The same action was sent before in this Thread and its result is not known yet, so it was not sent again. Do not retry it; tell the Person its result is not known yet.', plain("i'm not sure that went through yet, so i haven't sent it again.")),
      ArtifactNotEditable: () =>
        failure(
          'This is a file. Revise its editable source on the Computer, inspect it and publish a new version.', quiet),
      ArtifactFileRefused: ({ role, reason }) =>
        failure(
          `The ${role} file could not be captured (${reason}). Fix the path or file before inspecting again.`, quiet),
      ArtifactFileTooLarge: ({ role, limit }) =>
        failure(`The ${role} file exceeds the ${limit}-byte limit.`, plain("that file's too big for me to take.")),
      ArtifactComputerUnavailable: ({ message }) => failure(message, plain("my computer isn't available right now, so i couldn't make the file.")),
      ArtifactRenderUnsupported: ({ message }) => failure(message, plain("i can't show that kind of file here.")),
      ArtifactRenderFailed: ({ message }) => failure(message, plain("i couldn't open that file to show you.")),
      ArtifactInspectionStale: () =>
        failure(
          'That inspection is absent, belongs to another response or was already published. Inspect the file again.', quiet),
      CheckinNotFound: ({ message }) => failure(message, quiet),
      CheckinNotScheduled: ({ message }) => failure(message, plain("i couldn't set that reminder, so it won't come up on its own.")),
      OwedResultUndelivered: ({ message }) => failure(message, quiet),
      WatchRunRequired: ({ message }) => failure(message, quiet),
      WatchEndConditionRequired: ({ message }) => failure(message, quiet),
      NoDeviceConnected: () => failure('The Person’s computer is not connected.', plain("your computer isn't connected to me right now. open the vivid app on it and i can try again.")),
      NameMissing: ({ name }) => failure(`Nothing here is called “${name}”; list them again.`, quiet),
      NameAmbiguous: ({ name, matches }) =>
        failure(`More than one match for “${name}”: ${matches.join(', ')}; list them again.`, quiet),
      RpcClientError: () =>
        failure('Vivid cannot reach its server right now; try again in a moment.', plain("something went wrong on my side. try me again in a minute.")),
      ConfigError: () => failure('Vivid cannot reach its server right now; try again in a moment.', plain("something went wrong on my side. try me again in a minute.")),
      NobodyToActFor: () => failure('There is no person behind this message to act for.', plain("something went wrong with that message. could you send it again?")),
      MemoryConflict: ({ address, actual }) =>
        failure(
          actual === 0
            ? `No entry has been written at ${address.layer}/${address.file}. To create it, omit expected_revision or use 0.`
            : `The ${address.layer}/${address.file} revision changed to ${actual}. Read that exact file and use its revision before replacing or retracting it.`, quiet),
      MemoryMissing: ({ address, revision }) =>
        failure(
          `You have no entry at ${address.layer}/${address.file}. Its current revision is ${revision}; use this revision only if intentionally creating it.`, quiet),
      MemoryUnavailable: () =>
        failure(
          'Your memory cannot be read or changed right now; say so, and do not claim it is saved.', plain("i can't remember things right now, so this isn't saved yet.")),
      MemorySearchInvalid: () =>
        failure(
          'The memory search expression is invalid. Use FTS5 words, quoted phrases or prefix* and correct any unmatched quotes.', quiet),
      ProjectChanged: ({ actual }) =>
        failure(
          `The Project changed to revision ${actual}. Read it with read_project before updating it.`, quiet),
      ProjectNotActive: () =>
        failure(
          'The Project has no objective in progress. Define its objective and next step first.', quiet),
      ProjectEvidenceMissing: () =>
        failure(
          'Nothing in this conversation shows the Project is done. Mark it done only once the Person has said so or this reply has observed it.', quiet),
      MemoryForgetStale: () =>
        failure(
          'Memory changed since you planned this forget. Read the entries again and make a new plan; nothing was changed.', quiet),
      NotFound: () => failure('It does not exist or the person cannot see it.', plain("i can't find that, or it isn't shared with you.")),
      Forbidden: () => failure('The person is not allowed to do that here.', plain("you don't have permission to do that here.")),
      Unauthenticated: () => failure('The person needs to sign in before Vivid can do that.', plain("you'll need to sign in again before i can do that.")),
      Conflict: () =>
        failure('The request conflicts with the current state; check it before trying again.', plain("that changed while i was working on it. let me look again.")),
      // The server words every InvalidRequest itself, for the reader of the call that met it: it
      // says what was wrong and what to do ("Authorize this integration before continuing.",
      // "Use only the filters find_events lists."). A fixed sentence here left the model
      // guessing (production, 26 October 2026: eight find_tools calls in a row). modelText still
      // keeps any reference out of model context.
      InvalidRequest: ({ message }) => failure(message, translate),
      ServiceUnavailable: () => failure('That part of Vivid is not available right now.', plain("that isn't working on my side right now.")),
      RuntimeUnavailable: () => failure('Vivid cannot start that work right now.', plain("i can't start that right now.")),
      DatabaseUnavailable: () => failure('Vivid cannot reach its saved records right now.', plain("something went wrong on my side and i couldn't save that.")),
      DatabaseConstraintViolation: () =>
        failure('The request conflicts with Vivid’s saved records.', plain("that clashes with something already saved.")),
      DatabaseFailure: () => failure('Vivid could not read or save that record right now.', plain("something went wrong on my side and i couldn't save that.")),
    }),
  )
  const output =
    result.integration === undefined
      ? modelOutput(result.output, tool, Option.fromUndefinedOr(result.computer))
      : boundIntegrationOutput(result.output, result.integration)
  const terminate = result.terminate === true
  return result.receipts === undefined
    ? { output, terminate }
    : { output, terminate, receipts: result.receipts }
})
