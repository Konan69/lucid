import { getTableName, isTable } from 'drizzle-orm'
import * as Clock from 'effect/Clock'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Predicate from 'effect/Predicate'
import * as Redacted from 'effect/Redacted'
import * as Ref from 'effect/Ref'
import * as Stream from 'effect/Stream'
import * as HttpBody from 'effect/unstable/http/HttpBody'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import type { HttpClientError } from 'effect/unstable/http/HttpClientError'
import type { HttpClientResponse } from 'effect/unstable/http/HttpClientResponse'
import * as OtlpLogger from 'effect/unstable/observability/OtlpLogger'
import type { AnyValue, KeyValue, Resource } from 'effect/unstable/observability/OtlpResource'
import * as OtlpSerialization from 'effect/unstable/observability/OtlpSerialization'
import * as OtlpTracer from 'effect/unstable/observability/OtlpTracer'
import { ObservabilityConfiguration } from '../config.ts'
import * as productSchema from '../database/product.ts'
import * as identitySchema from '../database/schema.ts'
import { Boundary, FailureAttribute, FailureKind, fixedTypeNames } from './failure.ts'
import { isCodeName, isMessage, Message } from './messages.ts'
import { refusalExport } from './refusal.ts'

/** The name every span and log line of this process is filed under. */
const SERVICE = 'vivid-server'

/**
 * What stands in for a log body, a span name or an event name that is not on the allowlist. The
 * record still goes, with its level, time and allowlisted attributes, so it is still counted.
 */
export const OMITTED = '[omitted]'

/** The attribute the drop report carries: how many batches were lost since the last report. */
const DROPPED_COUNT = 'vivid.export.dropped'

/**
 * Decides whether one attribute value may leave, and if so builds the value that does. A value is
 * never trimmed, cleaned or partly kept: it has the shape its key calls for, or it is absent.
 */
type Rule = (value: AnyValue) => Option.Option<AnyValue>

/** A string value that `allowed` accepts; every other kind of value is refused. */
const text =
  (allowed: (candidate: string) => boolean): Rule =>
  (value) =>
    Predicate.isString(value.stringValue) && allowed(value.stringValue)
      ? Option.some({ stringValue: value.stringValue })
      : Option.none()

/** One of a closed set of words. */
const oneOf = (words: ReadonlyArray<string>) => text((candidate) => words.includes(candidate))

/** An integer within a range; OTLP also allows a numeric string here, which nothing here writes. */
const integer =
  (least: number, most: number): Rule =>
  (value) =>
    Predicate.isNumber(value.intValue) &&
    Number.isInteger(value.intValue) &&
    value.intValue >= least &&
    value.intValue <= most
      ? Option.some({ intValue: value.intValue })
      : Option.none()

/**
 * A code identifier (`isCodeName`). The shape alone proves nothing about where a value came from,
 * so this rule is given only to keys whose every writer puts a name from code there: see the
 * note on each such key in `ALLOWED`.
 */
const codeName = text(isCodeName)

/** PostgreSQL's SQLSTATE: exactly five digits or capitals. */
const sqlState = text((candidate) => /^[0-9A-Z]{5}$/.test(candidate))

/**
 * A git commit as the host names it: 7 to 40 lowercase hexadecimal digits, the abbreviated and
 * the full form of a SHA-1. Anything else in `VIVID_COMMIT` is not a commit and is not sent.
 */
const commitHash = text((candidate) => /^[0-9a-f]{7,40}$/.test(candidate))

/**
 * The deployment's environment name: letters, digits and `_ . / -`, at most 40 characters. This
 * is operator configuration, not request data: `infra/railway.ts` fills `VIVID_ENVIRONMENT` from
 * Railway's own environment name, which whoever runs the deployment chose. The bound keeps a
 * mistaken value from being a payload.
 */
const environmentName = text((candidate) => /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,39}$/.test(candidate))

/**
 * The name of every table Vivid declares, read from the two Drizzle schema barrels with Drizzle's
 * own accessor (`drizzle-orm` `table.ts` `isTable`, `getTableName`), so a table added to a barrel
 * is a name here and no list is kept by hand. A barrel also exports things that are not tables
 * (an enum of column values), which `isTable` leaves out.
 */
