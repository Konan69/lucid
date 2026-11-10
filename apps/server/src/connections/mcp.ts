import * as SchemaRepresentation from 'effect/SchemaRepresentation'
import {
  IntegrationForm,
  IntegrationRequestId,
  IntegrationPause,
  IntegrationResponse,
  IntegrationSavedCall,
} from '@vivid/contracts'
import { Effect, Option, Schema, Result } from 'effect'
import { HttpClient, HttpClientRequest } from 'effect/http'
import {
  ExecutorAccessDenied,
  ExecutorResponseInvalid,
  ExecutorTransportFailure,
  mcpFailure,
  type ExecutorFailure,
} from './executor.ts'

const failureResponse = Schema.Struct({
  code: Schema.String,
  status: Schema.Finite,
  message: Schema.optionalKey(Schema.String),
  problems: Schema.optionalKey(Schema.Json),
  retryable: Schema.optionalKey(Schema.Boolean),
  recovery: Schema.optionalKey(Schema.Json),
})
const decodeProblems = Schema.decodeUnknownOption(Schema.Array(Schema.String))
const diagnostic = Schema.Struct({
  kind: Schema.String,
  message: Schema.String,
  response: Schema.optionalKey(failureResponse),
})
const rpcError = Schema.Struct({
  error: Schema.Struct({ code: Schema.Finite, data: Schema.optionalKey(Schema.Json) }),
})
const decodeFailureResponse = Schema.decodeUnknownOption(failureResponse)
const decodeRpcError = Schema.decodeUnknownOption(Schema.fromJsonString(rpcError))

const pending = Schema.Union([
  Schema.Struct({
    status: Schema.Literal('approval-required'),
    requestId: IntegrationRequestId,
    expiresAt: Schema.Finite,
    elicitation: IntegrationForm,
    invocation: IntegrationSavedCall,
  }),
  Schema.Struct({
    status: Schema.Literal('input-required'),
    requestId: IntegrationRequestId,
    expiresAt: Schema.Finite,
    elicitation: IntegrationForm,
  }),
]).pipe(Schema.toTaggedUnion('status'))
const completed = Schema.Struct({
  status: Schema.Literal('completed'),
  execution: Schema.Union([
    Schema.Struct({ ok: Schema.Literal(true), value: Schema.Json }),
    Schema.Struct({ ok: Schema.Literal(false), error: diagnostic }),
  ]),
})
const result = Schema.Union([
  pending,
  completed,
  Schema.Struct({ status: Schema.Literal('unavailable'), reason: Schema.String }),
  Schema.Struct({ status: Schema.Literal('busy') }),
  Schema.Struct({ status: Schema.Literal('capacity-exceeded') }),
]).pipe(Schema.toTaggedUnion('status'))
const envelope = Schema.Struct({
  id: Schema.Literal(1),
  result: Schema.Struct({ structuredContent: result }),
})
const decodeInputPause = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      result: Schema.Struct({
        structuredContent: Schema.Struct({ status: Schema.Literal('input-required') }),
      }),
    }),
  ),
)
const decodeEnvelope = Schema.decodeUnknownOption(Schema.fromJsonString(envelope))
const callResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Json }),
  Schema.Struct({ ok: Schema.Literal(false), error: diagnostic }),
])

export const McpCallOutcome = Schema.TaggedUnion({
  Completed: { value: Schema.Json },
  Paused: { pause: IntegrationPause },
  Expired: {},
  Uncertain: {
    reason: Schema.Literals(['ResponseLost', 'InvalidForm']).pipe(
      Schema.withConstructorDefault(Effect.succeed('ResponseLost')),
    ),
  },
})
export type McpCallOutcome = typeof McpCallOutcome.Type

const decodeCallResult = Schema.decodeUnknownEffect(callResult)

/** Stateless MCP keeps the execution under the authenticated caller, so a new HTTP session can resume it.
 * beta.23 mcp/server.ts binds model executions to that caller, not to a protocol session. No retry is safe here.
 */
