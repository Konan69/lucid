import * as Arr from 'effect/Array'
import * as Cause from 'effect/Cause'
import type * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Exit from 'effect/Exit'
import * as Logger from 'effect/Logger'
import type * as LogLevel from 'effect/LogLevel'
import * as Option from 'effect/Option'
import * as Predicate from 'effect/Predicate'
import * as References from 'effect/References'
import * as Result from 'effect/Result'
import * as Tracer from 'effect/Tracer'
import type { AnyValue } from 'effect/unstable/observability/OtlpResource'
import type * as OtlpSerialization from 'effect/unstable/observability/OtlpSerialization'
import { type FailureKind, summarize } from './failure.ts'
import { isMessage, OMITTED } from './messages.ts'

/**
 * What stands between the program and the exporter's tracer and logger.
 *
 * The rule of this module: everything it does is bounded by a size written here, and it hands
 * the exporter's code plain values it made itself, never an object the program gave it. A span's
 * options, its parent, an attribute's value, an event's attributes, a log's message, its
 * annotations and a cause are all whatever the program passed, and rc.116 trusts them:
 *
 * - `OtlpResource.ts` `unknownToAttributeValue` converts an attribute's value by recursion with no
 *   bound and no memory. `[0]` replaced thirty times by `[previous, previous]` is sixty arrays,
 *   and converting it allocates a thousand million leaves. Nothing contains that: the call does
 *   not throw, it does not return.
 * - `OtlpLogger.ts` `makeLogRecord` converts every annotation and the message the same way, and
 *   reads them from the fiber, so no guard in front of that logger can filter what it sees.
 * - `OtlpTracer.ts` `SpanImpl` reads `parent.value.traceId` when its own id is first asked for,
 *   and `makeOtlpSpan` reads the parent, the links and the cause when the span ends.
 *
 * So the export allowlist's keys are applied here, before conversion: a key that is not on it, or
 * a value that is not a short string, a finite number or a boolean, never reaches the exporter.
 * The allowlist at serialization (`export.ts` `rulesOf`) stays as the second line, and is the one
 * that checks what each value must be.
 */

/** The keys the export allowlist names; `export.ts` builds them (`rulesOf`). */
export type Keys = ReadonlySet<string>

/** Longest attribute key looked up. The longest key on the allowlist is far shorter. */
const LONGEST_KEY = 120
/** Longest string kept as an attribute's value: a table's name, a code name, a commit. */
const LONGEST_VALUE = 256
/** Longest span, event or message name looked at; `messages.ts` bounds a code name the same. */
const LONGEST_NAME = 120
/**
 * Most events and most links one span keeps, the limits OpenTelemetry's SDKs default to
 * (`SpanLimits`: 128 each). A span is open for as long as its work runs, and rc.116
 * `tracerLogger` adds an event for every line logged under it.
 */
const MOST_EVENTS = 128
const MOST_LINKS = 128
/** Most reasons of a cause that are handed on; each becomes an event on the span. */
const MOST_REASONS = 16

/** An attribute value the exporter is given: one of these, never an object. */
type Kept = string | number | boolean