const TABLES: ReadonlyArray<string> = [
  ...Object.values(identitySchema),
  ...Object.values(productSchema),
].flatMap((entry) => (isTable(entry) ? [getTableName(entry)] : []))

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT']

/**
 * The export allowlist: every attribute key that may leave the process, with the shape its value
 * must have. A key that is not here is dropped wherever it appears (a span, a span event, a span
 * link, a log line, the resource), and so is a listed key whose value has the wrong shape.
 *
 * An allowlist, not a block list. Round 1 exported everything and redacted strings by pattern,
 * and a pattern cannot be made safe: ordinary private prose (Thread text, a provider's echoed
 * prompt, a client's fault report) matches none. So nothing here is free text, and the keys that
 * hold text are the ones left out:
 *
 * - `vivid.failure.message`, `exception.message`, `exception.stacktrace`, `log.error`,
 *   `effect.cause`: messages, stacks and rendered causes.
 * - `url.full`, `url.path`, `url.query`: rc.116 `HttpMiddleware.tracer` never sets `http.route`,
 *   and a raw path carries ids and webhook tokens.
 * - Every `http.request.header.*` and `http.response.header.*`, content type included: a header
 *   is the sender's text, and `application/<anything>` is a well-formed media type. Also
 *   `user_agent.original`, `client.address`, `server.address`.
 * - `vivid.failure.constraint` and `vivid.refusal.service`: names with no closed set to check
 *   them against. They are on the stdout line.
 * - Every annotation a log line carries that Vivid's recorders did not write, such as the client
 *   report on `Client fault`.
 *
 * Lexical shape is not provenance. A value leaves only when it is a member of a closed set that
 * is derived from code (a schema's literals, the declared tables, the case names), or a number in
 * a range, or, for the few keys below that take a code name, when every writer of that key is
 * known to write a name from code:
 *
 * - `error.type` and `vivid.failure.root` are written by `failure.ts` alone, which takes a type
 *   from a class and never from a property of what was thrown (`typeOf` there). Nothing in
 *   rc.116 Effect writes either key.
 * - `rpc.system`, `rpc.service` and `rpc.method` are not written by rc.116 `RpcServer` or by
 *   Vivid today; they are listed for a recorder that names the call from the contract.
 */
const ALLOWED: ReadonlyMap<string, Rule> = new Map<string, Rule>([
  [FailureAttribute.type, codeName],
  [FailureAttribute.kind, oneOf(FailureKind.literals)],
  [FailureAttribute.boundary, oneOf(Boundary.literals)],
  [FailureAttribute.root, codeName],
  [FailureAttribute.databaseCode, sqlState],
  [FailureAttribute.table, oneOf(TABLES)],
  ...refusalExport.map(([key, members]) => [key, oneOf(members)] as const),
  [DROPPED_COUNT, integer(0, Number.MAX_SAFE_INTEGER)],
  // The tracer's own event for a failed span (rc.116 `OtlpTracer.ts` `makeOtlpSpan`) takes its
  // type from `error.name`, a string by the time it is here, so only a fixed name is let through.
  ['exception.type', oneOf(fixedTypeNames)],
  ['service.name', oneOf([SERVICE])],
  ['service.version', commitHash],
  ['deployment.environment.name', environmentName],
  ['deployment.environment', environmentName],
  ['rpc.system', codeName],
  ['rpc.service', codeName],
  ['rpc.method', codeName],
  ['http.request.method', oneOf(METHODS)],
  ['http.response.status_code', integer(100, 599)],
  ['url.scheme', oneOf(['http', 'https'])],
])

/** The pairs that may leave, each rebuilt from its key and the value its rule produced. */
const allowed = (pairs: ReadonlyArray<KeyValue>): Array<KeyValue> =>
  pairs.flatMap(({ key, value }) =>
    Option.fromUndefinedOr(ALLOWED.get(key)).pipe(
      Option.flatMap((rule) => rule(value)),
      Option.map((kept) => ({ key, value: kept })),
      Option.toArray,
    ),
  )

