import type { FetchFunction } from '@earendil-works/pi-ai'
import { Effect, Option, Result, Schema } from 'effect'

// Decode structural fields only. The request record selects counts from tool lists rather than
// serializing the decoded payload; message content and tool arguments never enter that record.
const Message = Schema.Struct({
  role: Schema.Literals(['system', 'developer', 'user', 'assistant', 'tool', 'function']),
  tool_calls: Schema.optionalKey(Schema.Array(Schema.Struct({}))),
  isError: Schema.optionalKey(Schema.Boolean),
  is_error: Schema.optionalKey(Schema.Boolean),
})
const Payload = Schema.fromJsonString(
  Schema.Struct({
    model: Schema.String,
    messages: Schema.Array(Message),
    tools: Schema.optionalKey(Schema.Array(Schema.Struct({}))),
    stream: Schema.optionalKey(Schema.Boolean),
  }),
)
const decodePayload = Schema.decodeEffect(Payload)
const RequestRecord = Schema.TaggedUnion({
  Decoded: {
    bytes: Schema.Int,
    model: Schema.String,
    messages: Schema.Int,
    roles: Schema.String,
    tools: Schema.Int,
    stream: Schema.Union([Schema.Boolean, Schema.Literal('unset')]),
  },
  Undecoded: { bytes: Schema.Int },
})
const Body = Schema.TaggedUnion({
  Read: { excerpt: Schema.String, empty: Schema.Boolean },
  Unreadable: {},
  Uninspected: {},
})
const Outcome = Schema.TaggedUnion({
  Returned: { response: Schema.instanceOf(Response) },
  RetriedThenReturned: { response: Schema.instanceOf(Response) },
})

class RequestUnreadable extends Schema.TaggedError<RequestUnreadable>()(
  'RequestUnreadable',
  {},
  { title: 'Provider request body unreadable' },
) {}
class ResponseUnreadable extends Schema.TaggedError<ResponseUnreadable>()(
  'ResponseUnreadable',
  {},
  { title: 'Provider response body unreadable' },
) {}
class FetchFailed extends Schema.TaggedError<FetchFailed>()(
  'FetchFailed',
  { cause: Schema.Defect() },
  { title: 'Provider fetch failed' },
) {}

const roles = {
  system: 's',
  developer: 'd',
  user: 'u',
  assistant: 'a',
  tool: 't',
  function: 'f',
} satisfies Record<typeof Message.Type.role, string>

/** Error flags are metadata only: Pi 0.87.1 drops isError when it converts tool results. */
function roleOf(message: typeof Message.Type) {
  const count = Option.match(Option.fromUndefinedOr(message.tool_calls), {
    onNone: () => 0,
    onSome: (calls) => calls.length,
  })
  const calls = count > 0 ? `(${count})` : ''
  const error = message.isError === true || message.is_error === true ? '!' : ''
  return `${roles[message.role]}${calls}${error}`
}

/** Count actual wire bytes, decode JSON once, and never expose a decoder's rejected values. */
const describeRequest = Effect.fn('Provider.describeRequest')(function* (request: Request) {
  const bytes = yield* Effect.tryPromise({
    try: () => request.clone().arrayBuffer(),
    catch: () => new RequestUnreadable(),
  })
  const decoded = yield* decodePayload(new TextDecoder().decode(bytes)).pipe(Effect.option)
  return Option.match(decoded, {
    onNone: () => RequestRecord.cases.Undecoded.make({ bytes: bytes.byteLength }),
    onSome: (payload) =>
      RequestRecord.cases.Decoded.make({
        bytes: bytes.byteLength,
        model: payload.model,
        messages: payload.messages.length,
        roles: payload.messages.map(roleOf).join(' '),
        tools: Option.match(Option.fromUndefinedOr(payload.tools), {
          onNone: () => 0,
          onSome: (tools) => tools.length,
        }),
        stream: Option.getOrElse(Option.fromUndefinedOr(payload.stream), () => 'unset' as const),
      }),
  })
})

