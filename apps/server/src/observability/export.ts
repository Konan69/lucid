import type { GateDecision } from '../approvals/gate.ts'
import type { UnreviewedReason } from '../approvals/policy.ts'
import { getTableName, isTable } from 'drizzle-orm'
import { Commit, ModelFailureReason, GateBasis } from '@vivid/contracts'
import * as Arr from 'effect/Array'
import * as Clock from 'effect/Clock'
import * as Cause from 'effect/Cause'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as ErrorReporter from 'effect/ErrorReporter'
import * as Layer from 'effect/Layer'
import * as Logger from 'effect/Logger'
import * as Option from 'effect/Option'
import * as Predicate from 'effect/Predicate'
import * as Redacted from 'effect/Redacted'
import * as Ref from 'effect/Ref'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import * as Tracer from 'effect/Tracer'
import * as HttpBody from 'effect/http/HttpBody'
import * as HttpClient from 'effect/http/HttpClient'
import type { HttpClientError } from 'effect/http/HttpClientError'
import type { HttpClientResponse } from 'effect/http/HttpClientResponse'
import * as OtlpExporter from 'effect/observability/OtlpExporter'
import type { AnyValue, KeyValue, Resource } from 'effect/observability/OtlpResource'
import * as OtlpSerialization from 'effect/observability/OtlpSerialization'
import * as OtlpTracer from 'effect/observability/OtlpTracer'
import { ObservabilityConfiguration } from '../config.ts'
import * as productSchema from '../database/product.ts'
import { CallAttribute, LiveAttribute, MovedAttribute, QUERY, watchedNames } from '../live/tally.ts'
import { systemWordIds } from '@vivid/agent-runtime/voice'
import * as identitySchema from '../database/schema.ts'
import { Boundary, FailureAttribute, FailureKind, fixedTypeNames, UNTYPED } from './failure.ts'
import {
  type ExportedLine,
  exportingLogger,
  guardedTracer,
  isSpanId,
  isTraceId,
  type Keys,
  REMOTE_PARENT,
} from './guard.ts'
import { isCodeName, isMessage, Message, OMITTED, VOICE_WORD } from './messages.ts'
import { INCIDENT_KIND, incidentExport } from './incidents.ts'
import { refusalExport } from './refusal.ts'

/** The name every span and log line of this process is filed under. */
const SERVICE = 'vivid-server'

/** One of the two signals exported, as the last segment of its OTLP path. */
const Signals = ['traces', 'logs'] as const
type Signal = (typeof Signals)[number]

/** A lost export window needs an independent issue even while its OTLP signal is unavailable. */
class TelemetryExportPaused extends Schema.TaggedError<TelemetryExportPaused>()(
  'TelemetryExportPaused',
  { signal: Schema.Literals(Signals), batches: Schema.Int },
  { title: 'Telemetry export paused' },
) {}

/**
 * The attributes of the drop report: how many batches of a signal were lost since its last
 * report, which signal, and for how many seconds the exporter of that signal now accepts nothing.
 */
const DROPPED_COUNT = 'vivid.export.dropped'
const PAUSED_SIGNAL = 'vivid.export.signal'
const PAUSED_SECONDS = 'vivid.export.paused_seconds'

/**
 * Decides whether one attribute value may leave, and if so builds the value that does. A value is
 * never trimmed, cleaned or partly kept: it has the shape its key calls for, or it is absent.
 */
type Rule = (value: AnyValue) => Option.Option<AnyValue>

/** The export allowlist of one serialization layer: the rule for every key that may leave. */
type Rules = ReadonlyMap<string, Rule>

/** A string value that `allowed` accepts; every other kind of value is refused. */
const text =
  (allowed: (candidate: string) => boolean): Rule =>
  (value) =>
    Predicate.isString(value.stringValue) && allowed(value.stringValue)
      ? Option.some({ stringValue: value.stringValue })
      : Option.none()

/**
 * A string or an integer that `admits` accepts, kept as the kind of value it arrived as. An
 * Incident's attributes are of both kinds (`incidents.ts` `incidentExport`).
 */
const scalar =
  (admits: (value: string | number) => boolean): Rule =>
  (value) => {
    if (Predicate.isString(value.stringValue))
      return admits(value.stringValue)
        ? Option.some({ stringValue: value.stringValue })
        : Option.none()
    if (Predicate.isNumber(value.intValue) && Number.isInteger(value.intValue))
      return admits(value.intValue) ? Option.some({ intValue: value.intValue }) : Option.none()
    return Option.none()
  }

/**
 * A route template as Effect 4.0.2 `HttpRouter.ts` writes it on the request's span
 * (`span.attribute("http.route", route.path)`), from the path a route was added with in code:
 * `/api/watches/:id`, never the request's own path. Its shape is a path of letters, digits and
 * `_ - . : * /`, so an id or a token a client sent cannot be one unless code declared it.
 */
