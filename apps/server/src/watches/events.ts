import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import type { WatchArguments } from '@vivid/contracts'
import { requiredSetting, settingSecret } from '../config.ts'

/**
 * Executor's app events, from the subscriber's side: `events/list`, `events/subscribe` and
 * `events/unsubscribe`.
 *
 * Self-hosted Executor serves them only over authenticated MCP JSON-RPC on the stateless
 * `2026-07-28` protocol, on `POST /mcp`; there is no REST route for them
 * (executor@2.0.0-beta.23 `packages/mcp/src/implementation/events.ts` `eventsHandler`; the
 * method set and error codes are the patched `effect/ai` `McpSchema` in `patches/effect@4.0.1.patch`).
 * An unpinned key names its organization in `X-Executor-Organization`, and the transport refuses
 * a POST whose Accept header does not list both JSON and an event stream.
 */

/** The MCP protocol revision that carries events. Older initialized protocols do not have them. */
const PROTOCOL = '2026-07-28'

/** How long one call may take. Subscribing waits on Executor's own 10 s callback verification. */
const CALL_TIMEOUT = '30 seconds'

/** The draft MCP events extension's error codes (`McpSchema` in the patched `effect/ai`). */
const NOT_FOUND = -32011
const FORBIDDEN = -32012
const UNSUPPORTED = -32014
const CALLBACK_ENDPOINT = -32015
/** JSON-RPC's own invalid-params code, which Executor uses for arguments that fit no filter. */
const INVALID_PARAMS = -32602

/** No event with this name, or the app is gone. Renewal reads this as the event having changed. */
export class ExecutorEventMissing extends Schema.TaggedError<ExecutorEventMissing>()(
  'ExecutorEventMissing',
  {},
  { title: 'Executor event missing' },
) {}
/** The app no longer declares the event or a filter the Watch names; Executor stopped it. */
export class ExecutorEventChanged extends Schema.TaggedError<ExecutorEventChanged>()(
  'ExecutorEventChanged',
  {},
  { title: 'Executor event changed' },
) {}
/** The arguments name a filter the event does not declare, or a value of the wrong type. */
export class ExecutorEventArgumentsInvalid extends Schema.TaggedError<ExecutorEventArgumentsInvalid>()(
  'ExecutorEventArgumentsInvalid',
  { message: Schema.String },
  { title: 'Executor event arguments invalid' },
) {}
/** Executor could not verify Vivid's callback address (`CallbackFailure` upstream). */
export class ExecutorCallbackFailed extends Schema.TaggedError<ExecutorCallbackFailed>()(
  'ExecutorCallbackFailed',
  { reason: Schema.String },
  { title: 'Executor callback failed' },
) {}
/** Vivid's key may not use this event (or Executor refused the key itself). */
export class ExecutorEventRefused extends Schema.TaggedError<ExecutorEventRefused>()(
  'ExecutorEventRefused',
  {},
  { title: 'Executor event refused' },
) {}
/** This Executor cannot deliver events, or does not speak the protocol that has them. */
export class ExecutorEventsUnsupported extends Schema.TaggedError<ExecutorEventsUnsupported>()(
  'ExecutorEventsUnsupported',
  {},
  { title: 'Executor events unsupported' },
) {}
/** Executor did not answer usefully: down, timed out, or an answer this adapter cannot read. */
export class ExecutorEventsUnreachable extends Schema.TaggedError<ExecutorEventsUnreachable>()(
  'ExecutorEventsUnreachable',
  {},
  { title: 'Executor events unreachable' },
) {}

export type ExecutorEventsFailure =
  | ExecutorEventMissing
  | ExecutorEventChanged
  | ExecutorEventArgumentsInvalid
  | ExecutorCallbackFailed
  | ExecutorEventRefused
  | ExecutorEventsUnsupported
  | ExecutorEventsUnreachable

/**
 * One declared event as `events/list` returns it (`McpSchema.EventDefinition`). `name` is
 * `<app slug>.<declared name>`; `inputSchema` is the filters as a JSON Schema object whose
 * properties are each optional.
 */
export const EventDefinition = Schema.Struct({
  name: Schema.String,
  // Every declared event has a description of 1 to 1000 characters (`DeclaredEvent`), and
  // `events/list` copies it (`eventsHandler` upstream), so Executor's list always carries one.
  description: Schema.String,
  inputSchema: Schema.Struct({
    properties: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  }),
})
export interface EventDefinition extends Schema.Schema.Type<typeof EventDefinition> {}

