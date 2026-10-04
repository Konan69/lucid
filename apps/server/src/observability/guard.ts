import * as Cause from 'effect/Cause'
import * as Exit from 'effect/Exit'
import * as Logger from 'effect/Logger'
import * as Option from 'effect/Option'
import * as Result from 'effect/Result'
import * as Tracer from 'effect/Tracer'
import { type FailureKind, summarize } from './failure.ts'

/**
 * Runs one call into the exporter's tracer or logger and lets nothing it throws out.
 *
 * This is the second place in the server where a thrown value is caught and discarded
 * (`failure.ts` `summarize` is the first), and the reason is the same. A span's `end`, `event`,
 * `attribute` and `addLinks`, and a logger's `log`, are synchronous callbacks the Effect runtime
 * calls from inside the program being observed, not Effect programs, so a typed failure is not
 * available to them and `Result.try` is the tool:
 *
 * - rc.116 `internal/effect.ts` `useSpan` ends a span in the `onExit` finalizer of the effect it
 *   wraps (`endSpan`: `sync(() => span.end(…))`), and `makeSpanScoped` in a scope finalizer. What
 *   `end` throws is a defect of that finalizer, so it is added to the cause of an effect that
 *   failed and makes a failure of one that succeeded.
 * - rc.116 `internal/effect.ts` `logWithLevel` calls every logger's `log` inside the `Effect.log…`
 *   effect, so what a logger throws is that effect's defect.
 *
 * Either way telemetry would change the outcome it describes: a boundary that answers a typed
 * failure would see a defect beside it and answer `500`. So what throws here is dropped (the
 * span, the event or the line is not exported) and the caller sees nothing.
 *
 * A span or line dropped here is not counted. The exporter's drop count (`export.ts` `drop`) is
 * of batches a signal's HTTP client gave up on, kept in an Effect `Ref` that this synchronous
 * callback cannot update. With the stand-in below, what still reaches this catch is a span
 * attribute, an event attribute or a log annotation whose value throws when it is formatted.
 */
const contained = (call: () => void): void => Result.getOrElse(Result.try(call), () => undefined)

/**
 * What stands in for a failure's value where the exporter would read it: its type, as
 * `failure.ts` takes it from the class (`summarize`), and nothing else.
 *
 * A record, not an `Error`: constructing an `Error` captures a stack, and that stack would be
 * this module's. rc.116 `causePrettyError` accepts either, reads `message`, `cause`, `name` and
 * `stack` from it, and finds here two strings and two absences.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- A failure is unknown by Effect's contract (`Die.defect`, the generic error channel); `summarize` is where it is decoded.
const standIn = (kind: FailureKind, failure: unknown) => ({
  name: summarize(kind, failure).type,
  message: '',
})

/**
 * A cause with the same reasons in the same order, each failure and defect replaced by its
 * stand-in. Interruptions are kept as they are: they hold a fiber id and nothing thrown.
 *
 * This is what the exporter is given in place of the real cause, because of what it does with
 * one. rc.116 `OtlpTracer.ts` `makeOtlpSpan` calls `Cause.prettyErrors` on a failed span's cause,
 * and `OtlpLogger.ts` `makeLogRecord` calls `Cause.pretty` on a logged one. Both reach
 * `internal/effect.ts` `causePrettyError`, which runs the failure's own code and trusts its shape:
 *
 * - it reads `message`, `name`, `stack` and `cause`, so a getter that throws, a `Proxy` whose
 *   traps throw, or a revoked `Proxy` throws out of it;
 * - it follows `cause` by recursion with no bound and no memory of where it has been, so a
 *   failure whose `cause` is itself, or a cycle of two, overflows the stack;
 * - it copies every own enumerable property of the failure onto the `Error` it builds, and
 *   renders one that has no `message` in full (`formatJson`), so the cost grows with whatever the
 *   failure carries.
 *
 * None of what that produces is exported: the allowlist (`export.ts` `rulesOf`) drops the
 * message, the stack and the rendered cause, and keeps `exception.type` only when it is a fixed
 * name. So the exporter loses nothing by being given the type alone, and the failure's code is
 * never run on its behalf. `summarize` reads the failure too, but bounded, without recursion, and
 * inside its own catch.
 *
 * The reasons' annotations (the stack frames Effect attaches) are not carried over: they are
 * rendered into the stack trace, which does not leave.
 *
 * `exception.type` therefore follows `error.type`: a failure whose `name` property was assigned
 * is exported under its class's name where rc.116 would have written the assigned text and the
 * allowlist would have dropped it.
 */