const routeTemplate = text(
  (candidate) => candidate.length <= 200 && /^\/[A-Za-z0-9_\-.:*/]*$/u.test(candidate),
)

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
 * note on each such key in `rulesOf`.
 */
const codeName = text(isCodeName)

/** How many distinct failure type names one process exports, `error.type` and the root together. */
export const MOST_TYPE_NAMES = 256
/** How many distinct SQLSTATE values one process exports. */
export const MOST_DATABASE_CODES = 64

/**
 * A set that takes at most `most` members: whether `candidate` is one of them, having made it one
 * when there was still room. It only grows, so a value admitted once is admitted for as long as
 * the set lives, and what it bounds is how many distinct values a backend can ever be sent under
 * the keys that use it.
 *
 * It is mutable state, and it belongs to one serialization layer (`rulesOf`), never to the
 * module: two layers, as in two tests, do not share what they have admitted.
 */
const admitting = (most: number) => {
  const admitted = new Set<string>()
  return (candidate: string): boolean => {
    if (admitted.has(candidate)) return true
    if (admitted.size >= most) return false
    admitted.add(candidate)
    return true
  }
}

/**
 * A failure's type name: a code name among those admitted so far, and `_OTHER` in place of one
 * that arrives after the set is full. `_OTHER` itself is always let through and takes no place,
 * so the failure is still counted, under the name OpenTelemetry reserves for an unnamed type.
 *
 * The bound is for the residual `failure.ts` `schemaTag` states: a type name is proved to be a
 * schema class's tag, not to be written in Vivid's code, and a backend's cost grows with every
 * distinct value of an attribute it indexes.
 */
const typeName =
  (admit: (candidate: string) => boolean): Rule =>
  (value) => {
    if (!Predicate.isString(value.stringValue) || !isCodeName(value.stringValue))
      return Option.none()
    const name = value.stringValue
    return Option.some({ stringValue: name === UNTYPED || admit(name) ? name : UNTYPED })
  }

/**
 * PostgreSQL's SQLSTATE: exactly five digits or capitals, and among those admitted so far. The
 * code is a property of whatever was thrown (`failure.ts` `Diagnostics`), accepted by its shape,
 * so the set bounds it. A code that arrives after the set is full is left off: nothing with the
 * shape of a SQLSTATE means "another one", so there is no value to put in its place.
 */
const sqlState = (admit: (candidate: string) => boolean) =>
  text((candidate) => /^[0-9A-Z]{5}$/.test(candidate) && admit(candidate))

/**
 * A git commit as the host names it, by the one rule for a commit (`@vivid/contracts` `Commit`).
 * Anything else given as the server's commit (`VIVID_BUILD_COMMIT`) is not one and is not sent.
 */
const commitHash = text(Schema.is(Commit))

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

/** Typed SDK request ids and server operationOf ids are the only writers. Reject prose and
 * unknown prefixes; these identifiers locate continuations and never contain their arguments. */
const executorRequestId = text((candidate) => /^(apr|elc)_[A-Za-z0-9-]{1,100}$/.test(candidate))
const actionOperationId = text((candidate) =>
  /^(approval|program)-[A-Za-z0-9_.:-]{1,500}$/.test(candidate),
)
const gateDecisions = { Allowed: true, ApprovalRequired: true, Blocked: true } satisfies Record<
  GateDecision['_tag'],
  true
>
const reviewReasons = {
  Disabled: true,
  Unconfigured: true,
  TimedOut: true,
  Provider: true,
  Backoff: true,
  Authentication: true,
  Unavailable: true,
  ArgumentsTooLong: true,
  HistoryDeadline: true,
  NoRequest: true,
} satisfies Record<typeof UnreviewedReason.Type, true>

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
 * - `error.type` and `vivid.failure.root` are written by `failure.ts`, which takes a type from a
 *   class and never from a property of what was thrown (`typeOf` there). Effect 4.0.2
 *   `HttpClient.ts` also writes `error.type` on a client span whose response is 4xx or 5xx, as
 *   the status in digits; that is not a code name, so the rule below drops it, and the status
 *   still leaves as `http.response.status_code`. The two keys share one bounded set of names
 *   (`typeName`).
 * - `rpc.system.name` and `rpc.method` are written by Effect 4.0.2 `RpcServer` on each call's span
 *   (`rpc/internal/tracing.ts` `spanAttributes`): the fixed `effect_rpc`, and the call's tag, which
 *   is only ever a tag found in the contract's group. `live/tally.ts` writes `rpc.method` on its
 *   call counts too, from the same group (`isCalled`). `rpc.system` and `rpc.service` are written
 *   by nothing today; they are listed for a recorder that names the call from the contract.
 *
 * The rules are built once for each serialization layer, because two of them keep state: the
 * names and the database codes admitted so far (`admitting`).
 */