/** Allowlisted attributes, with OTLP's own count of how many were left behind. */
const attributesOf = (pairs: ReadonlyArray<KeyValue>) => {
  const attributes = allowed(pairs)
  return { attributes, droppedAttributesCount: pairs.length - attributes.length }
}

type Traces = Parameters<OtlpSerialization.OtlpSerialization['Service']['traces']>[0]
type Logs = Parameters<OtlpSerialization.OtlpSerialization['Service']['logs']>[0]
type ExportedSpan = Traces['resourceSpans'][number]['scopeSpans'][number]['spans'][number]
type ExportedEvent = ExportedSpan['events'][number]
type ExportedLink = ExportedSpan['links'][number]
type ExportedLine = NonNullable<
  Logs['resourceLogs'][number]['scopeLogs'][number]['logRecords']
>[number]

const TRACE_ID = /^[0-9a-f]{32}$/i
const SPAN_ID = /^[0-9a-f]{16}$/i

/**
 * A trace id as OTLP carries it: 32 hexadecimal digits.
 *
 * B3 also allows a 64-bit trace id, 16 digits (`b3: 463ac35c9f6413ad-a2fb4a1d1a96d312-1`), and
 * rc.116 `HttpTraceContext` hands it on as sent. That is a sound id from a caller that
 * propagates B3, so it is widened the way B3 prescribes, with zeros on the left, and every span,
 * link and log line of that trace is filed under the same 32 digits. Any other text is not an id
 * and has no exportable form.
 */
const traceIdOf = (id: string): Option.Option<string> => {
  if (TRACE_ID.test(id)) return Option.some(id)
  return SPAN_ID.test(id) ? Option.some(`${'0'.repeat(16)}${id}`) : Option.none()
}

/**
 * A span name that is a code identifier (an `Effect.fn` name, `RpcServer.<tag>`) or the fixed
 * name the HTTP server and client give a request (rc.116 `HttpMiddleware.SpanNameGenerator`,
 * `HttpClient.SpanNameGenerator`: `http.server METHOD`, `http.client METHOD`). `Effect.withSpan`
 * takes any string, so a name built from data would otherwise leave as written.
 *
 * The residual assumption is that span names are written in code. A dotted identifier built from
 * data (`Ada.Lovelace`) has the same shape and would pass, and nothing here can tell the two
 * apart. No producer does that today: every name is an `Effect.fn` literal, or
 * `RpcServer.<tag>`, which rc.116 `RpcServer.ts` `handleRequest` builds only after it has found
 * the tag in the contract's group. `export.test.ts` sends a marker of that shape through the
 * path, the query, a header and an RPC payload and fails if it reaches a span name.
 */
const spanName = (name: string) => {
  const [prefix, method, ...rest] = name.split(' ')
  const request =
    (prefix === 'http.server' || prefix === 'http.client') &&
    method !== undefined &&
    METHODS.includes(method) &&
    rest.length === 0
  return request || isCodeName(name) ? name : OMITTED
}

/**
 * An event is named by a log message (rc.116 `internal/effect.ts` `tracerLogger`) or is the
 * tracer's `exception`; any other name is text someone logged.
 */
const allowEvent = (event: ExportedEvent): ExportedEvent => ({
  name: event.name === 'exception' || isMessage(event.name) ? event.name : OMITTED,
  timeUnixNano: event.timeUnixNano,
  ...attributesOf(event.attributes),
})

/** A link to a span whose ids are not ids is dropped; see `allowSpan`. */
const allowLink = (link: ExportedLink): ReadonlyArray<ExportedLink> => {
  const traceId = traceIdOf(link.traceId)
  if (Option.isNone(traceId) || !SPAN_ID.test(link.spanId)) return []
  return [{ traceId: traceId.value, spanId: link.spanId, ...attributesOf(link.attributes) }]
}