const ListResult = Schema.Struct({ events: Schema.Array(EventDefinition) })
/** `McpSchema.SubscribeEventResult`; `refreshBefore` is the subscription's actual expiry. */
const SubscribeResult = Schema.Struct({
  id: Schema.String,
  refreshBefore: Schema.DateFromString,
})

/** A JSON-RPC error answer to request 1, with its code and optional data. */
const Refusal = Schema.Struct({
  id: Schema.Literal(1),
  error: Schema.Struct({
    code: Schema.Finite,
    message: Schema.String,
    data: Schema.optionalKey(Schema.Json),
  }),
})
/** A JSON-RPC answer to request 1: a result, or a refusal. */
const Answer = Schema.Union([
  Schema.Struct({ id: Schema.Literal(1), result: Schema.Json }),
  Refusal,
])
type Answer = typeof Answer.Type
const decodeAnswer = Schema.decodeUnknownOption(Schema.fromJsonString(Answer))
const isRefusal = Schema.is(Refusal)
const decodeReason = Schema.decodeUnknownOption(Schema.Struct({ reason: Schema.String }))

/** What one subscription is, at Executor: the event's full name, its filters and the callback. */
export interface Subscription {
  readonly name: string
  readonly arguments: WatchArguments
  readonly url: string
}

export interface ExecutorEventsService {
  /** Every event the apps Vivid's key can reach declare. */
  readonly list: Effect.Effect<ReadonlyArray<EventDefinition>, ExecutorEventsFailure>
  /**
   * Subscribe, or renew the subscription with the same key. Executor POSTs a signed challenge to
   * `url` before it answers, so the receiver must already know the Watch and its secret.
   */
  readonly subscribe: (
    subscription: Subscription & {
      readonly secret: Redacted.Redacted
      readonly ttlMs: number
    },
  ) => Effect.Effect<{ readonly id: string; readonly refreshBefore: Date }, ExecutorEventsFailure>
  /** Stop the subscription with this key. Executor answers success for one that does not exist. */
  readonly unsubscribe: (subscription: Subscription) => Effect.Effect<void, ExecutorEventsFailure>
}

export class ExecutorEvents extends Context.Service<ExecutorEvents, ExecutorEventsService>()(
  'vivid/ExecutorEvents',
) {}

/**
 * The answer to request 1 in a response body. A single answer comes back as JSON; the stateless
 * transport switches to Server-Sent Events when it writes more than one message (notifications
 * before the result), so each `data:` event is read until the answer is found.
 */
export const answerIn = (contentType: string, body: string): Option.Option<Answer> => {
  if (!contentType.includes('text/event-stream')) return decodeAnswer(body)
  for (const event of body.split(/\r?\n\r?\n/u)) {
    const data = event
      .split(/\r?\n/u)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart())
      .join('\n')
    const answer = decodeAnswer(data)
    if (Option.isSome(answer)) return answer
  }
  return Option.none()
}

/**
 * An MCP error as the failure a caller can act on. Unsupported carries `reason: schema_changed`
 * when a refresh named filters the event no longer declares (`projectError` upstream).
 */
export const failureOf = (error: {
  readonly code: number
  readonly message: string
  readonly data?: Schema.Json
}): ExecutorEventsFailure => {
  const reason = Option.map(decodeReason(error.data), (data) => data.reason)
  switch (error.code) {
    case NOT_FOUND:
      return new ExecutorEventMissing({})
    case FORBIDDEN:
      return new ExecutorEventRefused({})
    case INVALID_PARAMS:
      return new ExecutorEventArgumentsInvalid({ message: error.message })
    case CALLBACK_ENDPOINT:
      return new ExecutorCallbackFailed({ reason: Option.getOrElse(reason, () => 'unknown') })
    case UNSUPPORTED:
      return Option.contains(reason, 'schema_changed')
        ? new ExecutorEventChanged({})
        : new ExecutorEventsUnsupported({})
    default:
      return new ExecutorEventsUnreachable({})
  }
}

