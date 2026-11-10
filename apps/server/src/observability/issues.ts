import * as Sentry from '@sentry/effect/server'
import { impactOfFailure, impactSignal } from '@vivid/contracts'
import { Config, Effect, ErrorReporter, Layer, Option, Predicate } from 'effect'
import { incidentTags, isIncidentFingerprint, isIncidentMessage } from './incidents.ts'
import { isCodeName } from './messages.ts'

/** Keep symbolication coordinates without local account paths, request data or source contents. */
const codePath = (path: string) =>
  path.replace(/[?#].*$/u, '').replace(/^.*\/(?:home|Users)\/[^/]+\//, '')

/** Only this recorder writes the operation tag, from the current code-owned Effect span name. */
const operationTags = (tags: Sentry.Event['tags']) => {
  if (tags === undefined) return undefined
  const operation = tags['vivid.operation']
  return Predicate.isString(operation) && isCodeName(operation)
    ? { 'vivid.operation': operation }
    : undefined
}

/**
 * The tags an issue keeps: the operation, and an Incident's (`incidents.ts`), each by the rule the
 * OTLP export applies to the same key. Absent when none is left.
 */
const keptTags = (tags: Sentry.Event['tags']) => {
  const kept = { ...operationTags(tags), ...(tags === undefined ? {} : incidentTags(tags)) }
  return Object.keys(kept).length === 0 ? undefined : kept
}

/**
 * Build an issue payload rather than serializing arbitrary errors, causes or request scopes. An
 * Incident's event (`incidents.ts` `record`) keeps its message, which is its case's tag, and its
 * fingerprint, which is that tag and a code name per hop; any other message or fingerprint is not
 * one of those and is dropped.
 */
const scrub: NonNullable<Sentry.EffectServerLayerOptions['beforeSend']> = (event) => ({
  type: undefined,
  event_id: event.event_id,
  timestamp: event.timestamp,
  level: event.level,
  platform: event.platform,
  release: event.release,
  environment: event.environment,
  sdk: event.sdk,
  message:
    event.message !== undefined && isIncidentMessage(event.message) ? event.message : undefined,
  fingerprint:
    event.fingerprint !== undefined && isIncidentFingerprint(event.fingerprint)
      ? event.fingerprint
      : undefined,
  tags: keptTags(event.tags),
  contexts: {
    trace:
      event.contexts === undefined || event.contexts.trace === undefined
        ? undefined
        : {
            trace_id: event.contexts.trace.trace_id,
            span_id: event.contexts.trace.span_id,
          },
  },
  exception: {
    values:
      event.exception === undefined || event.exception.values === undefined
        ? undefined
        : event.exception.values.map((exception) => ({
            type:
              exception.type !== undefined && isCodeName(exception.type) ? exception.type : 'Error',
            value:
              exception.type !== undefined && isCodeName(exception.type) ? exception.type : 'Error',
            mechanism:
              exception.mechanism === undefined
                ? undefined
                : {
                    type: exception.mechanism.type,
                    handled: exception.mechanism.handled,
                    exception_id: exception.mechanism.exception_id,
                    parent_id: exception.mechanism.parent_id,
                  },
            stacktrace: {
              frames:
                exception.stacktrace === undefined || exception.stacktrace.frames === undefined
                  ? undefined
                  : exception.stacktrace.frames.map((frame) => ({
                      filename: frame.filename === undefined ? undefined : codePath(frame.filename),
                      function: frame.function,
                      module: frame.module,
                      lineno: frame.lineno,
                      colno: frame.colno,
                      in_app: frame.in_app,
                    })),
            },
          })),
  },
})

/**
 * Add issue capture beside OTLP, without installing another tracer. Effect owns the current
 * span, so copy its identity explicitly instead of assuming Node's async scope knows the fiber.
 * Reporting before recovery and at HTTP/RPC boundaries shares this reporter's deduplication.
 */
const reporterLayer = Layer.sync(
  ErrorReporter.CurrentErrorReporters,
  () =>
    new Set([
      ErrorReporter.make(({ error, fiber }) => {
        // An issue is opened by impact (`impactSignal`): a refusal the Person can correct is not one.
        if (
          Predicate.hasProperty(error, '_tag') &&
          Predicate.isString(error._tag) &&
          !impactSignal[impactOfFailure({ _tag: error._tag })].issue
        )
          return
        const span = fiber.cache.span
        Sentry.captureException(error, {
          captureContext: {
            level: 'error',
            tags:
              span !== undefined && Predicate.isTagged(span, 'Span')
                ? operationTags({ 'vivid.operation': span.name })
                : undefined,
            contexts: {
              trace:
                span === undefined ? undefined : { trace_id: span.traceId, span_id: span.spanId },
            },
          },
        })
      }),
    ]),
)

/**
 * The DSN is an ingest address, never an account-management credential. The SDK's light client
 * captures process failures; existing Effect OTLP remains responsible for performance and logs.
 * Flush while the application scope closes so a final failure is not left in an in-memory queue.
 */
export const issuesLayer = Layer.unwrap(
  Effect.gen(function* () {
    const dsn = yield* Config.option(Config.NonEmptyString('SENTRY_DSN'))
    if (Option.isNone(dsn)) return Layer.empty
    const environment = yield* Config.option(Config.NonEmptyString('VIVID_ENVIRONMENT'))
    const release = yield* Config.option(Config.NonEmptyString('VIVID_BUILD_COMMIT'))
    return reporterLayer.pipe(
      Layer.provide(
        Layer.effectDiscard(
          Effect.acquireRelease(
            Effect.sync(() =>
              Sentry.init({
                dsn: dsn.value,
                environment: Option.getOrUndefined(environment),
                release: Option.getOrUndefined(release),
                sendDefaultPii: false,
                beforeSend: scrub,
                integrations: (defaults) =>
                  defaults.filter((integration) =>
                    [
                      'InboundFilters',
                      'LinkedErrors',
                      'OnUncaughtException',
                      'OnUnhandledRejection',
                    ].includes(integration.name),
                  ),
              }),
            ),
            () => Effect.promise(() => Sentry.close(3000)),
          ),
        ),
      ),
    )
  }),
)