/**
 * One span, rebuilt field by field.
 *
 * - The status keeps its code only. rc.116 `makeOtlpSpan` sets the message to the first error's
 *   own message.
 * - Ids are text from outside too. rc.116 `HttpTraceContext` validates `traceparent` but takes
 *   `b3` and `x-b3-traceid`/`x-b3-spanid` as sent, and every span under that request inherits the
 *   trace id (`SpanImpl.traceId`). A span whose trace id is not an id (`traceIdOf`) is therefore
 *   dropped whole: its only alternative is a made-up id, which would file it under a trace that
 *   does not exist. When the trace id is sound and only the inherited parent's span id is not,
 *   the parent is dropped and the span is exported as a root of that trace.
 */
const allowSpan = (span: ExportedSpan): ReadonlyArray<ExportedSpan> => {
  const traceId = traceIdOf(span.traceId)
  if (Option.isNone(traceId) || !SPAN_ID.test(span.spanId)) return []
  const links = span.links.flatMap(allowLink)
  return [
    {
      traceId: traceId.value,
      spanId: span.spanId,
      parentSpanId:
        span.parentSpanId !== undefined && SPAN_ID.test(span.parentSpanId)
          ? span.parentSpanId
          : undefined,
      name: spanName(span.name),
      kind: span.kind,
      startTimeUnixNano: span.startTimeUnixNano,
      endTimeUnixNano: span.endTimeUnixNano,
      ...attributesOf(span.attributes),
      events: span.events.map(allowEvent),
      droppedEventsCount: 0,
      status: { code: span.status.code },
      links,
      droppedLinksCount: span.links.length - links.length,
    },
  ]
}

/**
 * The span a log line was written under, when its ids are ids, with the trace id in the same
 * form its span is exported under; see `allowSpan`.
 */
const spanOf = ({ traceId, spanId }: ExportedLine) =>
  Predicate.isString(traceId) && Predicate.isString(spanId) && SPAN_ID.test(spanId)
    ? Option.map(traceIdOf(traceId), (trace) => ({ traceId: trace, spanId }))
    : Option.none()

/** A line's body when it is, exactly, one of the fixed messages; otherwise the placeholder. */
const bodyOf = (line: ExportedLine): string =>
  Option.fromUndefinedOr(line.body).pipe(
    Option.flatMap((body) => Option.fromNullishOr(body.stringValue)),
    Option.filter(isMessage),
    Option.getOrElse(() => OMITTED),
  )

/**
 * One log line, rebuilt field by field. The body is the fixed message or the placeholder; the
 * times and the level are the logger's own (rc.116 `OtlpLogger.ts` `makeLogRecord`). The ids are
 * kept as a pair or not at all: a line under a span that is not exported names no span.
 */
const allowLine = (line: ExportedLine): ExportedLine => {
  const span = spanOf(line)
  return {
    timeUnixNano: line.timeUnixNano,
    observedTimeUnixNano: line.observedTimeUnixNano,
    severityNumber: line.severityNumber,
    severityText: line.severityText,
    body: { stringValue: bodyOf(line) },
    ...attributesOf(line.attributes),
    traceId: Option.getOrUndefined(Option.map(span, ({ traceId }) => traceId)),
    spanId: Option.getOrUndefined(Option.map(span, ({ spanId }) => spanId)),
  }
}

const allowTraces =
  (resource: Resource) =>
  (data: Traces): Traces => ({
    resourceSpans: data.resourceSpans.map((group) => ({
      resource,
      scopeSpans: group.scopeSpans.map((scope) => ({
        scope: { name: SERVICE },
        spans: scope.spans.flatMap(allowSpan),
      })),
    })),
  })

type ExportedScope = Logs['resourceLogs'][number]['scopeLogs'][number]

/** The records of one scope; rc.116 types them as optional, and a scope without any has none. */
const linesOf = (scope: ExportedScope): Array<ExportedLine> =>
  Option.fromUndefinedOr(scope.logRecords).pipe(
    Option.map((records) => records.map(allowLine)),
    Option.getOrElse(() => []),
  )

const allowLogs =
  (resource: Resource) =>
  (data: Logs): Logs => ({
    resourceLogs: data.resourceLogs.map((group) => ({
      resource,
      scopeLogs: group.scopeLogs.map((scope) => ({
        scope: { name: SERVICE },
        logRecords: linesOf(scope),
      })),
    })),
  })

