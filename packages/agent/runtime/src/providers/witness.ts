import type { FetchFunction } from '@earendil-works/pi-ai'
import { Cause, Effect, Exit, Option, Result, Schema } from 'effect'

// Decode structural fields only. The request record selects counts from tool lists rather than
// serializing the decoded payload; message content and tool arguments never enter that record.
const Message = Schema.Struct({
  role: Schema.Literals(['system', 'developer', 'user', 'assistant', 'tool', 'function']),
  tool_calls: Schema.optionalKey(Schema.Array(Schema.Struct({}))),
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
  Undecoded: { bytes: Schema.optionalKey(Schema.Int) },
})
const Body = Schema.TaggedUnion({
  Read: { excerpt: Schema.String, empty: Schema.Boolean },
  Unreadable: {},
  Uninspected: {},
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

/** Pi 0.87.1 sends roles and tool calls, but no tool-result error flag. */
function roleOf(message: typeof Message.Type) {
  const count = Option.match(Option.fromUndefinedOr(message.tool_calls), {
    onNone: () => 0,
    onSome: (calls) => calls.length,
  })
  const calls = count > 0 ? `(${count})` : ''
  return `${roles[message.role]}${calls}`
}

/** Count wire bytes and decode once; unreadable bodies retain honest absence of a byte count. */
const describeRequest = Effect.fn('Provider.describeRequest')(
  function* (request: Request) {
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
  },
  (effect) =>
    effect.pipe(
      Effect.catchTag('RequestUnreadable', () =>
        Effect.succeed(RequestRecord.cases.Undecoded.make({})),
      ),
    ),
)

const identifiers = new Set([
  'x-request-id',
  'request-id',
  'cf-ray',
  'retry-after',
  'content-type',
  'content-length',
])

/** Allow only response correlation and retry metadata; never serialize request headers. */
function headersOf(response: Response) {
  return Object.fromEntries(
    [...response.headers].filter(
      ([name]) => identifiers.has(name) || name.startsWith('x-opencode-'),
    ),
  )
}

/** Scrub the request's own bearer value before truncation, including echoes crossing the limit. */
function scrub(text: string, args: Parameters<FetchFunction>) {
  const [input, init] = args
  const supplied = Option.flatMap(Option.fromUndefinedOr(init), (value) =>
    Option.fromUndefinedOr(value.headers),
  )
  const headers = Option.match(supplied, {
    onNone: () => (input instanceof Request ? input.headers : new Headers()),
    onSome: (value) => new Headers(value),
  })
  const authorization = Option.fromNullOr(headers.get('authorization'))
  return Option.match(authorization, {
    onNone: () => text,
    onSome: (header) => {
      if (!/^Bearer\s+\S/i.test(header)) return text
      return text.replaceAll(header.replace(/^Bearer\s+/i, ''), '[redacted]')
    },
  })
}

/** A clone leaves Pi's response unread; failed inspection never means an empty body. */
const bodyOf = Effect.fn('Provider.body')(function* (
  response: Response,
  args: Parameters<FetchFunction>,
) {
  return yield* Effect.tryPromise({
    try: () => response.clone().text(),
    catch: () => new ResponseUnreadable(),
  }).pipe(
    Effect.map((text) =>
      Body.cases.Read.make({
        excerpt: scrub(text, args).slice(0, 2048),
        empty: text.trim().length === 0,
      }),
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
  const log = input.response.status >= 400 ? Effect.logWarning : Effect.logInfo
  yield* log(
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

/** Pi owns this public transport; preserve its arguments and network failure unchanged. */
const fetchResponse = (transport: FetchFunction, args: Parameters<FetchFunction>) =>
  Effect.tryPromise({
    try: () => transport(...args),
    catch: (cause) => new FetchFailed({ cause }),
  })

/** A consumed Request needs the saved clone; SDK strings retain the original argument tuple. */
function replayOf(
  args: Parameters<FetchFunction>,
  request: Option.Option<Request>,
): Option.Option<Parameters<FetchFunction>> {
  const [input, init] = args
  if (!(input instanceof Request) || input.body === null) return Option.some(args)
  const body = Option.flatMap(Option.fromUndefinedOr(init), (value) =>
    Option.fromNullishOr(value.body),
  )
  if (Option.isSome(body)) return Option.some(args)
  return Option.map(request, (value) => [value])
}

/** Only an empty 400 is replayed, once, before Pi can consume any assistant output. */
const send = Effect.fn('Provider.send')(function* (
  transport: FetchFunction,
  args: Parameters<FetchFunction>,
  request: Option.Option<Request>,
) {
  const response = yield* fetchResponse(transport, args)
  if (response.status < 400) return response
  const metadata = yield* Option.match(request, {
    onNone: () => Effect.succeed(RequestRecord.cases.Undecoded.make({})),
    onSome: describeRequest,
  })
  const body = yield* bodyOf(response, args)
  yield* record({ response, metadata, body, attempt: 1 })
  if (response.status !== 400 || !Body.guards.Read(body) || !body.empty) return response
  // The SDK sends a reusable string body, so both attempts receive the original (input, init).
  // Request bodies are one-shot: keep the inspected clone for the second send. If no clone
  // survived, return the actual refusal rather than replacing it with a consumed-body error.
  const replay = replayOf(args, request)
  if (Option.isNone(replay)) return response
  yield* Effect.sleep('300 millis')
  const retried = yield* fetchResponse(transport, replay.value)
  const nextBody =
    retried.status >= 400 ? yield* bodyOf(retried, args) : Body.cases.Uninspected.make({})
  yield* record({ response: retried, metadata, body: nextBody, attempt: 2 })
  return retried
})

/**
 * Pi requires a Promise-returning FetchFunction, the sole execution boundary. Effect owns the
 * inspection and interruptible wait. Run to Exit so an SDK timeout preserves its AbortError
 * reason: runPromise's generic interruption error would become APIConnectionError instead of
 * APIConnectionTimeoutError in OpenAI 6.40.0. Transport rejections likewise return unchanged.
 */
export function witness(transport: FetchFunction): FetchFunction {
  return (...args) => {
    const [input, init] = args
    // Snapshot before the transport consumes a Request. Failed inspection must never prevent
    // the real fetch; Result keeps constructor failures inside this synchronous SDK boundary.
    const request = Result.getSuccess(
      Result.try({
        try: () => new Request(input instanceof Request ? input.clone() : input, init),
        catch: () => new RequestUnreadable(),
      }),
    )
    const inherited = input instanceof Request ? Option.fromNullishOr(input.signal) : Option.none()
    const supplied = Option.match(Option.fromUndefinedOr(init), {
      onNone: () => inherited,
      onSome: (value) => (value.signal === undefined ? inherited : Option.fromNullOr(value.signal)),
    })
    // Read the effective Request signal, including an init that explicitly clears inheritance.
    // If the body prevented a snapshot, the original arguments still carry abort authority.
    const signal = Option.flatMap(request, (value) => Option.fromNullishOr(value.signal)).pipe(
      Option.orElse(() => supplied),
    )
    // oxlint-disable-next-line vivid/no-runpromise-in-library -- The single Pi transport boundary, classified exactly by the Effect boundary audit.
    return Effect.runPromiseExit(send(transport, args, request), {
      signal: Option.getOrUndefined(signal),
    }).then(
      Exit.match({
        onSuccess: (response) => response,
        onFailure: (cause) => {
          if (Cause.hasInterrupts(cause) && Option.isSome(signal) && signal.value.aborted)
            return Promise.reject(signal.value.reason)
          const failure = Cause.squash(cause)
          return Promise.reject(failure instanceof FetchFailed ? failure.cause : failure)
        },
      }),
    )
  }
}