/**
 * Runs one piece of work on a span or a log line and lets nothing it throws out.
 *
 * This is the second place in the server where a thrown value is caught and discarded
 * (`failure.ts` `summarize` is the first), and the reason is the same. A tracer's `span`, a
 * span's `end`, `event`, `attribute` and `addLinks`, and a logger's `log`, are synchronous
 * callbacks the Effect runtime calls from inside the program being observed, not Effect programs,
 * so a typed failure is not available to them and `Result.try` is the tool:
 *
 * - rc.116 `internal/effect.ts` `makeSpanUnsafe` calls `tracer.span` and then `span.attribute`
 *   inside the effect that opens the span, so what either throws is that effect's defect.
 * - `useSpan` ends a span in the `onExit` finalizer of the effect it wraps (`endSpan`:
 *   `sync(() => span.end(…))`), and `makeSpanScoped` in a scope finalizer. What `end` throws is a
 *   defect of that finalizer, so it is added to the cause of an effect that failed and makes a
 *   failure of one that succeeded.
 * - `logWithLevel` calls every logger's `log` inside the `Effect.log…` effect, so what a logger
 *   throws is that effect's defect.
 *
 * Either way telemetry would change the outcome it describes: a boundary that answers a typed
 * failure would see a defect beside it and answer `500`. So what throws here is dropped (the
 * attribute, the event or the line is not exported) and the caller sees nothing.
 *
 * What still throws here is the program's own value being read: a getter or a `Proxy` trap. The
 * exporter's code is given only what this module built, so it has nothing left to throw on.
 * A span or line dropped here is not counted: the exporter's drop count (`export.ts` `drop`) is
 * kept in an Effect `Ref` that this synchronous callback cannot update.
 */
const contained = (call: () => void): void => Result.getOrElse(Result.try(call), () => undefined)

/**
 * The value of an attribute when it is one the exporter may be given: a string of at most
 * `LONGEST_VALUE` characters, a finite number, or a boolean. Only the value's type and a string's
 * length are looked at, so a string of ten megabytes costs what a short one does and is not
 * copied, and an array or an object is never walked.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- An attribute's value is unknown by the `Tracer.Span` contract; this is where it is decided.
const keptValue = (value: unknown): Option.Option<Kept> => {
  if (Predicate.isString(value))
    return value.length <= LONGEST_VALUE ? Option.some(value) : Option.none()
  if (Predicate.isNumber(value)) return Number.isFinite(value) ? Option.some(value) : Option.none()
  return Predicate.isBoolean(value) ? Option.some(value) : Option.none()
}

/**
 * The allowlisted attributes of a record, as a new record of kept values.
 *
 * It asks the record for each allowlisted key and never lists the record's own, so the cost is
 * the size of the allowlist whatever the record holds. Each value is read once. Reading runs the
 * record's code when it is a `Proxy` or has getters; the caller contains that.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Event and link attributes and log annotations are the program's own objects; only allowlisted keys are read from them.
const keptOf = (keys: Keys, record: unknown): Record<string, Kept> =>
  Predicate.isObject(record)
    ? Object.fromEntries(
        Arr.fromIterable(keys).flatMap((key) =>
          Predicate.hasProperty(record, key)
            ? Option.toArray(Option.map(keptValue(record[key]), (value) => [key, value] as const))
            : [],
        ),
      )
    : {}

/** A name when it is one of the fixed messages; the placeholder for any other text or value. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- A log's message is unknown by the `Logger` contract, and an event's name is whatever was passed.
const messageOf = (name: unknown): string =>
  Predicate.isString(name) && name.length <= LONGEST_NAME && isMessage(name) ? name : OMITTED

const HEX = /^[0-9a-f]+$/i
const ZERO = /^0+$/

/**
 * Hexadecimal digits of exactly one of the given lengths, not all zero. An id is typed as a string
 * and is whatever a header or a foreign tracer supplied, so that it is a string is asked, and its
 * length before any pattern reads it.
 */
const isId = (id: string, lengths: ReadonlyArray<number>) =>
  Predicate.isString(id) && lengths.includes(id.length) && HEX.test(id) && !ZERO.test(id)

/**
 * Whether `id` is a span id: 16 hexadecimal digits that are not all zero. OpenTelemetry defines
 * the all-zero span id as invalid, and so does B3; it is what a caller sends when it has no id, so
 * it names no span and is treated like any other text that is not an id.
 */
export const isSpanId = (id: string) => isId(id, [16])

/**
 * Whether `id` is a trace id as a caller may send one: 32 hexadecimal digits, or the 16 of B3's
 * 64-bit form (`export.ts` `traceIdOf` widens it), not all zero.
 */
export const isTraceId = (id: string) => isId(id, [16, 32])