/**
 * The resource every post names: the service, and the commit and environment when the host
 * supplies them, each through the allowlist like any other attribute, so a `VIVID_COMMIT` that
 * is not a commit is left off.
 *
 * It is built here and put in place of the exporter's own at serialization, because the
 * exporter's is not Vivid's to bound: rc.116 `OtlpResource.fromConfig` merges every pair in
 * `OTEL_RESOURCE_ATTRIBUTES` into it. The environment is written under both the current
 * semantic-convention name and the one it replaced, because which of the two the backend reads
 * was not verified.
 */
const resourceOf = (
  environment: Option.Option<string>,
  commit: Option.Option<string>,
): Resource => ({
  attributes: allowed([
    { key: 'service.name', value: { stringValue: SERVICE } },
    ...Option.toArray(commit).map((version) => ({
      key: 'service.version',
      value: { stringValue: version },
    })),
    ...Option.toArray(environment).flatMap((name) => [
      { key: 'deployment.environment.name', value: { stringValue: name } },
      { key: 'deployment.environment', value: { stringValue: name } },
    ]),
  ]),
  droppedAttributesCount: 0,
})

/**
 * OTLP/HTTP JSON in which every span and log line has been rebuilt from the allowlist.
 *
 * `OtlpSerialization` is the one place both signals cross on their way out, so rebuilding here
 * covers what this server never authored: the tracer's exception events, a logged cause, the HTTP
 * server span's address and headers, a line logged by any module with any text. Sentry accepts
 * JSON on the traces and logs paths. Metrics are not installed (its OTLP endpoint has no metrics
 * path); nothing about a metric is on the allowlist, so that encoder exports none.
 */
const allowlistSerializationLayer = (resource: Resource) =>
  Layer.succeed(OtlpSerialization.OtlpSerialization, {
    traces: (data) => HttpBody.jsonUnsafe(allowTraces(resource)(data)),
    logs: (data) => HttpBody.jsonUnsafe(allowLogs(resource)(data)),
    metrics: () => HttpBody.jsonUnsafe({ resourceMetrics: [] }),
  })

/** How long one export may take, from sending the request to the end of the answer's body. */
export const LONGEST_EXPORT = Duration.seconds(10)
/** How many exports may be outstanding at once, traces and logs together. */
export const MOST_OUTSTANDING = 8
/** The least time between two drop reports. */
export const REPORT_EVERY_MILLIS = 60_000
/** The most of an answer's body that is read. An OTLP success is a few bytes of JSON. */
const LARGEST_ANSWER = 64 * 1024

interface Drops {
  /** Batches lost since the last report. */
  readonly pending: number
  /** The clock time from which the next report may be written. */
  readonly reportDue: number
}

/**
 * Counts one lost batch, reports the count when a report is due, and ends the export by
 * interrupting it.
 *
 * The interrupt is the point. rc.116 `OtlpExporter.ts` `make` wraps the client it is given in
 * `filterStatusOk` and `retryTransient`, outside anything this module does to that client. A
 * failure or a refusal handed back to it would be retried there on the exporter's own schedule
 * (a `429` waits out its `Retry-After`, however long), with the export fiber and its serialized
 * batch held for the whole delay. An interruption is not an error and not a response, so nothing
 * is scheduled: it reaches the exporter's `catchCause`, which clears its buffer and stops it
 * accepting data for 60 seconds.
 *
 * The count is of the batches this wrapper gave up on: past the cap, out of time, refused by the
 * backend, or never delivered. Data the exporter declines to buffer during its 60 seconds never
 * passes through here and is not in it.
 *
 * At most one report a minute, written when a drop happens: the count of a quiet minute's last
 * drops waits for the next drop to be reported with it.
 */
const drop = Effect.fnUntraced(function* (drops: Ref.Ref<Drops>) {
  const now = yield* Clock.currentTimeMillis
  const report = yield* Ref.modify(drops, ({ pending, reportDue }) =>
    now >= reportDue
      ? [Option.some(pending + 1), { pending: 0, reportDue: now + REPORT_EVERY_MILLIS }]
      : [Option.none<number>(), { pending: pending + 1, reportDue }],
  )
  if (Option.isSome(report))
    yield* Effect.annotateLogs(Effect.logWarning(Message.dropped), {
      [DROPPED_COUNT]: report.value,
    })
  return yield* Effect.interrupt
})