const rulesOf = (): Rules => {
  const typeNames = typeName(admitting(MOST_TYPE_NAMES))
  return new Map<string, Rule>([
    [FailureAttribute.type, typeNames],
    [FailureAttribute.kind, oneOf(FailureKind.literals)],
    [FailureAttribute.modelReason, oneOf(ModelFailureReason.literals)],
    [FailureAttribute.modelStatus, integer(400, 599)],
    [FailureAttribute.boundary, oneOf(Boundary.literals)],
    [FailureAttribute.root, typeNames],
    [FailureAttribute.databaseCode, sqlState(admitting(MOST_DATABASE_CODES))],
    [FailureAttribute.table, oneOf(TABLES)],
    // Vivid generates row ids with randomUUID. No arbitrary branded string can pass this rule.
    ...['connection', 'approval', 'input', 'artifact'].map(
      (kind) =>
        [
          `vivid.${kind}.id`,
          text((value) =>
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value),
          ),
        ] as const,
    ),
    // Program and Approval operations contain only Vivid-generated UUIDs. Runtime call ids and
    // Executor request ids have open vocabularies, so those identifiers stay on local spans.
    // The same applies to vivid.person.id, vivid.executor.app and vivid.executor.group: their
    // branded strings impose no shape, and no name, address or credential may leave as an id.
    [
      'vivid.operation.id',
      text((value) =>
        /^(program|approval)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
          value,
        ),
      ),
    ],
    [
      'vivid.executor.principal',
      oneOf(['installation', 'member', 'adopted-account', 'adopted-public']),
    ],
    ['vivid.executor.notready', oneOf(['Unavailable', 'ReconnectRequired'])],
    ['vivid.executor.method', oneOf(['call', 'resume'])],
    [
      'vivid.executor.status',
      oneOf([
        'approval-required',
        'input-required',
        'unavailable',
        'busy',
        'capacity-exceeded',
        'completed',
      ]),
    ],
    [
      'vivid.executor.outcome',
      oneOf([
        'Completed',
        'Accepted',
        'Paused',
        'Expired',
        'UncertainPause',
        'OutcomeUnknown',
        'NotReady',
        'Rejected',
      ]),
    ],
    ['vivid.integration.pause', oneOf(['Approval', 'Input'])],
    [
      'vivid.integration.outcome',
      oneOf([
        'Accepted',
        'Completed',
        'Rejected',
        'Waiting',
        'Expired',
        'Uncertain',
        'Declined',
        'Cancelled',
      ]),
    ],
    ['vivid.reconciliation.outcome', oneOf(['Applied', 'NotApplied', 'Inconclusive', 'Unchecked'])],
    ['vivid.reconciliation.retry', oneOf(['Unblocked', 'Blocked'])],
    ...refusalExport.map(([key, members]) => [key, oneOf(members)] as const),
    ...incidentExport.map(([key, admits]) => [key, scalar(admits)] as const),
    ['http.route', routeTemplate],
    ['vivid.action.operation_id', actionOperationId],
    ['vivid.action.effect', oneOf(['read', 'write', 'destructive'])],
    ['vivid.executor.request_id', executorRequestId],
    // Both writers use typed error tags, never diagnostic strings from the Integration.
    ['vivid.executor.failure', codeName],
    ['vivid.gate.basis', oneOf(GateBasis.literals)],
    ['vivid.gate.decision', oneOf(Object.keys(gateDecisions))],
    ['vivid.review.state', oneOf(['Reviewed', 'Unreviewed'])],
    ['vivid.review.reason', oneOf(['None', ...Object.keys(reviewReasons)])],
    ['vivid.review.outcome', oneOf(['Run', 'Ask'])],
    ['vivid.review.retry', oneOf(['Taken'])],
    // `threads/delivery.ts`: the id of a system word a settled reply used, from the runtime's list.
    [VOICE_WORD, oneOf(systemWordIds)],
    [DROPPED_COUNT, integer(0, Number.MAX_SAFE_INTEGER)],
    [PAUSED_SIGNAL, oneOf(Signals)],
    [PAUSED_SECONDS, integer(0, Number.MAX_SAFE_INTEGER)],
    // `live/tally.ts`: the name is one of the contract's `Watch…` tags and every other value a count.
    [QUERY, oneOf(watchedNames)],
    ...[...Object.values(LiveAttribute), ...Object.values(MovedAttribute), CallAttribute.calls].map(
      (key) => [key, integer(0, Number.MAX_SAFE_INTEGER)] as const,
    ),
    // The tracer's own event for a failed span (rc.116 `OtlpTracer.ts` `makeOtlpSpan`) takes its
    // type from `error.name`, a string by the time it is here, so only a fixed name is let through.
    // Since `guard.ts` that name is the stand-in's, the type `failure.ts` took from the class.
    ['exception.type', oneOf(fixedTypeNames)],
    ['service.name', oneOf([SERVICE])],
    ['service.version', commitHash],
    ['deployment.environment.name', environmentName],
    ['deployment.environment', environmentName],
    ['rpc.system', codeName],
    ['rpc.system.name', oneOf(['effect_rpc'])],
    ['rpc.service', codeName],
    ['rpc.method', codeName],
    ['http.request.method', oneOf(METHODS)],
    ['db.system.name', oneOf(['postgresql'])],
    ['http.response.status_code', integer(100, 599)],
    ['url.scheme', oneOf(['http', 'https'])],
  ])
}

