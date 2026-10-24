import type { FetchFunction } from '@earendil-works/pi-ai'
import { Cause, Effect, Exit, Option, Predicate, Result, Schema } from 'effect'

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
  Undecoded: { bytes: Schema.Int },
  Unread: {},
})
const Body = Schema.TaggedUnion({
  Read: { text: Schema.String, redacted: Schema.Boolean },
  Unreadable: {},
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

/** Count wire bytes and decode once; a body that could not be read has no byte count at all. */
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
        Effect.succeed(RequestRecord.cases.Unread.make({})),
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

/** The request's own bearer value, which a refusal may echo back. */
function bearerOf(args: Parameters<FetchFunction>): Option.Option<string> {
  const [input, init] = args
  const supplied = Option.flatMap(Option.fromUndefinedOr(init), (value) =>
    Option.fromUndefinedOr(value.headers),
  )
  const headers = Option.match(supplied, {
    onNone: () => (input instanceof Request ? input.headers : new Headers()),
    onSome: (value) => new Headers(value),
  })
  return Option.fromNullOr(headers.get('authorization')).pipe(
    Option.filter((header) => /^Bearer\s+\S/i.test(header)),
    Option.map((header) => header.replace(/^Bearer\s+/i, '')),
  )
}

/**
 * A refusal's text with the request's own bearer value replaced, before anything keeps it. Pi
 * turns a refusal's body into the reply's `errorMessage`, which Flue persists in the conversation
 * (`conversation-stream-store` stream events, the submission's settlement) and streams to every
 * client: a provider that echoes the key would otherwise put it in a Person's Thread.
 */
const bodyOf = Effect.fn('Provider.body')(function* (
  response: Response,
  args: Parameters<FetchFunction>,
) {
  const bearer = bearerOf(args)
  return yield* Effect.tryPromise({
    try: () => response.clone().text(),
    catch: () => new ResponseUnreadable(),
  }).pipe(
    Effect.map((text) => {
      const scrubbed = Option.match(bearer, {
        onNone: () => text,
        onSome: (key) => text.replaceAll(key, '[redacted]'),
      })
      return Body.cases.Read.make({
        text: scrubbed,
        redacted: scrubbed !== text,
      })
    }),
    Effect.catchTag('ResponseUnreadable', () => Effect.succeed(Body.cases.Unreadable.make({}))),
  )
})

/** One JSON message keeps each HTTP attempt searchable without logging the private request. */
const record = Effect.fn('Provider.witness')(function* (input: {
  readonly response: Response
  readonly body: typeof Body.Type
  readonly metadata: typeof RequestRecord.Type
}) {
  const log = input.response.status >= 400 ? Effect.logWarning : Effect.logInfo
  yield* log(
    JSON.stringify({
      event: 'ProviderWitness',
      status: input.response.status,
      headers: headersOf(input.response),
      body: Body.match(input.body, {
        Read: ({ text }) => text.slice(0, 2048),
        Unreadable: () => '[unreadable]',
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

/** The body given in `init`, which replaces any the input carries. */
function initBody(args: Parameters<FetchFunction>) {
  return Option.flatMap(Option.fromUndefinedOr(args[1]), (value) =>
    Option.fromNullishOr(value.body),
  )
}

/** The request as one Request, for reading its body; failure leaves the real fetch untouched. */
function requestOf(args: Parameters<FetchFunction>) {
  const [input, init] = args
  return Result.getSuccess(
    Result.try({
      try: () => new Request(input instanceof Request ? input.clone() : input, init),
      catch: () => new RequestUnreadable(),
    }),
  )
}

/** Retain a readable Request before fetch can consume it; never consume an init stream or form. */
function retain(args: Parameters<FetchFunction>): () => Option.Option<Request> {
  const [input] = args
  return Option.match(initBody(args), {
    onNone: () => {
      if (!(input instanceof Request) || input.body === null) return () => requestOf(args)
      const copy = requestOf(args)
      return () => copy
    },
    onSome: (body) => (Predicate.isString(body) ? () => requestOf(args) : () => Option.none()),
  })
}

/**
 * The refusal handed to Pi. One whose text echoed the request's key is rebuilt from the scrubbed
 * text (without the original length and encoding, which described the bytes it replaced).
 */
function delivered(response: Response, body: typeof Body.Type) {
  if (!Body.guards.Read(body) || !body.redacted) return response
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  headers.delete('content-encoding')
  return new Response(body.text, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/** Witness every refusal once. Pi owns retry eligibility, including explicit provider headers. */
const send = Effect.fn('Provider.send')(function* (
  transport: FetchFunction,
  args: Parameters<FetchFunction>,
  read: () => Option.Option<Request>,
) {
  const response = yield* fetchResponse(transport, args)
  if (response.status < 400) return response
  const metadata = yield* Option.match(read(), {
    onNone: () => Effect.succeed(RequestRecord.cases.Unread.make({})),
    onSome: describeRequest,
  })
  const body = yield* bodyOf(response, args)
  yield* record({ response, metadata, body })
  return delivered(response, body)
})

/**
 * Pi requires a Promise-returning FetchFunction, the sole execution boundary. Effect owns the
 * inspection. Run to Exit so an SDK timeout preserves its AbortError
 * reason: runPromise's generic interruption error would become APIConnectionError instead of
 * APIConnectionTimeoutError in OpenAI 6.40.0. Transport rejections likewise return unchanged.
 */
export function witness(transport: FetchFunction): FetchFunction {
  return (...args) => {
    const [input, init] = args
    const retained = retain(args)
    // The effective abort signal: an init's own, including one that clears inheritance with
    // null, or else the Request's.
    const inherited = input instanceof Request ? Option.fromNullishOr(input.signal) : Option.none()
    const signal = Option.match(Option.fromUndefinedOr(init), {
      onNone: () => inherited,
      onSome: (value) => (value.signal === undefined ? inherited : Option.fromNullOr(value.signal)),
    })
    // oxlint-disable-next-line vivid/no-runpromise-in-library -- The single Pi transport boundary, classified exactly by the Effect boundary audit.
    return Effect.runPromiseExit(send(transport, args, retained), {
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