const standInCause = (cause: Cause.Cause<unknown>): Cause.Cause<unknown> =>
  Cause.fromReasons(
    cause.reasons.map((reason): Cause.Reason<unknown> => {
      if (Cause.isFailReason(reason)) return Cause.makeFailReason(standIn('expected', reason.error))
      if (Cause.isDieReason(reason)) return Cause.makeDieReason(standIn('defect', reason.defect))
      return reason
    }),
  )

/**
 * A span of the exporter's tracer that cannot throw into the program it measures.
 *
 * Every read is the inner span's own, taken when asked: rc.116 `OtlpTracer.ts` `SpanImpl` makes
 * `traceId`, `spanId` and `attributes` on first read, and `links` is the array `addLinks` grows.
 * The four methods are contained (`contained`). In rc.116 only `end` does work that can throw
 * (`makeOtlpSpan`: the cause, and `OtlpResource.ts` `entriesToAttributes` formatting an attribute
 * or event value that is an object); the other three store what they are given. All four are
 * contained because the contract is the `Tracer.Span` interface, not that class.
 *
 * `end` hands the inner span a copy of the exit whose cause holds stand-ins (`standInCause`).
 * The exit the program ends with is not that copy: it is the one the runtime already holds, and
 * this span's own `status` reports it. The status is kept here, not read back from the inner
 * span, so that a span whose `end` threw still reads as ended (rc.116 `endSpan` asks) and nobody
 * who reads `status.exit` is handed the stand-in.
 *
 * An object with accessors, where the code is otherwise free of them, because `Tracer.Span` is
 * the framework's interface and its fields are read as properties.
 */
const guardedSpan = (inner: Tracer.Span): Tracer.Span => {
  let ended = Option.none<Tracer.SpanStatus>()
  return {
    // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- `Tracer.Span` is Effect's interface and rc.116 exports no constructor for it; `OtlpTracer.ts` `SpanImpl` writes the tag the same way.
    _tag: 'Span',
    name: inner.name,
    parent: inner.parent,
    annotations: inner.annotations,
    sampled: inner.sampled,
    kind: inner.kind,
    get spanId() {
      return inner.spanId
    },
    get traceId() {
      return inner.traceId
    },
    get attributes() {
      return inner.attributes
    },
    get links() {
      return inner.links
    },
    get status() {
      return Option.getOrElse(ended, () => inner.status)
    },
    end: (endTime, exit) => {
      // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- `Tracer.SpanStatus` is Effect's interface with no constructor; rc.116 `SpanImpl.end` builds it as a literal too.
      ended = Option.some({ _tag: 'Ended', startTime: inner.status.startTime, endTime, exit })
      contained(() => {
        inner.end(endTime, Exit.isSuccess(exit) ? exit : Exit.failCause(standInCause(exit.cause)))
      })
    },
    attribute: (key, value) => {
      contained(() => {
        inner.attribute(key, value)
      })
    },
    event: (name, startTime, attributes) => {
      contained(() => {
        inner.event(name, startTime, attributes)
      })
    },
    addLinks: (links) => {
      contained(() => {
        inner.addLinks(links)
      })
    },
  }
}

/**
 * The exporter's tracer, with every span it makes guarded (`guardedSpan`).
 *
 * It wraps the `Tracer` service through `Tracer.make`, the public constructor, and leaves the
 * tracer it is given as it is: nothing of `OtlpTracer` is copied or reassigned. `context` is
 * handed on as given; rc.116 `OtlpTracer.make` sets one only when asked to, and Vivid does not
 * ask.
 */
export const guardedTracer = (inner: Tracer.Tracer): Tracer.Tracer =>
  Tracer.make({
    span: (options) => guardedSpan(inner.span(options)),
    context: inner.context,
  })

/**
 * The exporter's logger, unable to throw into the `Effect.log…` call it serves.
 *
 * rc.116 `OtlpLogger.ts` `makeLogRecord` renders the logged cause (`Cause.pretty`) and formats
 * every annotation and the message; the first runs a failure's code (`standInCause`) and the
 * others format whatever object they are given. `failure.ts` logs strings and no cause, so its
 * lines reach neither, but any module may log a cause, and the exporter must not be what makes
 * that fail. The cause is replaced by its stand-in, and the call is contained for the rest.
 *
 * What this cannot cover is Effect's own two loggers, which are installed with or without export
 * and render a logged cause the same way (rc.116 `internal/effect.ts` `defaultLogger`,
 * `tracerLogger`: `causePretty`). Logging a cause whose failure throws when read fails there,
 * export on or off.
 */
export const guardedLogger = (inner: Logger.Logger<unknown, void>): Logger.Logger<unknown, void> =>
  Logger.make(({ cause, date, fiber, logLevel, message }) => {
    contained(() => {
      inner.log({ cause: standInCause(cause), date, fiber, logLevel, message })
    })
  })
