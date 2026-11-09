import {
  IntegrationForm,
  IntegrationRequestId,
  IntegrationPause,
  IntegrationResponse,
  IntegrationSavedCall,
} from '@vivid/contracts'
import { Effect, Option, Schema } from 'effect'
import { HttpClient, HttpClientRequest } from 'effect/http'
import { ExecutorResponseInvalid, ExecutorTransportFailure } from './executor.ts'

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
    Schema.Struct({ ok: Schema.Literal(false), error: Schema.Struct({ message: Schema.String }) }),
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
const decodeEnvelope = Schema.decodeUnknownOption(Schema.fromJsonString(envelope))
const callResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Json }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.Struct({ message: Schema.String }) }),
])

export const McpCallOutcome = Schema.TaggedUnion({
  Completed: { value: Schema.Json },
  Paused: { pause: IntegrationPause },
  Expired: {},
  Uncertain: {},
})
export type McpCallOutcome = typeof McpCallOutcome.Type

const decodeCallResult = Schema.decodeUnknownEffect(callResult)

/** Stateless MCP keeps the execution under the authenticated caller, so a new HTTP session can resume it.
 * beta.23 mcp/server.ts binds model executions to that caller, not to a protocol session. No retry is safe here.
 */
export function mcpCalls(client: HttpClient.HttpClient) {
  return Effect.fn('Executor.mcp')(function* (name: 'call' | 'resume', input: Schema.JsonObject) {
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
    const body = yield* response.text.pipe(
      Effect.mapError(() => ExecutorTransportFailure.make({ service: 'connections', tool: null })),
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
    const parsed = payloads.map((payload) => decodeEnvelope(payload)).find(Option.isSome)
    if (parsed === undefined)
      return yield* ExecutorResponseInvalid.make({ service: 'connections', tool: null })
    return yield* project(parsed.value.result.structuredContent)
  }, Effect.scoped)
}

/** A single call has one ordered result; a pause preserves the whole saved request. */
const project = Effect.fn('Executor.mcpOutcome')(function* (
  value: typeof result.Type,
): Effect.fn.Return<McpCallOutcome, ExecutorResponseInvalid> {
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
      return McpCallOutcome.cases.Paused.make({
        pause: IntegrationPause.cases.Input.make({
          requestId: value.requestId,
          expiresAt: value.expiresAt,
          form: value.elicitation,
        }),
      })
    case 'unavailable':
      return McpCallOutcome.cases.Expired.make({})
    case 'busy':
    case 'capacity-exceeded':
      return McpCallOutcome.cases.Uncertain.make({})
    case 'completed': {
      if (!value.execution.ok) return McpCallOutcome.cases.Uncertain.make({})
      const call = yield* decodeCallResult(value.execution.value).pipe(
        Effect.mapError(() => ExecutorResponseInvalid.make({ service: 'connections', tool: null })),
      )
      return call.ok
        ? McpCallOutcome.cases.Completed.make({ value: call.value })
        : McpCallOutcome.cases.Uncertain.make({})
    }
  }
})

/** Keep accepted form values encoded as the protocol expects at egress. */
export const encodeIntegrationResponse = Schema.encodeEffect(IntegrationResponse)