/** The state one bounded client keeps: how many exports are in flight, and the drop count. */
interface Bounds {
  readonly outstanding: Ref.Ref<number>
  readonly drops: Ref.Ref<Drops>
}

/**
 * Reads an accepted answer's body to its end, or to `LARGEST_ANSWER`, whichever is first.
 *
 * Reading it is what lets the connection be used again: an HTTP/1.1 connection carries one
 * answer at a time, so one whose body was left unread cannot go back to the pool. A body that
 * runs past the bound is left there, and closing the exchange's scope cancels the rest.
 */
const drain = (response: HttpClientResponse) =>
  response.stream.pipe(
    Stream.scan(
      () => 0,
      (read, chunk) => read + chunk.byteLength,
    ),
    Stream.takeUntil((read) => read > LARGEST_ANSWER),
    Stream.runDrain,
  )

/**
 * One whole exchange with the backend: the request, the answer's status, and the answer's body.
 * It yields the response when the backend accepted the batch and nothing when it did not, for
 * whatever reason: a status outside 2xx, a connection that failed, a body that broke off.
 *
 * `send` comes from `HttpClient.withScope`, which ties the request's `AbortController` to the
 * scope opened here (rc.116 `HttpClient.ts` `withScope`, `make`). Closing that scope aborts the
 * request, and that is how the connection is given up whichever way the exchange ends: a body
 * still arriving is cancelled, a refusal's body is never read, and after a body that was read to
 * its end the abort finds nothing left to cancel. Without it rc.116 leaves a body nobody reads
 * open: the Undici client sets `bodyTimeout: 0` (`NodeHttpClient.ts` `makeUndici`), so a backend
 * that sent its headers and stalled would hold the socket for good.
 *
 * It does not fail. Every way of not delivering is the same outcome to the caller, one dropped
 * batch, and an error returned from here is what the exporter would retry (`drop`).
 */
const exchange = <E, R>(send: Effect.Effect<HttpClientResponse, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const response = yield* send
      if (response.status < 200 || response.status >= 300) return Option.none<HttpClientResponse>()
      yield* drain(response)
      return Option.some(response)
    }),
  ).pipe(Effect.catch(() => Effect.succeed(Option.none<HttpClientResponse>())))

/**
 * Makes one export within the bounds, in one attempt: it takes a place among the outstanding
 * exports or is dropped unsent, is dropped when the whole exchange outlives `LONGEST_EXPORT` or
 * is not accepted, and gives its place back however it ends.
 *
 * The place and the time limit cover the exchange to the end of the answer's body, not only to
 * its headers, so a place given back means a connection given back (`exchange`).
 * `acquireUseRelease` makes taking the place and giving it back one uninterruptible pair, so an
 * interrupted export cannot leak a place and shrink the cap.
 */
const bounded = <E, R>(bounds: Bounds, send: Effect.Effect<HttpClientResponse, E, R>) =>
  Effect.acquireUseRelease(
    Ref.modify(bounds.outstanding, (count) =>
      count >= MOST_OUTSTANDING ? [false, count] : [true, count + 1],
    ),
    (admitted) =>
      admitted
        ? Effect.timeoutOption(exchange(send), LONGEST_EXPORT).pipe(
            Effect.flatMap((ended) =>
              Option.match(Option.flatten(ended), {
                onNone: () => drop(bounds.drops),
                onSome: (response) => Effect.succeed(response),
              }),
            ),
          )
        : drop(bounds.drops),
    (admitted) => (admitted ? Ref.update(bounds.outstanding, (count) => count - 1) : Effect.void),
  )