/** The pairs that may leave, each rebuilt from its key and the value its rule produced. */
const allowed = (rules: Rules, pairs: ReadonlyArray<KeyValue>): Array<KeyValue> =>
  pairs.flatMap(({ key, value }) =>
    Option.fromUndefinedOr(rules.get(key)).pipe(
      Option.flatMap((rule) => rule(value)),
      Option.map((kept) => ({ key, value: kept })),
      Option.toArray,
    ),
  )

/** Allowlisted attributes, with OTLP's own count of how many were left behind. */
const attributesOf = (rules: Rules, pairs: ReadonlyArray<KeyValue>) => {
  const attributes = allowed(rules, pairs)
  return { attributes, droppedAttributesCount: pairs.length - attributes.length }
}

type Traces = Parameters<OtlpSerialization.OtlpSerialization['Service']['traces']>[0]
type Logs = Parameters<OtlpSerialization.OtlpSerialization['Service']['logs']>[0]
type ExportedSpan = Traces['resourceSpans'][number]['scopeSpans'][number]['spans'][number]
type ExportedEvent = ExportedSpan['events'][number]
type ExportedLink = ExportedSpan['links'][number]

/**
 * A trace id as OTLP carries it: 32 hexadecimal digits, not all zero.
 *
 * B3 also allows a 64-bit trace id, 16 digits (`b3: 463ac35c9f6413ad-a2fb4a1d1a96d312-1`), and
 * rc.116 `HttpTraceContext` hands it on as sent. That is a sound id from a caller that
 * propagates B3, so it is widened the way B3 prescribes, with zeros on the left, and every span,
 * link and log line of that trace is filed under the same 32 digits. Any other text is not an id
 * and has no exportable form.
 *
 * Neither is an id of zeros in either length: OpenTelemetry defines the all-zero trace id as
 * invalid, and the widening would otherwise make one out of `b3: 0000000000000000-…`. The shapes
 * themselves are `guard.ts`'s (`isTraceId`, `isSpanId`), which checks the same ids before a span
 * is made from them.
 */
const traceIdOf = (id: string): Option.Option<string> =>
  isTraceId(id) ? Option.some(id.padStart(32, '0')) : Option.none()

/**
 * A span name that is a code identifier (an `Effect.fn` name, an RPC's tag) or the fixed
 * name the HTTP server and client give a request: the method alone (Effect 4.0.2
 * `HttpMiddleware.SpanNameGenerator` and `HttpClient.SpanNameGenerator`, both `request.method`;
 * rc.116 wrote `http.server METHOD` and `http.client METHOD`, and the span's kind is what tells a
 * server span from a client span now). `Effect.withSpan` takes any string, so a name built from
 * data would otherwise leave as written.
 *
 * The residual assumption is that span names are written in code. A dotted identifier built from
 * data (`Ada.Lovelace`) has the same shape and would pass, and nothing here can tell the two
 * apart. No producer does that today: every name is an `Effect.fn` literal, or an RPC's tag,
 * which Effect 4.0.2 `RpcServer.ts` `handleRequest` uses as the span name only after it has found
 * the tag in the contract's group (rc.116 wrote `RpcServer.<tag>`). `export.test.ts` sends a marker of that shape through the
 * path, the query, a header and an RPC payload and fails if it reaches a span name.
 */
const spanName = (name: string) => (METHODS.includes(name) || isCodeName(name) ? name : OMITTED)

/**
 * An event is named by a log message (rc.116 `internal/effect.ts` `tracerLogger`) or is the
 * tracer's `exception`; any other name is text someone logged.
 */
const allowEvent =
  (rules: Rules) =>
  (event: ExportedEvent): ExportedEvent => ({
    name: event.name === 'exception' || isMessage(event.name) ? event.name : OMITTED,
    timeUnixNano: event.timeUnixNano,
    ...attributesOf(rules, event.attributes),
  })

/** A link to a span whose ids are not ids is dropped; see `allowSpan`. */
const allowLink =
  (rules: Rules) =>
  (link: ExportedLink): ReadonlyArray<ExportedLink> => {
    const traceId = traceIdOf(link.traceId)
    if (Option.isNone(traceId) || !isSpanId(link.spanId)) return []
    return [
      { traceId: traceId.value, spanId: link.spanId, ...attributesOf(rules, link.attributes) },
    ]
  }

/** OTLP's `STATUS_CODE_ERROR`. */
const ERROR_STATUS = 2