/**
 * OpenTelemetry's invalid span id. It is the parent's span id where the caller's trace id is
 * sound and its span id is not: rc.116 `SpanImpl` takes a trace id only from a parent, so the
 * parent is kept for its trace, and `export.ts` `allowSpan` leaves this id off, which exports the
 * span as a root of that trace.
 */
const NO_SPAN = '0'.repeat(16)

/** The spans one guarded tracer has made. Reading one of them runs only this module's code. */
type Own = WeakSet<object>

/**
 * A span in a form that is safe to keep and to hand to the exporter: one this tracer made, or a
 * new `ExternalSpan` holding the three fields read once from the one given, its ids checked.
 * Absent when the trace id is not an id, because then there is no trace to file anything under.
 *
 * A parent or a linked span is the program's object. rc.116 `HttpTraceContext` builds one from
 * `b3` headers as they were sent, and `Effect.withParentSpan` and `Effect.linkSpans` take any
 * object. Reading one can throw; the caller contains that.
 */
const plainSpan = (own: Own, span: Tracer.AnySpan): Option.Option<Tracer.AnySpan> => {
  if (own.has(span)) return Option.some(span)
  const { traceId, spanId, sampled } = span
  return isTraceId(traceId)
    ? Option.some(
        Tracer.externalSpan({
          traceId,
          spanId: isSpanId(spanId) ? spanId : NO_SPAN,
          sampled: Predicate.isBoolean(sampled) && sampled,
        }),
      )
    : Option.none()
}

/** What `plainSpan` and `keptOf` need to read the program's spans and attributes. */
interface Reading {
  readonly own: Own
  readonly keys: Keys
}

/**
 * At most `room` links, each to a plain span with allowlisted attributes. A link to a span whose
 * trace id is not an id is left out. Only the first `room` entries of the array are read.
 */
const plainLinks = (
  { own, keys }: Reading,
  links: ReadonlyArray<Tracer.SpanLink>,
  room: number,
): Array<Tracer.SpanLink> =>
  links.slice(0, Math.max(room, 0)).flatMap(({ span, attributes }) =>
    Option.toArray(
      Option.map(plainSpan(own, span), (plain) => ({
        span: plain,
        attributes: keptOf(keys, attributes),
      })),
    ),
  )

/** What the Effect runtime passes when it asks a tracer for a span (rc.116 `Tracer.ts` `Tracer`). */
type SpanOptions = Parameters<Tracer.Tracer['span']>[0]

const KINDS: ReadonlyArray<Tracer.SpanKind> = [
  'internal',
  'server',
  'client',
  'producer',
  'consumer',
]

/**
 * The options of a span whose own could not be read: nothing is known about it, so it has no
 * name, no parent and no links, and it is not sampled, which is how a span is made that records
 * and exports nothing (rc.116 `OtlpTracer.ts` `exportFn` returns at once for one). Its children
 * inherit that (`makeSpanUnsafe`: a parent that is not sampled makes a child that is not).
 *
 * rc.116 has a span that does nothing (`internal/effect.ts` `noopSpan`), but it is not exported,
 * and its ids are the text `noop`, which a client would send on as a trace id.
 */
const unreadable = (): SpanOptions => ({
  name: OMITTED,
  parent: Option.none(),
  annotations: Context.empty(),
  links: [],
  startTime: 0n,
  kind: 'internal',
  root: true,
  sampled: false,
})

/**
 * A span's options as plain values of this module's own, each option read exactly once.
 *
 * - The name is kept when it is a string no longer than a code name can be, else the placeholder.
 * - The parent and the links are made plain (`plainSpan`, `plainLinks`).
 * - The kind is one of the five, the start time a `bigint` (zero is what rc.116 passes when timing
 *   is off), the annotations Effect's own `Context`.
 * - A span under a parent whose trace id is not an id has no parent and is not sampled: there is
 *   no trace to export it under, and an unsampled span is what keeps its children out too. Before
 *   this the text was inherited as a trace id by every span beneath, and sent on to whatever the
 *   request called.
 *
 * Reading can throw; the caller contains that and uses `unreadable`.
 */