export function mcpCalls(client: HttpClient.HttpClient) {
  return Effect.fn('Executor.mcp')(
    function* (name: 'call' | 'resume', input: Schema.JsonObject, tool: string | null) {
      const request = HttpClientRequest.post('/mcp').pipe(
        HttpClientRequest.setHeaders({
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2026-07-28',
          'MCP-Method': 'tools/call',
          'MCP-Name': name,
        }),
        HttpClientRequest.bodyText(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name,
              arguments: input,
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientCapabilities': {},
              },
            },
          }),
          'application/json',
        ),
      )
      const response = yield* client
        .execute(request)
        .pipe(
          Effect.mapError(() =>
            ExecutorTransportFailure.make({ service: 'connections', tool: null }),
          ),
        )
      if (response.status === 401)
        return yield* ExecutorAccessDenied.make({ service: 'connections', tool })
      const body = yield* response.text.pipe(
        Effect.mapError(() =>
          ExecutorTransportFailure.make({ service: 'connections', tool: null }),
        ),
      )
      const payloads = Option.exists(
        Option.fromUndefinedOr(response.headers['content-type']),
        (type) => type.includes('text/event-stream'),
      )
        ? body.split(/\r?\n\r?\n/u).map((event) =>
            event
              .split(/\r?\n/u)
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart())
              .join('\n'),
          )
        : [body]
      for (const payload of payloads) {
        const refusal = decodeRpcError(payload)
        if (Option.isSome(refusal)) {
          const detail = decodeFailureResponse(refusal.value.error.data)
          if (Option.isSome(detail))
            return yield* mcpFailure(detail.value.code, tool, validationDetail(detail.value))
          // Parse/invalid-request/invalid-params and unknown-method codes precede tool dispatch.
          if ([-32700, -32600, -32601, -32602, -32020].includes(refusal.value.error.code))
            return yield* mcpFailure('RequestInvalid', tool, [])
          return McpCallOutcome.cases.Uncertain.make({})
        }
      }
      const parsed = payloads.map((payload) => decodeEnvelope(payload)).find(Option.isSome)
      if (
        parsed === undefined &&
        payloads.some((payload) => Option.isSome(decodeInputPause(payload)))
      )
        return McpCallOutcome.cases.Uncertain.make({ reason: 'InvalidForm' })
      if (parsed === undefined)
        return yield* ExecutorResponseInvalid.make({ service: 'connections', tool: null })
      return yield* project(parsed.value.result.structuredContent, tool)
    },
    (effect) =>
      effect.pipe(
        Effect.scoped,
        // The SQL answer claim stays protected, but its HTTP child must be cancellable by this deadline.
        Effect.interruptible,
        Effect.timeoutOrElse({
          duration: '90 seconds',
          orElse: () =>
            Effect.fail(ExecutorTransportFailure.make({ service: 'connections', tool: null })),
        }),
      ),
  )
}

/** A single call has one ordered result; a pause preserves the whole saved request. */
const project = Effect.fn('Executor.mcpOutcome')(function* (
  value: typeof result.Type,
  tool: string | null,
): Effect.fn.Return<McpCallOutcome, ExecutorFailure> {
  switch (value.status) {
    case 'approval-required':
      return McpCallOutcome.cases.Paused.make({
        pause: IntegrationPause.cases.Approval.make({
          requestId: value.requestId,
          expiresAt: value.expiresAt,
          form: value.elicitation,
          savedCall: value.invocation,
        }),
      })
    case 'input-required':
      const readable = yield* Effect.try({
        try: () =>
          SchemaRepresentation.fromJsonSchemaDocument({
            dialect: 'draft-2020-12',
            schema: value.elicitation.requestedSchema,
            definitions: {},
          }),
        catch: () => ExecutorResponseInvalid.make({ service: 'connections', tool }),
      }).pipe(Effect.result)
      if (Result.isFailure(readable))
        return McpCallOutcome.cases.Uncertain.make({ reason: 'InvalidForm' })
      return McpCallOutcome.cases.Paused.make({
        pause: IntegrationPause.cases.Input.make({
          requestId: value.requestId,
          expiresAt: value.expiresAt,
          form: value.elicitation,
        }),
      })
    case 'unavailable':
      return value.reason === 'answered'
        ? McpCallOutcome.cases.Uncertain.make({})
        : McpCallOutcome.cases.Expired.make({})
    case 'busy':
    case 'capacity-exceeded':
      return McpCallOutcome.cases.Uncertain.make({})
    case 'completed': {
      if (!value.execution.ok) return yield* rejectedCall(value.execution.error, tool)
      const call = yield* decodeCallResult(value.execution.value).pipe(
        Effect.mapError(() => ExecutorResponseInvalid.make({ service: 'connections', tool: null })),
      )
      return call.ok
        ? McpCallOutcome.cases.Completed.make({ value: call.value })
        : yield* rejectedCall(call.error, tool)
    }
  }
})

/** InputInvalid's curated message is the MCP representation of the REST problems array. */
function validationDetail(response: typeof failureResponse.Type) {
  if (response.problems !== undefined)
    return Option.getOrElse(decodeProblems(response.problems), () => [])
  if (response.code !== 'InputInvalid' || response.message === undefined) return []
  const prefix = 'Input failed validation: '
  return response.message.startsWith(prefix)
    ? response.message.slice(prefix.length).split('; ')
    : []
}

/** Unknown failures never become retry permission; known refusal codes use the authoritative mapping. */
const rejectedCall = Effect.fn('Executor.mcpFailure')(function* (
  failure: typeof diagnostic.Type,
  tool: string | null,
) {
  if (failure.kind === 'UnknownTool') return yield* mcpFailure('ToolNotFound', tool, [])
  if (failure.kind !== 'ToolFailure' && failure.kind !== 'ExecutionFailure')
    return McpCallOutcome.cases.Uncertain.make({})
  if (failure.response !== undefined)
    return yield* mcpFailure(failure.response.code, tool, validationDetail(failure.response))
  return McpCallOutcome.cases.Uncertain.make({})
})

/** Keep accepted form values encoded as the protocol expects at egress. */
export const encodeIntegrationResponse = Schema.encodeEffect(IntegrationResponse)
