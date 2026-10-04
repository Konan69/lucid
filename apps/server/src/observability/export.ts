import * as Clock from 'effect/Clock'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Predicate from 'effect/Predicate'
import * as Redacted from 'effect/Redacted'
import * as Ref from 'effect/Ref'
import * as HttpBody from 'effect/unstable/http/HttpBody'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import type { HttpClientResponse } from 'effect/unstable/http/HttpClientResponse'
import * as OtlpLogger from 'effect/unstable/observability/OtlpLogger'
import type { AnyValue, KeyValue, Resource } from 'effect/unstable/observability/OtlpResource'
import * as OtlpSerialization from 'effect/unstable/observability/OtlpSerialization'
import * as OtlpTracer from 'effect/unstable/observability/OtlpTracer'
import { ObservabilityConfiguration } from '../config.ts'
import { Boundary, FailureAttribute, FailureKind } from './failure.ts'
import { isCodeName, isMessage, Message } from './messages.ts'
import { refusalAttributeKeys } from './refusal.ts'

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

/** An error's `_tag` or class name, an RPC tag: see `isCodeName`. */
const codeName = text(isCodeName)

/**
 * An identifier that is not a code name: a service id (`google-calendar`, `openapi/acme-v2`), a
 * table or constraint name, an environment name, a commit. Letters, digits and `_ . / -` only, so
 * no spaces, quotes, `:`, `?`, `=`, `&` or `@`: not prose, not an address with a scheme or a
 * query, not an assignment, not an email address.
 */
const slug = text((candidate) => /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,119}$/.test(candidate))

/** PostgreSQL's SQLSTATE: exactly five digits or capitals. */
const sqlState = text((candidate) => /^[0-9A-Z]{5}$/.test(candidate))

/**
 * A media type with at most a charset: `application/json`, `text/html; charset=utf-8`. A
 * multipart type carries a boundary parameter and is refused whole rather than cut down.
 */
const mediaType = text((candidate) =>
  /^[A-Za-z0-9.+-]{1,60}\/[A-Za-z0-9.+-]{1,60}(?:; ?charset=[A-Za-z0-9_-]{1,20})?$/.test(candidate),
)

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
 * - Every `http.request.header.*` and `http.response.header.*` except content type, and
 *   `user_agent.original`, `client.address`, `server.address`.
 * - Every annotation a log line carries that Vivid's recorders did not write, such as the client
 *   report on `Client fault`.
 *
 * The `vivid.*` and failure keys are read from the modules that write them, so adding a refusal
 * field or a failure attribute there extends this list and nothing else has to change.
 */
