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
  Read: { text: Schema.String, empty: Schema.Boolean, redacted: Schema.Boolean },
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

/**
 * Bounds the external gateway's transient empty-body HTTP 400 fault to one immediate replay,
 * two attempts total. The producer is outside Vivid and supplies no recovery signal.
 * Source: reference: 99eb74612, which introduced one replay for production empty-400 refusals.
 * That commit retains no production log excerpt or measured recovery window. There is no wait.
 * If the replay is refused, Pi receives that refusal unchanged except for credential redaction.
 */
const EMPTY_400_REPLAY_ATTEMPT = 2

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
 * turns a refusal's body into the reply's `errorMessage`, which Pi Durable persists in the conversation
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
        empty: text.length === 0,
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
        Read: ({ text }) => text.slice(0, 2048),
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

/**
 * How a refused request is read and sent again.
 *
 * - No body, or a string one in `init` (what Pi's OpenAI SDK sends): the arguments are read only
 *   once a refusal arrives, so an answered request costs nothing, and are sent again as they are.
 * - A Request carrying its own body: the first send reads it once, so a clone is taken before it,
 *   and it is read and sent again only from that clone.
 * - Any other body in `init` (a stream, a form): nothing can copy it without taking it from the
 *   first send, so it is neither read nor sent again, and a refusal is returned as it came.
 */
interface Retained {
  readonly read: () => Option.Option<Request>
  readonly replay: Option.Option<Parameters<FetchFunction>>
}

function retain(args: Parameters<FetchFunction>): Retained {
  const [input] = args
  return Option.match(initBody(args), {
    onNone: () => {
      if (!(input instanceof Request) || input.body === null)
        return { read: () => requestOf(args), replay: Option.some(args) }
      const copy = requestOf(args)
      return { read: () => copy, replay: Option.map(copy, (request) => [request] as const) }
    },
    onSome: (body) =>
      Predicate.isString(body)
        ? { read: () => requestOf(args), replay: Option.some(args) }
        : { read: () => Option.none(), replay: Option.none() },
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

/** Only a zero-byte 400 is replayed, once and immediately, before Pi consumes assistant output. */
const send = Effect.fn('Provider.send')(function* (
  transport: FetchFunction,
  args: Parameters<FetchFunction>,
  retained: Retained,
) {
  const response = yield* fetchResponse(transport, args)
  if (response.status < 400) return response
  const metadata = yield* Option.match(retained.read(), {
    onNone: () => Effect.succeed(RequestRecord.cases.Unread.make({})),
    onSome: describeRequest,
  })
  const body = yield* bodyOf(response, args)
  yield* record({ response, metadata, body, attempt: 1 })
  if (response.status !== 400 || !Body.guards.Read(body) || !body.empty)
    return delivered(response, body)
  // Without a replayable request, return the actual refusal rather than a consumed-body error.
  if (Option.isNone(retained.replay)) return response
  const retried = yield* fetchResponse(transport, retained.replay.value)
  if (retried.status < 400) {
    yield* record({
      response: retried,
      metadata,
      body: Body.cases.Uninspected.make({}),
      attempt: EMPTY_400_REPLAY_ATTEMPT,
    })
    return retried
  }
  const nextBody = yield* bodyOf(retried, args)
  yield* record({ response: retried, metadata, body: nextBody, attempt: EMPTY_400_REPLAY_ATTEMPT })
  return delivered(retried, nextBody)
})

/**
 * Pi requires a Promise-returning FetchFunction, the sole execution boundary. Effect owns the
 * inspection and replay. Run to Exit so an SDK timeout preserves its AbortError
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
