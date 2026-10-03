import type { NoDeviceConnected } from '@vivid/contracts'
import type { RpcFailure } from '@vivid/contracts/rpc'
import * as Config from 'effect/Config'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Predicate from 'effect/Predicate'
import type * as Schema from 'effect/Schema'
import type * as RpcClientError from 'effect/unstable/rpc/RpcClientError'
import { modelText } from './views.ts'
import type { NameMissing, NameAmbiguous } from './names.ts'
import type { NobodyToActFor } from '../client.ts'

export interface ToolResult {
  readonly output: Schema.Json
  readonly terminate?: boolean
}

export type ToolFailure =
  | NoDeviceConnected
  | NameMissing
  | NameAmbiguous
  | RpcFailure
  | NobodyToActFor
  | RpcClientError.RpcClientError
  | Config.ConfigError

interface BoundedOutput {
  readonly value: Schema.Json
  readonly truncated: boolean
}

/** Each nested list and text is bounded; its containing object records any lost content. */
function bounded(value: Schema.Json): BoundedOutput {
  if (Predicate.isString(value))
    return { value: value.slice(0, 4000), truncated: value.length > 4000 }
  if (isList(value)) {
    const items = value.slice(0, 25).map(bounded)
    return {
      value: items.map((item) => item.value),
      truncated: value.length > 25 || items.some((item) => item.truncated),
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
  return Effect.succeed({ output: { ok: false, message: modelText(message) }, terminate: false })
}

/** Only tool identity and the declared failure tag reach logs; payloads and causes stay private. */
export const warnFailure = (tool: string, tag: string) =>
  Effect.logWarning(`Tool failed tool=${tool} tag=${tag}`)

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
      NoDeviceConnected: () =>
        failure('Your desktop app is not connected. Open it to use your browser.'),
      NameMissing: ({ name }) => failure(`Nothing here is called “${name}”; list them again.`),
      NameAmbiguous: ({ name, matches }) =>
        failure(`More than one match for “${name}”: ${matches.join(', ')}; list them again.`),
      RpcClientError: () =>
        failure('Vivid cannot reach its server right now; try again in a moment.'),
      ConfigError: () => failure('Vivid cannot reach its server right now; try again in a moment.'),
      NobodyToActFor: () => failure('There is no person behind this message to act for.'),
      NotFound: () => failure('It does not exist or the person cannot see it.'),
      Forbidden: () => failure('The person is not allowed to do that here.'),
      Unauthenticated: () => failure('The person needs to sign in before Vivid can do that.'),
      Conflict: () =>
        failure('The request conflicts with the current state; check it before trying again.'),
      InvalidRequest: () => failure('The request is invalid; check the supplied details.'),
      ServiceUnavailable: () => failure('That part of Vivid is not available right now.'),
      RuntimeUnavailable: () => failure('Vivid cannot start that work right now.'),
      DatabaseUnavailable: () => failure('Vivid cannot reach its saved records right now.'),
      DatabaseConstraintViolation: () =>
        failure('The request conflicts with Vivid’s saved records.'),
      DatabaseFailure: () => failure('Vivid could not read or save that record right now.'),
    }),
  )
  return {
    output: tool === 'read_document' ? boundDocument(result.output) : boundOutput(result.output),
    terminate: result.terminate === true,
  }
})