const ALLOWED: ReadonlyMap<string, Rule> = new Map<string, Rule>([
  [FailureAttribute.type, codeName],
  [FailureAttribute.kind, oneOf(FailureKind.literals)],
  [FailureAttribute.boundary, oneOf(Boundary.literals)],
  [FailureAttribute.root, codeName],
  [FailureAttribute.databaseCode, sqlState],
  [FailureAttribute.constraint, slug],
  [FailureAttribute.table, slug],
  ...refusalAttributeKeys.map((key) => [key, slug] as const),
  [DROPPED_COUNT, integer(0, Number.MAX_SAFE_INTEGER)],
  // The tracer's own event for a failed span (rc.116 `OtlpTracer.ts` `makeOtlpSpan`): its type only.
  ['exception.type', codeName],
  ['service.name', slug],
  ['service.version', slug],
  ['deployment.environment.name', slug],
  ['deployment.environment', slug],
  ['rpc.system', codeName],
  ['rpc.service', codeName],
  ['rpc.method', codeName],
  ['http.request.method', oneOf(METHODS)],
  ['http.response.status_code', integer(100, 599)],
  ['url.scheme', oneOf(['http', 'https'])],
  ['http.request.header.content-type', mediaType],
  ['http.response.header.content-type', mediaType],
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
 * A span name that is a code identifier (an `Effect.fn` name, `RpcServer.<tag>`) or the fixed
 * name the HTTP server and client give a request (rc.116 `HttpMiddleware.SpanNameGenerator`,
 * `HttpClient.SpanNameGenerator`: `http.server METHOD`, `http.client METHOD`). `Effect.withSpan`
 * takes any string, so a name built from data would otherwise leave as written.
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
const allowLink = (link: ExportedLink): ReadonlyArray<ExportedLink> =>
  TRACE_ID.test(link.traceId) && SPAN_ID.test(link.spanId)
    ? [{ traceId: link.traceId, spanId: link.spanId, ...attributesOf(link.attributes) }]
    : []

/**
 * One span, rebuilt field by field.
 *
 * - The status keeps its code only. rc.116 `makeOtlpSpan` sets the message to the first error's
 *   own message.
 * - Ids are text from outside too. rc.116 `HttpTraceContext` validates `traceparent` but takes
 *   `b3` and `x-b3-traceid`/`x-b3-spanid` as sent, and every span under that request inherits the
 *   trace id (`SpanImpl.traceId`). A span whose trace id is not 32 hex digits is therefore
 *   dropped whole: its only alternative is a made-up id, which would file it under a trace that
 *   does not exist. When the trace id is sound and only the inherited parent's span id is not,
 *   the parent is dropped and the span is exported as a root of that trace.
 */
const allowSpan = (span: ExportedSpan): ReadonlyArray<ExportedSpan> => {
  if (!TRACE_ID.test(span.traceId) || !SPAN_ID.test(span.spanId)) return []
  const links = span.links.flatMap(allowLink)
  return [
    {
      traceId: span.traceId,
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

/** Whether a log line was written under a span whose ids are ids; see `allowSpan`. */
const isTraced = (line: ExportedLine) =>
  Predicate.isString(line.traceId) &&
  Predicate.isString(line.spanId) &&
  TRACE_ID.test(line.traceId) &&
  SPAN_ID.test(line.spanId)

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
  const traced = isTraced(line)
  return {
    timeUnixNano: line.timeUnixNano,
    observedTimeUnixNano: line.observedTimeUnixNano,
    severityNumber: line.severityNumber,
    severityText: line.severityText,
    body: { stringValue: bodyOf(line) },
    ...attributesOf(line.attributes),
    traceId: traced ? line.traceId : undefined,
    spanId: traced ? line.spanId : undefined,
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
 * supplies them, each through the allowlist like any other attribute.
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

/** How long one export request may take before it is cancelled. */
export const LONGEST_EXPORT = Duration.seconds(10)
/** How many export requests may be outstanding at once, traces and logs together. */
export const MOST_OUTSTANDING = 8
/** The least time between two drop reports. */
export const REPORT_EVERY_MILLIS = 60_000

interface Drops {
  /** Batches lost since the last report. */
  readonly pending: number
  /** The clock time from which the next report may be written. */
  readonly reportDue: number
}

/**
 * Counts one lost batch, reports the count when a report is due, and ends the request by
 * interrupting it.
 *
 * The interrupt is the point. rc.116 `OtlpExporter.ts` `make` wraps its client in
 * `retryTransient`, which retries every `TransportError` three times a second apart, and keeps
 * the batch while it does; a request refused with an error would be held and re-sent into the
 * same overload. An interruption is not an error, so it is not retried: it reaches the exporter's
 * `catchCause`, which clears its buffer and stops it accepting data for 60 seconds.
 *
 * The count is of batches this wrapper cancelled or timed out, and nothing else. Data the
 * exporter refuses during its 60 seconds, and a batch the backend answered with an error after
 * the exporter's own retries, never pass through here as a drop and are not in it.
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

/** The state one bounded client keeps: how many requests are in flight, and the drop count. */
interface Bounds {
  readonly outstanding: Ref.Ref<number>
  readonly drops: Ref.Ref<Drops>
}

/**
 * Sends one export request within the bounds: it takes a place among the outstanding requests or
 * is dropped unsent, is dropped when it outlives `LONGEST_EXPORT`, and gives its place back
 * however it ends. `acquireUseRelease` makes taking the place and giving it back one
 * uninterruptible pair, so an interrupted export cannot leak a place and shrink the cap.
 */
const bounded = <E, R>(bounds: Bounds, send: Effect.Effect<HttpClientResponse, E, R>) =>
  Effect.acquireUseRelease(
    Ref.modify(bounds.outstanding, (count) =>
      count >= MOST_OUTSTANDING ? [false, count] : [true, count + 1],
    ),
    (admitted) =>
      admitted
        ? Effect.timeoutOrElse(send, {
            duration: LONGEST_EXPORT,
            orElse: () => drop(bounds.drops),
          })
        : drop(bounds.drops),
    (admitted) => (admitted ? Ref.update(bounds.outstanding, (count) => count - 1) : Effect.void),
  )

/**
 * The HTTP client the exporters post with, bounded so that a slow or absent backend costs the
 * server a fixed amount and no more.
 *
 * rc.116 `OtlpExporter.ts` puts no limit on a request: it starts one every interval and one more
 * each time a buffer fills, and a backend that accepts the connection and never answers holds
 * each of them, and the batch it carries, for as long as the process lives. So here:
 *
 * - a request is cancelled after `LONGEST_EXPORT`;
 * - at most `MOST_OUTSTANDING` requests are in flight across both signals, and one past that is
 *   cancelled before it is sent;
 * - either way the batch is dropped, not queued (`drop`).
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
  return HttpClient.transform(client, (send) => bounded(bounds, send))
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
