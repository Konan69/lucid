import { isRoutineRefusal, isRemoteIncident } from '@vivid/contracts'
import { captureException, getActiveSpan, startInactiveSpan, type Span } from '@sentry/react-native'
import { Effect, ErrorReporter, Exit, Layer, Option, Predicate, Tracer } from 'effect'
import { Atom } from 'effect/reactivity'

type SpanOptions = ConstructorParameters<typeof Tracer.NativeSpan>[0]

/** Code-owned Effect names never contain route parameters or user-entered screen titles. */
const operation = (name: string) =>
  /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*){0,8}$/.test(name)
    ? name.slice(0, 120)
    : 'Mobile.operation'

/**
 * Adapt the public Effect span lifecycle to the existing native client. Explicit parent spans
 * keep concurrent machine invocations separate without a mutable global current operation.
 * RPC's existing per-call trace carrier then uses these same IDs on the server.
 */
class ReportingSpan extends Tracer.NativeSpan {
  readonly sentry: Span

  constructor(options: SpanOptions) {
    const parent = Option.getOrUndefined(options.parent)
    const sentry = startInactiveSpan({
      name: operation(options.name),
      op: 'function.effect',
      parentSpan: parent instanceof ReportingSpan ? parent.sentry : getActiveSpan(),
      startTime: Number(options.startTime) / 1e9,
    })
    super({ ...options, sampled: options.sampled && sentry.isRecording() })
    this.sentry = sentry
  }

  override get traceId() {
    return this.sentry.spanContext().traceId
  }

  override get spanId() {
    return this.sentry.spanContext().spanId
  }

  /** Only the outcome is attached; the exception text can contain private product content. */
  override end(time: bigint, exit: Exit.Exit<unknown, unknown>): void {
    super.end(time, exit)
    this.sentry.setStatus({ code: Exit.isFailure(exit) ? 2 : 1 })
    this.sentry.end(Number(time) / 1e9)
  }
}

/** Share reporting across raw mobile entry points and every independently built machine runtime. */
export const telemetryLayer = Layer.mergeAll(
  Layer.succeed(
    Tracer.Tracer,
    Tracer.make({
      span: (options) =>
        options.sampled ? new ReportingSpan(options) : new Tracer.NativeSpan(options),
    }),
  ),
  ErrorReporter.layer([
    Effect.sync(() =>
      ErrorReporter.make(({ error, fiber }) => {
        if (isRoutineRefusal(error) || isRemoteIncident(error)) return
        const span = fiber.cache.span
        captureException(error, {
          captureContext: {
            level: 'error',
            tags:
              span !== undefined && Predicate.isTagged(span, 'Span')
                ? { 'vivid.operation': operation(span.name) }
                : undefined,
            contexts: {
              trace:
                span === undefined ? undefined : { trace_id: span.traceId, span_id: span.spanId },
            },
          },
        })
      }),
    ),
  ]),
)

// Register during module evaluation: App's imports can construct machines before index starts Sentry.
Atom.runtime.addGlobalLayer(telemetryLayer)