const plainOptions = (reading: Reading, options: SpanOptions): SpanOptions => {
  const { name, parent, annotations, links, startTime, kind, sampled } = options
  const sound = Option.isNone(parent)
    ? Option.some(Option.none<Tracer.AnySpan>())
    : Option.map(plainSpan(reading.own, parent.value), Option.some)
  const plainParent = Option.flatten(sound)
  return {
    name: Predicate.isString(name) && name.length <= LONGEST_NAME ? name : OMITTED,
    parent: plainParent,
    annotations: Context.isContext(annotations) ? annotations : Context.empty(),
    links: plainLinks(reading, links, MOST_LINKS),
    startTime: Predicate.isBigInt(startTime) ? startTime : 0n,
    kind: Option.getOrElse(
      Arr.findFirst(KINDS, (known) => known === kind),
      (): Tracer.SpanKind => 'internal',
    ),
    root: Option.isNone(plainParent),
    sampled: Option.isSome(sound) && Predicate.isBoolean(sampled) && sampled,
  }
}

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
 * A cause with the first `MOST_REASONS` reasons in the same order, each failure and defect
 * replaced by its stand-in. Interruptions are kept as they are: they hold a fiber id and nothing
 * thrown.
 *
 * This is what the exporter is given in place of the real cause, because of what it does with
 * one. rc.116 `OtlpTracer.ts` `makeOtlpSpan` calls `Cause.prettyErrors` on a failed span's cause.
 * That reaches `internal/effect.ts` `causePrettyError`, which runs the failure's own code and
 * trusts its shape:
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
    cause.reasons.slice(0, MOST_REASONS).map((reason): Cause.Reason<unknown> => {
      if (Cause.isFailReason(reason)) return Cause.makeFailReason(standIn('expected', reason.error))
      if (Cause.isDieReason(reason)) return Cause.makeDieReason(standIn('defect', reason.defect))
      return reason
    }),
  )

/** A guarded span's parts: the exporter's span, and the plain options that span was made from. */
interface Guarded extends Reading {
  readonly inner: Tracer.Span
  readonly plain: SpanOptions
}

/**
 * A span of the exporter's tracer that cannot throw into the program it measures, and that gives
 * the exporter nothing the program made.
 *
 * - What it reports about itself (`name`, `parent`, `kind`, `sampled`, `annotations`, the start
 *   time) is the plain options it was made from. The original options and parent are not held.
 * - `traceId`, `spanId`, `attributes` and `links` are the inner span's, read when asked. The inner
 *   span was made from those same plain options, so rc.116 `SpanImpl` reading its parent for a
 *   trace id reads a value of this module's.
 * - `attribute` forwards an allowlisted key with a kept value, and nothing else (`keptValue`).
 *   The attributes given when a span is opened come through here too (rc.116 `makeSpanUnsafe`
 *   calls `span.attribute` for each).
 * - `event` forwards a fixed message or the placeholder as the name, with allowlisted attributes,
 *   for the first `MOST_EVENTS` events.
 * - `addLinks` forwards plain links while there is room under `MOST_LINKS`.
 * - `end` hands the inner span `Exit.void` for a success, since the value is the program's, and
 *   for a failure a cause of stand-ins (`standInCause`). The exit the program ends with is
 *   neither: it is the one the runtime already holds, and this span's own `status` reports it.
 *   The status is kept here, not read back from the inner span, so that a span whose `end` threw
 *   still reads as ended (rc.116 `endSpan` asks) and nobody who reads `status.exit` is handed the
 *   stand-in.
 *
 * An object with accessors, where the code is otherwise free of them, because `Tracer.Span` is
 * the framework's interface and its fields are read as properties.
 */
