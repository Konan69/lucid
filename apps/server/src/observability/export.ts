import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as HttpBody from 'effect/unstable/http/HttpBody'
import * as OtlpLogger from 'effect/unstable/observability/OtlpLogger'
import type { AnyValue, KeyValue } from 'effect/unstable/observability/OtlpResource'
import * as OtlpSerialization from 'effect/unstable/observability/OtlpSerialization'
import * as OtlpTracer from 'effect/unstable/observability/OtlpTracer'
import { ObservabilityConfiguration } from '../config.ts'
import { redact } from './failure.ts'

/** The name every span and log line of this process is filed under. */
const SERVICE = 'vivid-server'

/** OTLP's value is a one-of; text is redacted wherever it sits, including inside lists and maps. */
const cleanValue = (value: AnyValue): AnyValue => {
  if (value.stringValue !== undefined && value.stringValue !== null)
    return { stringValue: redact(value.stringValue) }
  if (value.arrayValue !== undefined)
    return { arrayValue: { values: value.arrayValue.values.map(cleanValue) } }
  if (value.kvlistValue !== undefined)
    return { kvlistValue: { values: value.kvlistValue.values.map(cleanPair) } }
  return value
}

const cleanPair = (pair: KeyValue): KeyValue => ({ key: pair.key, value: cleanValue(pair.value) })

type Traces = Parameters<OtlpSerialization.OtlpSerialization['Service']['traces']>[0]
type Logs = Parameters<OtlpSerialization.OtlpSerialization['Service']['logs']>[0]
type ExportedSpan = Traces['resourceSpans'][number]['scopeSpans'][number]['spans'][number]
type ScopeLogs = Logs['resourceLogs'][number]['scopeLogs'][number]

/**
 * A span's attributes, its events and its status message. The events matter most: rc.116
 * `OtlpTracer.ts` `makeOtlpSpan` adds an `exception` event to every failed span holding the
 * error's raw message and stack, which no attribute written by this server ever passes through.
 */
const cleanSpan = (span: ExportedSpan): ExportedSpan => ({
  ...span,
  attributes: span.attributes.map(cleanPair),
  events: span.events.map((event) => ({ ...event, attributes: event.attributes.map(cleanPair) })),
  status:
    span.status.message === undefined
      ? span.status
      : { code: span.status.code, message: redact(span.status.message) },
})

/** A log line's body and attributes; `log.error` there is a rendered cause, messages and all. */
const cleanScopeLogs = (scope: ScopeLogs): ScopeLogs =>
  scope.logRecords === undefined
    ? scope
    : {
        ...scope,
        logRecords: scope.logRecords.map((line) => ({
          ...line,
          attributes: line.attributes.map(cleanPair),
          body: line.body === undefined ? undefined : cleanValue(line.body),
        })),
      }

const cleanTraces = (data: Traces): Traces => ({
  resourceSpans: data.resourceSpans.map((resource) => ({
    ...resource,
    scopeSpans: resource.scopeSpans.map((scope) => ({
      ...scope,
      spans: scope.spans.map(cleanSpan),
    })),
  })),
})

const cleanLogs = (data: Logs): Logs => ({
  resourceLogs: data.resourceLogs.map((resource) => ({
    ...resource,
    scopeLogs: resource.scopeLogs.map(cleanScopeLogs),
  })),
})

/**
 * OTLP/HTTP JSON, with every string that leaves the process passed through `redact` first.
 *
 * `OtlpSerialization` is the one place both signals cross on their way out, so redacting here
 * covers what this server never authored: the tracer's exception events, a logged cause, an HTTP
 * client span's address with its query string. Sentry accepts JSON on the traces and logs paths;
 * metrics are not installed (its OTLP endpoint has no metrics path), so that encoder is the plain
 * one and is never called.
 */
const redactedSerializationLayer = Layer.succeed(OtlpSerialization.OtlpSerialization, {
  traces: (data) => HttpBody.jsonUnsafe(cleanTraces(data)),
  logs: (data) => HttpBody.jsonUnsafe(cleanLogs(data)),
  metrics: (data) => HttpBody.jsonUnsafe(data),
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
 * - `mergeWithExisting` keeps the default logger, so stdout still shows every line that is
 *   exported.
 * - The resource names the service, and the environment and commit when the host supplies them.
 *   The environment is written under both the current semantic-convention name and the one it
 *   replaced, because which of the two the backend reads was not verified.
 *
 * The exporter batches on a timer and flushes when the Layer's scope closes, bounded by its own
 * shutdown timeout (rc.116 `OtlpExporter.ts` `make`); `Flusher` in the output drains it on demand.
 */
export const observabilityLayer = (configuration: ObservabilityConfiguration) =>
  ObservabilityConfiguration.$match(configuration, {
    Disabled: () => Layer.empty,
    Enabled: ({ url, headers, environment, commit }) => {
      const resource = {
        serviceName: SERVICE,
        serviceVersion: Option.getOrUndefined(commit),
        attributes: Option.match(environment, {
          onNone: () => ({}),
          onSome: (name) => ({
            'deployment.environment.name': name,
            'deployment.environment': name,
          }),
        }),
      }
      const credentials = Redacted.value(headers)
      return Layer.mergeAll(
        OtlpTracer.layer({ url: endpoint(url, 'traces'), resource, headers: credentials }),
        OtlpLogger.layer({
          url: endpoint(url, 'logs'),
          resource,
          headers: credentials,
          mergeWithExisting: true,
        }),
      ).pipe(Layer.provide(redactedSerializationLayer))
    },
  })