const identifiers = new Set([
  'x-request-id',
  'request-id',
  'cf-ray',
  'retry-after',
  'content-type',
  'content-length',
])

/** Allow only response correlation and retry metadata; request headers are never inspected. */
function headersOf(response: Response) {
  return Object.fromEntries(
    [...response.headers].filter(
      ([name]) => identifiers.has(name) || name.startsWith('x-opencode-'),
    ),
  )
}

/** A clone leaves Pi's response unread; failed inspection is never evidence of an empty body. */
const bodyOf = Effect.fn('Provider.body')(function* (response: Response) {
  return yield* Effect.tryPromise({
    try: () => response.clone().text(),
    catch: () => new ResponseUnreadable(),
  }).pipe(
    Effect.map((text) =>
      Body.cases.Read.make({ excerpt: text.slice(0, 2048), empty: text.length === 0 }),
    ),
    Effect.catchTag('ResponseUnreadable', () => Effect.succeed(Body.cases.Unreadable.make({}))),
  )
})

/** One JSON message keeps each HTTP attempt searchable without logging the private request. */
const record = Effect.fn('Provider.witness')(function* (input: {
  readonly response: Response
  readonly body: typeof Body.Type
  readonly metadata: typeof RequestRecord.Type
  readonly attempt: 1 | 2
}) {
  yield* Effect.logWarning(
    JSON.stringify({
      event: 'ProviderWitness',
      attempt: input.attempt,
      status: input.response.status,
      headers: headersOf(input.response),
      body: Body.match(input.body, {
        Read: ({ excerpt }) => excerpt,
        Unreadable: () => '[unreadable]',
        Uninspected: () => '[not-read]',
      }),
      request: input.metadata,
    }),
  )
})

/** The fetch is Pi's public transport, not an Effect HTTP client; preserve its network failure. */
const fetchResponse = (transport: FetchFunction, request: Request) =>
  Effect.tryPromise({
    try: () => transport(request.clone()),
    catch: (cause) => new FetchFailed({ cause }),
  })

/** Only an empty 400 is replayed, once, before Pi can start consuming assistant output. */
const send = Effect.fn('Provider.send')(function* (transport: FetchFunction, request: Request) {
  const response = yield* fetchResponse(transport, request)
  if (response.status < 400) return Outcome.cases.Returned.make({ response })
  const metadata = yield* describeRequest(request)
  const body = yield* bodyOf(response)
  yield* record({ response, metadata, body, attempt: 1 })
  if (response.status !== 400 || !Body.guards.Read(body) || !body.empty) {
    return Outcome.cases.Returned.make({ response })
  }
  yield* Effect.sleep('300 millis')
  const retried = yield* fetchResponse(transport, request)
  const nextBody = retried.status >= 400 ? yield* bodyOf(retried) : Body.cases.Uninspected.make({})
  yield* record({ response: retried, metadata, body: nextBody, attempt: 2 })
  return Outcome.cases.RetriedThenReturned.make({ response: retried })
})

/**
 * Pi 0.87.1 requires a Promise-returning FetchFunction. This is the sole execution boundary;
 * Effect owns decoding, witnessing and the interruptible wait. Keep a pristine Request for
 * replay, including Request-bodied callers, and bind the entire operation to its AbortSignal.
 * Network errors return to Pi unchanged so its existing connection/server retry budget owns them.
 */
export function witness(transport: FetchFunction): FetchFunction {
  return (input, init) => {
    const request = new Request(input, init)
    // oxlint-disable-next-line vivid/no-runpromise-in-library -- This is the single Pi transport boundary, classified exactly by the Effect boundary audit.
    return Effect.runPromise(send(transport, request).pipe(Effect.result), {
      signal: request.signal,
    }).then(
      Result.match({
        onSuccess: Outcome.match({
          Returned: ({ response }) => response,
          RetriedThenReturned: ({ response }) => response,
        }),
        // Restore the transport's rejection only after leaving Effect's typed failure channel.
        onFailure: (failure) =>
          Promise.reject(failure instanceof FetchFailed ? failure.cause : failure),
      }),
    )
  }
}
