import {
  ComputerScreen,
  ComputerSession,
  computerScreenAddress,
  type NoDeviceConnected,
  type ProjectChanged,
  type ProjectEvidenceMissing,
  type ProjectNotActive,
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
import { modelText } from './views.ts'
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
  /** Only Computer tools supply a source; Person receipts cannot advertise the cloud viewer. */
  readonly computer?: 'person' | 'vivid'
  readonly terminate?: boolean
}

export type ToolFailure =
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

/** Product failures are safe sentences; driver payloads and supplied credentials never escape. */
function failure(message: string) {
  return Effect.succeed<ToolResult>({
    output: { ok: false, message: modelText(message) },
    terminate: false,
  })
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
      NoDeviceConnected: () => failure('The Person’s computer is not connected.'),
      NameMissing: ({ name }) => failure(`Nothing here is called “${name}”; list them again.`),
      NameAmbiguous: ({ name, matches }) =>
        failure(`More than one match for “${name}”: ${matches.join(', ')}; list them again.`),
      RpcClientError: () =>
        failure('Vivid cannot reach its server right now; try again in a moment.'),
      ConfigError: () => failure('Vivid cannot reach its server right now; try again in a moment.'),
      NobodyToActFor: () => failure('There is no person behind this message to act for.'),
      MemoryConflict: ({ address, actual }) =>
        failure(
          `The ${address.layer}/${address.file} revision changed to ${actual}. Read it before replacing or retracting it.`,
        ),
      MemoryMissing: ({ address, revision }) =>
        failure(
          `You have no entry at ${address.layer}/${address.file}. Its current revision is ${revision}; use this revision only if intentionally creating it.`,
        ),
      MemoryUnavailable: () =>
        failure(
          'Your memory cannot be read or changed right now; say so, and do not claim it is saved.',
        ),
      MemorySearchInvalid: () =>
        failure(
          'The memory search expression is invalid. Use FTS5 words, quoted phrases or prefix* and correct any unmatched quotes.',
        ),
      ProjectChanged: ({ actual }) =>
        failure(
          `The Project changed to revision ${actual}. Read it with read_project before updating it.`,
        ),
      ProjectNotActive: () =>
        failure(
          'The Project has no objective in progress. Define its objective and next step first.',
        ),
      ProjectEvidenceMissing: () =>
        failure(
          'Nothing in this conversation shows the Project is done. Mark it done only once the Person has said so or this reply has observed it.',
        ),
      NotFound: () => failure('It does not exist or the person cannot see it.'),
      Forbidden: () => failure('The person is not allowed to do that here.'),
      Unauthenticated: () => failure('The person needs to sign in before Vivid can do that.'),
      Conflict: () =>
        failure('The request conflicts with the current state; check it before trying again.'),
      // The server words every InvalidRequest itself, for the reader of the call that met it: it
      // says what was wrong and what to do ("Authorize this integration before continuing.",
      // "Use only the filters find_events lists."). A fixed sentence here left the model
      // guessing (production, 26 October 2026: eight find_tools calls in a row). modelText still
      // keeps any reference out of model context.
      InvalidRequest: ({ message }) => failure(message),
      ServiceUnavailable: () => failure('That part of Vivid is not available right now.'),
      RuntimeUnavailable: () => failure('Vivid cannot start that work right now.'),
      DatabaseUnavailable: () => failure('Vivid cannot reach its saved records right now.'),
      DatabaseConstraintViolation: () =>
        failure('The request conflicts with Vivid’s saved records.'),
      DatabaseFailure: () => failure('Vivid could not read or save that record right now.'),
    }),
  )
  return {
    output: modelOutput(result.output, tool, Option.fromUndefinedOr(result.computer)),
    terminate: result.terminate === true,
  }
})