/**
 * The HTTP client the exporters post with, bounded so that a slow, absent or refusing backend
 * costs the server a fixed amount and no more.
 *
 * rc.116 `OtlpExporter.ts` puts no limit on a request: it starts one every interval and one more
 * each time a buffer fills, it retries a refused or failed one on its own schedule, and a backend
 * that accepts the connection and never finishes holds each of them, and the batch it carries,
 * for as long as the process lives. So here:
 *
 * - an export gets one attempt: an answer that is not a success, and a request that fails, end it
 *   in a way the exporter does not retry;
 * - an export is cancelled after `LONGEST_EXPORT`, counted to the end of the answer's body;
 * - at most `MOST_OUTSTANDING` exports are in flight across both signals, each holding at most
 *   one connection, and one past that is cancelled before it is sent;
 * - in every one of those cases the batch is dropped, not queued (`drop`).
 *
 * Nothing that serves a Person waits on any of this. Recording a span or a line is a push onto
 * the exporter's in-memory buffer (`exporter.push`), and the requests run on the exporter's own
 * fibers.
 *
 * Untraced, as are the programs it runs per request: a span about an export would itself be
 * exported.
 */
const boundedClient = Effect.fnUntraced(function* () {
  const client = yield* HttpClient.HttpClient
  const bounds: Bounds = {
    outstanding: yield* Ref.make(0),
    drops: yield* Ref.make<Drops>({ pending: 0, reportDue: 0 }),
  }
  // `withScope` asks its caller for the scope it ties the request to, and `bounded` supplies one
  // per exchange. `makeWith` is used in place of `transform` so that the client's type says so:
  // `transform` would carry the `Scope` requirement out to the exporter, which has none to give.
  const scoped = HttpClient.withScope(client)
  // The error type is stated because a client's type is fixed in it (`HttpClient` is
  // `With<HttpClientError>`); this one never fails with one (`exchange`).
  return HttpClient.makeWith<HttpClientError, never, HttpClientError, never>(
    (request) => bounded(bounds, scoped.postprocess(request)),
    (request) => client.preprocess(request),
  )
})

/** `<base>/v1/<signal>`, whether or not the configured base ends in a slash. */
const endpoint = (base: URL, signal: 'traces' | 'logs') =>
  `${base.href.replace(/\/+$/, '')}/v1/${signal}`

/**
 * Installs the OTLP tracer and logger exporters for an `Enabled` setting, and nothing for
 * `Disabled`.
 *
 * VCOS `apps/web/src/observability/tracing.ts` `workerObservabilityLayer` is the reference: one
 * Layer that puts a tracer and a structured logger under the whole program. It hands spans to
 * Cloudflare's own pipeline; Vivid is a Node process, so the exporter is Effect's
 * (`effect/unstable/observability`), and the Layer is built once for the process, not per request.
 *
 * - Only traces and logs: the backend has no OTLP metrics path, and counts are derived there from
 *   span and log attributes.
 * - `mergeWithExisting` keeps the default logger, so stdout shows every line in full, including
 *   the text the allowlist keeps from the backend.
 * - The exporters are given the service name only so that they can be built (without one, rc.116
 *   `OtlpResource.fromConfig` requires `OTEL_SERVICE_NAME`); the resource and scope that are
 *   actually posted are the ones `allowlistSerializationLayer` puts in.
 * - Both exporters share one bounded client (`boundedClient`), so the cap on outstanding requests
 *   is across both signals.
 *
 * The exporter batches on a timer and flushes when the Layer's scope closes, bounded by its own
 * shutdown timeout (rc.116 `OtlpExporter.ts` `make`); `Flusher` in the output drains it on demand.
 */
export const observabilityLayer = (configuration: ObservabilityConfiguration) =>
  ObservabilityConfiguration.$match(configuration, {
    Disabled: () => Layer.empty,
    Enabled: ({ url, headers, environment, commit }) => {
      const resource = { serviceName: SERVICE }
      const credentials = Redacted.value(headers)
      return Layer.mergeAll(
        OtlpTracer.layer({ url: endpoint(url, 'traces'), resource, headers: credentials }),
        OtlpLogger.layer({
          url: endpoint(url, 'logs'),
          resource,
          headers: credentials,
          mergeWithExisting: true,
        }),
      ).pipe(
        Layer.provide(allowlistSerializationLayer(resourceOf(environment, commit))),
        Layer.provide(Layer.effect(HttpClient.HttpClient, boundedClient())),
      )
    },
  })