/**
 * OTLP's `SPAN_FLAGS_CONTEXT_HAS_IS_REMOTE_MASK` and `SPAN_FLAGS_CONTEXT_IS_REMOTE_MASK`
 * (`opentelemetry/proto/trace/v1/trace.proto` `SpanFlags`): whether the parent's locality is
 * known, and that it is in another process.
 */
const PARENT_KNOWN = 0x100
const PARENT_REMOTE = 0x200

/** A span as it is posted: Effect's, plus the flags `makeOtlpSpan` does not write. */
type PostedSpan = ExportedSpan & { readonly flags: number }

/** The flags of a span: whether it keeps its parent, and that parent's locality (`guard.ts`). */
const flagsOf = (span: ExportedSpan, keepsParent: boolean) =>
  !keepsParent
    ? 0
    : span.attributes.some(({ key, value }) => key === REMOTE_PARENT && value.boolValue === true)
      ? PARENT_KNOWN | PARENT_REMOTE
      : PARENT_KNOWN

/**
 * One span, rebuilt field by field.
 *
 * - A span on which an Incident was recorded (`incidents.ts`) has the error status, whatever its
 *   effect returned: the outcome it decided was a Person's work not happening, and Effect 4.0.2
 *   `OtlpTracer.ts` `makeOtlpSpan` reads the status from the exit alone.
 * - A request's span is named by its method and the route it matched (`GET /api/watches/:id`),
 *   both kept by the rules above, so the trace's transaction has a name a person can read. Effect
 *   4.0.2 `HttpMiddleware.SpanNameGenerator` names it by the method alone, before routing.
 * - A span whose parent is in another process carries the OTLP remote-parent flag (`flagsOf`), so
 *   Sentry starts a transaction there, named by the span: an RPC call's is its tag.
 *
 * - The status keeps its code only. rc.116 `makeOtlpSpan` sets the message to the first error's
 *   own message.
 * - Ids are text from outside too. rc.116 `HttpTraceContext` validates `traceparent` but takes
 *   `b3` and `x-b3-traceid`/`x-b3-spanid` as sent, and every span under that request inherits the
 *   trace id (`SpanImpl.traceId`). A span whose trace id is not an id (`traceIdOf`) is therefore
 *   dropped whole: its only alternative is a made-up id, which would file it under a trace that
 *   does not exist. When the trace id is sound and only the inherited parent's span id is not,
 *   the parent is dropped and the span is exported as a root of that trace. An id of zeros is
 *   not an id in any of these places (`isSpanId`, `traceIdOf`).
 */