const guardedSpan = ({ inner, plain, keys, own }: Guarded): Tracer.Span => {
  let ended = Option.none<Tracer.SpanStatus>()
  let events = 0
  return {
    // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- `Tracer.Span` is Effect's interface and rc.116 exports no constructor for it; `OtlpTracer.ts` `SpanImpl` writes the tag the same way.
    _tag: 'Span',
    name: plain.name,
    parent: plain.parent,
    annotations: plain.annotations,
    sampled: plain.sampled,
    kind: plain.kind,
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
      return Option.getOrElse(
        ended,
        // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- `Tracer.SpanStatus` is Effect's interface with no constructor; rc.116 `SpanImpl` builds it as a literal too.
        (): Tracer.SpanStatus => ({ _tag: 'Started', startTime: plain.startTime }),
      )
    },
    end: (endTime, exit) => {
      // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- See `status`.
      ended = Option.some({ _tag: 'Ended', startTime: plain.startTime, endTime, exit })
      contained(() => {
        if (!Predicate.isBigInt(endTime)) return
        inner.end(
          endTime,
          Exit.isSuccess(exit) ? Exit.void : Exit.failCause(standInCause(exit.cause)),
        )
      })
    },
    attribute: (key, value) => {
      contained(() => {
        if (!Predicate.isString(key) || key.length > LONGEST_KEY || !keys.has(key)) return
        const kept = keptValue(value)
        if (Option.isSome(kept)) inner.attribute(key, kept.value)
      })
    },
    event: (name, startTime, attributes) => {
      contained(() => {
        if (events >= MOST_EVENTS || !Predicate.isBigInt(startTime)) return
        events += 1
        inner.event(messageOf(name), startTime, keptOf(keys, attributes))
      })
    },
    addLinks: (links) => {
      contained(() => {
        inner.addLinks(plainLinks({ own, keys }, links, MOST_LINKS - inner.links.length))
      })
    },
  }
}

/**
 * The exporter's tracer, with every span it makes guarded (`guardedSpan`).
 *
 * A span's options are read once, under containment, into plain values (`plainOptions`), and the
 * inner tracer is given those. When they cannot be read the span is made from `unreadable`, which
 * records and exports nothing, and the program goes on as it would have. rc.116 `OtlpTracer`'s
 * `span` only stores its options and cannot throw on plain ones; were another tracer's to throw,
 * Effect's in-memory span (`Tracer.NativeSpan`), which exports nowhere, takes its place.
 *
 * It wraps the `Tracer` service through `Tracer.make`, the public constructor, and leaves the
 * tracer it is given as it is: nothing of `OtlpTracer` is copied or reassigned. `context` is
 * handed on as given; rc.116 `OtlpTracer.make` sets one only when asked to, and Vivid does not
 * ask.
 */
export const guardedTracer = (inner: Tracer.Tracer, keys: Keys): Tracer.Tracer => {
  const own: Own = new WeakSet()
  return Tracer.make({
    span: (options) => {
      const plain = Result.getOrElse(
        Result.try(() => plainOptions({ own, keys }, options)),
        unreadable,
      )
      const span = guardedSpan({
        inner: Result.getOrElse(
          Result.try(() => inner.span(plain)),
          () => new Tracer.NativeSpan(plain),
        ),
        plain,
        keys,
        own,
      })
      own.add(span)
      return span
    },
    context: inner.context,
  })
}

type Logs = Parameters<OtlpSerialization.OtlpSerialization['Service']['logs']>[0]

/** One log record as OTLP carries it (rc.116 `OtlpLogger.ts` `ILogRecord`, which is not exported). */
export type ExportedLine = NonNullable<
  Logs['resourceLogs'][number]['scopeLogs'][number]['logRecords']
>[number]

/**
 * OTLP's severity number for each level: rc.116 `OtlpLogger.ts` `logLevelToSeverityNumber` and
 * `ESeverityNumber`, neither exported. `All` and `None` are thresholds and not levels a line is
 * written at; the reference gives them `UNSPECIFIED`.
 */