/** Executor's settings for this adapter; the same three the Connection adapter reads. */
export const executorSettings = Effect.fn('ExecutorEvents.settings')(function* () {
  const url = yield* requiredSetting(
    'VIVID_EXECUTOR_URL',
    Schema.NonEmptyString.check(
      Schema.makeFilter((value) => URL.canParse(value) || 'an absolute URL'),
    ),
    "Executor's absolute URL",
  )
  const key = yield* requiredSetting('VIVID_EXECUTOR_KEY', settingSecret, 'the Executor API key')
  const organization = yield* requiredSetting(
    'VIVID_EXECUTOR_ORGANIZATION',
    Schema.NonEmptyString,
    'the Executor organization id',
  )
  return { url: url.replace(/\/$/u, ''), key, organization }
})
export type ExecutorSettings = Effect.Success<ReturnType<typeof executorSettings>>

/** Build the service over one HTTP client and Executor's settings. */
export const makeExecutorEvents = (transport: HttpClient.HttpClient, config: ExecutorSettings) => {
  // The call's Scope releases each response, read or not.
  const client = HttpClient.withScope(transport)
  /** Send the request and read request 1's answer out of the body, in the caller's Scope. */
  const exchange = Effect.fn('ExecutorEvents.exchange')(function* (
    method: string,
    params: Readonly<Record<string, Schema.Json>>,
  ) {
    const request = HttpClientRequest.post(`${config.url}/mcp`).pipe(
      HttpClientRequest.bearerToken(config.key),
      HttpClientRequest.setHeaders({
        'X-Executor-Organization': config.organization,
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': PROTOCOL,
        'MCP-Method': method,
      }),
      HttpClientRequest.bodyText(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method,
          params: {
            _meta: {
              'io.modelcontextprotocol/protocolVersion': PROTOCOL,
              'io.modelcontextprotocol/clientCapabilities': {},
            },
            ...params,
          },
        }),
        'application/json',
      ),
    )
    const response = yield* client
      .execute(request)
      .pipe(Effect.mapError(() => new ExecutorEventsUnreachable({})))
    if (response.status === 401 || response.status === 403)
      return yield* new ExecutorEventRefused({})
    const body = yield* response.text.pipe(Effect.mapError(() => new ExecutorEventsUnreachable({})))
    const contentType = Option.getOrElse(
      Option.fromUndefinedOr(response.headers['content-type']),
      () => '',
    )
    const answer = answerIn(contentType, body)
    if (Option.isNone(answer)) return yield* new ExecutorEventsUnreachable({})
    if (isRefusal(answer.value)) return yield* failureOf(answer.value.error)
    return answer.value.result
  })

  /**
   * One JSON-RPC call: headers as the event fixture sends them, the answer decoded at ingress into
   * the shape this method promises. The timeout bounds the whole exchange, the body and its
   * decoding included: a server that sends headers and then stalls or drips the body would
   * otherwise hold the call, and with it every later Watch in a renewal pass, for as long as it
   * liked. Interruption releases the response through the call's Scope.
   */
  const call = <A, I>(
    method: string,
    params: Readonly<Record<string, Schema.Json>>,
    result: Schema.Codec<A, I>,
  ) =>
    exchange(method, params).pipe(
      Effect.flatMap((value) =>
        Schema.decodeUnknownEffect(result)(value).pipe(
          Effect.mapError(() => new ExecutorEventsUnreachable({})),
        ),
      ),
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: CALL_TIMEOUT,
        orElse: () => Effect.fail(new ExecutorEventsUnreachable({})),
      }),
    )

  return ExecutorEvents.of({
    list: call('events/list', {}, ListResult).pipe(Effect.map((result) => result.events)),
    subscribe: (input) =>
      call(
        'events/subscribe',
        {
          name: input.name,
          arguments: input.arguments,
          delivery: { mode: 'webhook', url: input.url, secret: Redacted.value(input.secret) },
          ttlMs: input.ttlMs,
        },
        SubscribeResult,
      ),
    unsubscribe: (input) =>
      call(
        'events/unsubscribe',
        {
          name: input.name,
          arguments: input.arguments,
          delivery: { mode: 'webhook', url: input.url },
        },
        Schema.Unknown,
      ).pipe(Effect.asVoid),
  })
}

/**
 * Requires HttpClient. Like the Connection adapter, a missing Executor setting stops launch; an
 * Executor that is down is a typed failure on the call that met it.
 */
export const executorEventsLayer = Layer.effect(
  ExecutorEvents,
  Effect.gen(function* () {
    return makeExecutorEvents(yield* HttpClient.HttpClient, yield* executorSettings())
  }),
)