const allowSpan =
  (rules: Rules) =>
  (span: ExportedSpan): ReadonlyArray<PostedSpan> => {
    const traceId = traceIdOf(span.traceId)
    if (Option.isNone(traceId) || !isSpanId(span.spanId)) return []
    const links = span.links.flatMap(allowLink(rules))
    const kept = attributesOf(rules, span.attributes)
    const said = (key: string) =>
      Arr.findFirst(kept.attributes, (pair) => pair.key === key).pipe(
        Option.flatMap(({ value }) => Option.fromUndefinedOr(value.stringValue)),
      )
    const parentSpanId =
      span.parentSpanId !== undefined && isSpanId(span.parentSpanId) ? span.parentSpanId : undefined
    return [
      {
        traceId: traceId.value,
        spanId: span.spanId,
        parentSpanId,
        flags: flagsOf(span, parentSpanId !== undefined),
        name: Option.match(said('http.route'), {
          onNone: () => spanName(span.name),
          onSome: (route) =>
            METHODS.includes(span.name) ? `${span.name} ${route}` : spanName(span.name),
        }),
        kind: span.kind,
        startTimeUnixNano: span.startTimeUnixNano,
        endTimeUnixNano: span.endTimeUnixNano,
        ...kept,
        events: span.events.map(allowEvent(rules)),
        droppedEventsCount: 0,
        status: { code: Option.isSome(said(INCIDENT_KIND)) ? ERROR_STATUS : span.status.code },
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
  Predicate.isString(traceId) && Predicate.isString(spanId) && isSpanId(spanId)
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
const allowLine =
  (rules: Rules) =>
  (line: ExportedLine): ExportedLine => {
    const span = spanOf(line)
    return {
      timeUnixNano: line.timeUnixNano,
      observedTimeUnixNano: line.observedTimeUnixNano,
      severityNumber: line.severityNumber,
      severityText: line.severityText,
      body: { stringValue: bodyOf(line) },
      ...attributesOf(rules, line.attributes),
      traceId: Option.getOrUndefined(Option.map(span, ({ traceId }) => traceId)),
      spanId: Option.getOrUndefined(Option.map(span, ({ spanId }) => spanId)),
    }
  }

/** What every post is rebuilt with: the allowlist's rules and the resource named on it. */
interface Allowlist {
  readonly rules: Rules
  readonly resource: Resource
}

const allowTraces =
  ({ rules, resource }: Allowlist) =>
  (data: Traces): Traces => ({
    resourceSpans: data.resourceSpans.map((group) => ({
      resource,
      scopeSpans: group.scopeSpans.map((scope) => ({
        scope: { name: SERVICE },
        spans: scope.spans.flatMap(allowSpan(rules)),
      })),
    })),
  })

type ExportedScope = Logs['resourceLogs'][number]['scopeLogs'][number]

/** The records of one scope; rc.116 types them as optional, and a scope without any has none. */
const linesOf = (rules: Rules, scope: ExportedScope): Array<ExportedLine> =>
  Option.fromUndefinedOr(scope.logRecords).pipe(
    Option.map((records) => records.map(allowLine(rules))),
    Option.getOrElse(() => []),
  )

const allowLogs =
  ({ rules, resource }: Allowlist) =>
  (data: Logs): Logs => ({
    resourceLogs: data.resourceLogs.map((group) => ({
      resource,
      scopeLogs: group.scopeLogs.map((scope) => ({
        scope: { name: SERVICE },
        logRecords: linesOf(rules, scope),
      })),
    })),
  })

/**
 * The resource every post names: the service, and the commit and environment when the host
 * supplies them, each through the allowlist like any other attribute, so a commit setting that
 * is not a commit is left off.
 *
 * It is built here and put in place of the exporter's own at serialization, because the
 * exporter's is not Vivid's to bound: rc.116 `OtlpResource.fromConfig` merges every pair in
 * `OTEL_RESOURCE_ATTRIBUTES` into it. The environment is written under both the current
 * semantic-convention name and the one it replaced, because which of the two the backend reads
 * was not verified.
 */
const resourceOf = (
  rules: Rules,
  environment: Option.Option<string>,
  commit: Option.Option<string>,
): Resource => ({
  attributes: allowed(rules, [
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
 *
 * The rules are made when `observabilityLayer` is built, not when the module loads, because they
 * hold the sets of values admitted so far (`rulesOf`). Both signals are serialized by the one layer, so a
 * type name admitted on a span is the same name on its log line, and the bound is on the two
 * together. A batch that is serialized and then dropped has still taken its places.
 */
const allowlistSerializationLayer = (allowlist: Allowlist) =>
  Layer.sync(OtlpSerialization.OtlpSerialization, () => ({
    traces: (data) => HttpBody.jsonUnsafe(allowTraces(allowlist)(data)),
    logs: (data) => HttpBody.jsonUnsafe(allowLogs(allowlist)(data)),
    metrics: () => HttpBody.jsonUnsafe({ resourceMetrics: [] }),
  }))

/** What one exporter is built from: where it posts, and with which credentials. */
interface Destination {
  readonly url: string
  readonly headers: Record<string, string>
}

// Effect 4.0.2 OtlpLogger defaults. Cadence batches logs; drain grace caps shutdown only.
const LOG_EXPORT_CADENCE = Duration.seconds(1)
const LOG_DRAIN_GRACE = Duration.seconds(3)

/**
 * The logger that exports: `guard.ts` `exportingLogger` builds each record, and rc.116's batch
 * exporter posts them.
 *
 * A port of rc.116 `OtlpLogger.ts` `make` without its `makeLogRecord`, which cannot be kept from
 * walking whatever was logged (`exportingLogger` says why). The label, the one-second interval,
 * the batch of 1,000 and the three-second shutdown flush are that function's own defaults. The
 * resource it would read from the environment is not built: `allowLogs` puts Vivid's in at
 * serialization whatever a batch names, and the scope likewise.
 */
const exportedLogs = Effect.fnUntraced(function* ({ url, headers }: Destination, keys: Keys) {
  const serialization = yield* OtlpSerialization.OtlpSerialization
  const clock = yield* Clock.Clock
  const exporter = yield* OtlpExporter.make({
    label: 'OtlpLogger',
    url,
    headers,
    exportInterval: LOG_EXPORT_CADENCE,
    maxBatchSize: 1000,
    body: (lines: Array<ExportedLine>) => [
      serialization.logs({
        resourceLogs: [{ scopeLogs: [{ scope: { name: SERVICE }, logRecords: lines }] }],
      }),
      Effect.void,
    ],
    shutdownTimeout: LOG_DRAIN_GRACE,
  })
  return exportingLogger(keys, clock, (line) => {
    exporter.push(line)
  })
})

/** Bounds one OTLP exchange through body end because a stalled backend can occupy every slot.
 * Source: unmeasured. Expiry drops the batch and reports the export pause. */
export const LONGEST_EXPORT = Duration.seconds(10)
/** How many exports may be outstanding at once, traces and logs together. */
export const MOST_OUTSTANDING = 8
/**
 * How long an exporter accepts nothing after one failed export. The number is rc.116
 * `OtlpExporter.ts` `make`'s own (`disabledUntil = now + 60_000`), which that module does not
 * export; it is repeated here so that the drop report can say when a pause began.
 */
export const PAUSE_MILLIS = 60_000
/** The most of an answer's body that is read. An OTLP success is a few bytes of JSON. */
const LARGEST_ANSWER = 64 * 1024

/** What one signal's client knows about its losses. */
interface Drops {
  /** Batches lost since the last report. */
  readonly pending: number
  /** The clock time until which this signal's exporter is paused; a drop from then on starts a pause. */
  readonly pausedUntil: number
}

/** The state one bounded client keeps. */
interface Bounds {
  /** The signal this client posts. Each exporter has its own client, because each pauses alone. */
  readonly signal: Signal
  /** How many exports are in flight, traces and logs together: the one count both clients share. */
  readonly outstanding: Ref.Ref<number>
  readonly drops: Ref.Ref<Drops>
}

/**
 * Counts one lost batch, reports it when it starts a pause, and ends the export by interrupting
 * it.
 *
 * The interrupt is the point. rc.116 `OtlpExporter.ts` `make` wraps the client it is given in
 * `filterStatusOk` and `retryTransient`, outside anything this module does to that client. A
 * failure or a refusal handed back to it would be retried there on the exporter's own schedule
 * (a `429` waits out its `Retry-After`, however long), with the export fiber and its serialized
 * batch held for the whole delay. An interruption is not an error and not a response, so nothing
 * is scheduled: it reaches the exporter's `catchCause`.
 *
 * What that `catchCause` does is a pause, and it is the price of one failed attempt of any kind
 * (a reset, a `503`, a body that broke off, a timeout, a turn-away at the cap). When the exporter
 * is not already paused it empties its buffer and sets `disabledUntil` 60 seconds ahead; until
 * then `push` discards what it is given and `runExport` sends nothing, and the flush at shutdown
 * is skipped while `disabledUntil` is set. The exporter clears it in the first `runExport` after
 * the 60 seconds, which is its next interval tick, so the gap runs that little longer. Each
 * signal has its own exporter and pauses alone.
 *
 * This function keeps the same clock for its signal. A drop at or after `pausedUntil` is one the
 * exporter answers by pausing: an export only starts when the exporter is not paused, and it ends
 * within `LONGEST_EXPORT`, which is shorter than a pause, so a drop inside a pause can only come
 * from an export that was already in flight when the pause began. That drop is counted and not
 * reported.
 *
 * So the report is written exactly when a pause starts, and says so: the signal, that its export
 * is paused for 60 seconds, and how many of its batches were lost since its last report. That is
 * also the rate limit: at most one report a minute for each signal. The count of a pause's later
 * drops waits for the drop that starts the next one.
 *
 * The count is of the batches this client gave up on: past the cap, out of time, refused by the
 * backend, or never delivered. What the exporter emptied from its buffer or declined to buffer
 * during the pause never passes through here and is not in it, which is why the line states the
 * pause: a reader of stdout is told there is a gap in the backend, and stdout itself has every
 * line (`observabilityLayer`).
 */
const drop = Effect.fnUntraced(function* ({ signal, drops }: Bounds) {
  const now = yield* Clock.currentTimeMillis
  const report = yield* Ref.modify(drops, ({ pending, pausedUntil }) =>
    now >= pausedUntil
      ? [Option.some(pending + 1), { pending: 0, pausedUntil: now + PAUSE_MILLIS }]
      : [Option.none<number>(), { pending: pending + 1, pausedUntil }],
  )
  if (Option.isSome(report)) {
    yield* Effect.annotateLogs(Effect.logWarning(Message.dropped), {
      [DROPPED_COUNT]: report.value,
      [PAUSED_SIGNAL]: signal,
      [PAUSED_SECONDS]: PAUSE_MILLIS / 1000,
    })
    yield* ErrorReporter.report(
      Cause.fail(new TelemetryExportPaused({ signal, batches: report.value })),
    )
  }
  return yield* Effect.interrupt
})

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
  ).pipe(Effect.orElseSucceed(() => Option.none<HttpClientResponse>()))

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
                onNone: () => drop(bounds),
                onSome: (response) => Effect.succeed(response),
              }),
            ),
          )
        : drop(bounds),
    (admitted) => (admitted ? Ref.update(bounds.outstanding, (count) => count - 1) : Effect.void),
  )

/**
 * The HTTP client one exporter posts with, bounded so that a slow, absent or refusing backend
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
 * - at most `MOST_OUTSTANDING` exports are in flight across both signals (`outstanding` is the
 *   one count both clients are given), each holding at most one connection, and one past that is
 *   cancelled before it is sent;
 * - in every one of those cases the batch is dropped, not queued (`drop`).
 *
 * The cost of that, accepted as policy: one failed attempt blacks out its signal in the backend.
 * The exporter answers it by emptying its buffer and accepting nothing for 60 seconds, and it
 * skips its shutdown flush while paused, so everything that signal recorded just before the
 * failure and during the minute after it never reaches the backend, and is not sent later. The
 * product does not depend on the backend, and nothing is lost to an operator: the server's own
 * stdout log on the host has every line in full, and the drop report on it says when each gap
 * began (`drop`). Keeping the batches instead would mean holding them in memory against a backend
 * that is failing, which is the unbounded cost this client exists to refuse.
 *
 * Nothing that serves a Person waits on any of this. Recording a span or a line is a push onto
 * the exporter's in-memory buffer (`exporter.push`), and the requests run on the exporter's own
 * fibers.
 *
 * Untraced, as are the programs it runs per request: a span about an export would itself be
 * exported.
 */
const boundedClient = Effect.fnUntraced(function* (
  signal: Signal,
  outstanding: Bounds['outstanding'],
) {
  const client = yield* HttpClient.HttpClient
  const bounds: Bounds = {
    signal,
    outstanding,
    drops: yield* Ref.make<Drops>({ pending: 0, pausedUntil: 0 }),
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
const endpoint = (base: URL, signal: Signal) => `${base.href.replace(/\/+$/, '')}/v1/${signal}`

/**
 * Installs the OTLP tracer and logger exporters for an `Enabled` setting, and nothing for
 * `Disabled`.
 *
 * VCOS `apps/web/src/observability/tracing.ts` `workerObservabilityLayer` is the reference: one
 * Layer that puts a tracer and a structured logger under the whole program. It hands spans to
 * Cloudflare's own pipeline; Vivid is a Node process, so the exporter is Effect's
 * (`effect/observability`), and the Layer is built once for the process, not per request.
 *
 * - Only traces and logs: the backend has no OTLP metrics path, and counts are derived there from
 *   span and log attributes.
 * - `mergeWithExisting` keeps the default logger, so stdout shows every line in full, including
 *   the text the allowlist keeps from the backend.
 * - The tracer is given the service name only so that it can be built (without one, rc.116
 *   `OtlpResource.fromConfig` requires `OTEL_SERVICE_NAME`); the resource and scope that are
 *   actually posted are the ones `allowlistSerializationLayer` puts in.
 * - Each exporter posts through its own bounded client (`boundedClient`), because each pauses on
 *   its own, and both clients count against one cap on outstanding requests. `Layer.unwrap` is
 *   what makes that one count: it is created once, when the Layer is built, and handed to both.
 * - One serialization layer is provided to both, so they share one allowlist and its bounds.
 * - The tracer is the exporter's own behind a guard, and the logger is Vivid's over the exporter's
 *   batch poster (`guard.ts`, `exportedLogs`), so that nothing either does while it records can
 *   throw into the program it records or be made to walk what the program gave it. Both are given
 *   the allowlist's keys, and forward only those. They are installed the way rc.116
 *   `OtlpTracer.layer` and `OtlpLogger.layer` install theirs (`Layer.effect(Tracer.Tracer)`,
 *   `Logger.layer`, each with `OtlpExporter.layerFlusher` merged in).
 *
 * The exporter batches on a timer and flushes when the Layer's scope closes, bounded by its own
 * shutdown timeout (rc.116 `OtlpExporter.ts` `make`); `Flusher` in the output drains it on demand.
 * A failed export pauses its signal for a minute and the batches of that time are not sent
 * (`boundedClient`).
 */
export const observabilityLayer = (configuration: ObservabilityConfiguration) =>
  ObservabilityConfiguration.$match(configuration, {
    Disabled: () => Layer.empty,
    Enabled: ({ url, headers, environment, commit }) =>
      Layer.unwrap(
        Effect.gen(function* () {
          const credentials = Redacted.value(headers)
          const outstanding = yield* Ref.make(0)
          const rules = rulesOf()
          const keys: Keys = new Set(rules.keys())
          const posting = (signal: Signal) =>
            Layer.effect(HttpClient.HttpClient, boundedClient(signal, outstanding))
          const tracer = OtlpTracer.make({
            url: endpoint(url, 'traces'),
            resource: { serviceName: SERVICE },
            headers: credentials,
          })
          const logger = exportedLogs({ url: endpoint(url, 'logs'), headers: credentials }, keys)
          return Layer.mergeAll(
            Layer.effect(
              Tracer.Tracer,
              Effect.map(tracer, (inner) => guardedTracer(inner, keys)),
            ).pipe(Layer.provideMerge(OtlpExporter.layerFlusher), Layer.provide(posting('traces'))),
            Logger.layer([logger], { mergeWithExisting: true }).pipe(
              Layer.provideMerge(OtlpExporter.layerFlusher),
              Layer.provide(posting('logs')),
            ),
          ).pipe(
            Layer.provide(
              allowlistSerializationLayer({
                rules,
                resource: resourceOf(rules, environment, commit),
              }),
            ),
          )
        }),
      ),
  })