const SEVERITY: Record<LogLevel.LogLevel, NonNullable<ExportedLine['severityNumber']>> = {
  All: 0,
  Trace: 1,
  Debug: 5,
  Info: 9,
  Warn: 13,
  Error: 17,
  Fatal: 21,
  None: 0,
}

/** A kept value as an OTLP value: rc.116 `OtlpResource.ts` `unknownToAttributeValue`, for the three kinds there are. */
const anyValue = (value: Kept): AnyValue => {
  if (Predicate.isString(value)) return { stringValue: value }
  if (Predicate.isBoolean(value)) return { boolValue: value }
  return Number.isInteger(value) ? { intValue: value } : { doubleValue: value }
}

/** A log's message when it is, alone, one of the fixed messages; otherwise the placeholder. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- A log's message is unknown by the `Logger` contract: one value, or the array of everything that was logged.
const bodyOf = (message: unknown): string => {
  const parts: ReadonlyArray<unknown> = Array.isArray(message) ? message : [message]
  return parts.length === 1 ? messageOf(parts[0]) : OMITTED
}

/**
 * The span a line names: the fiber's current span, when it is sampled and its ids are ids. A span
 * that is not sampled is not exported, so a line that named it would point at nothing; before
 * this, such a line carried the ids anyway.
 */
const spanOf = ({ traceId, spanId, sampled }: Tracer.AnySpan) =>
  Predicate.isBoolean(sampled) && sampled && isTraceId(traceId) && isSpanId(spanId)
    ? Option.some({ traceId, spanId })
    : Option.none()

/**
 * The logger that exports, written here in place of rc.116 `OtlpLogger.make`.
 *
 * That logger cannot be guarded from outside. `makeLogRecord` takes the annotations from the
 * fiber it is handed (`fiber.getRef(CurrentLogAnnotations)`), not from an argument, and converts
 * each of them and the message with `unknownToAttributeValue`, which walks any object to its
 * leaves; it renders the cause with `Cause.pretty`, which runs the failure's code. A wrapper can
 * change the message and the cause it passes on, and cannot change the fiber.
 *
 * So the record is built here, a port of `makeLogRecord` that reads only what can leave:
 *
 * - the body is one of the fixed messages (`messages.ts`) or the placeholder;
 * - the level and its number are the fiber's (`SEVERITY`);
 * - the attributes are the allowlisted annotations with kept values (`keptOf`);
 * - both times are the clock's, as in the reference;
 * - the trace and span are the current span's when it is exported (`spanOf`).
 *
 * The reference's `fiberId`, `logSpan.*` and `log.error` attributes are not built: none is on the
 * allowlist, so none ever left, and the last is the rendered cause. The cause is not read at all.
 *
 * `push` hands the record to the batch exporter (`export.ts`), which serializes it later through
 * the allowlist. `fiber.cache.span` is where rc.116 keeps the current span, and is what the
 * reference reads.
 */
export const exportingLogger = (
  keys: Keys,
  clock: Clock.Clock,
  push: (line: ExportedLine) => void,
): Logger.Logger<unknown, void> =>
  Logger.make(({ fiber, logLevel, message }) => {
    contained(() => {
      const now = String(clock.currentTimeNanosUnsafe())
      const span = Option.flatMap(Option.fromUndefinedOr(fiber.cache.span), spanOf)
      push({
        timeUnixNano: now,
        observedTimeUnixNano: now,
        severityNumber: SEVERITY[logLevel],
        severityText: logLevel,
        body: { stringValue: bodyOf(message) },
        attributes: Object.entries(
          keptOf(keys, fiber.getRef(References.CurrentLogAnnotations)),
        ).map(([key, value]) => ({ key, value: anyValue(value) })),
        droppedAttributesCount: 0,
        traceId: Option.getOrUndefined(Option.map(span, ({ traceId }) => traceId)),
        spanId: Option.getOrUndefined(Option.map(span, ({ spanId }) => spanId)),
      })
    })
  })
