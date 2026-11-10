import type { ReportInfo } from '@earendil-works/pi-durable'
import {
  CodeName,
  IncidentCause,
  type IncidentHop,
  type Impact,
  impactSignal,
  PersonId,
  RunFailure,
} from '@vivid/contracts'
import {
  Config,
  ConfigProvider,
  Context,
  Effect,
  Option,
  Predicate,
  Schema,
  SchemaAST,
  Struct,
  type Tracer,
} from 'effect'
import * as Headers from 'effect/http/Headers'
import * as HttpTraceContext from 'effect/http/HttpTraceContext'

/**
 * What each of Pi's reports (`HarnessOptions.onReport`, `ReportInfo` in pi-durable 1.4) cost a
 * Person, by Pi's own definitions. The Session failing, a task faulting, parking or being unable
 * to migrate each stop work Vivid owed: `Incident`. The rest Pi documents as failures that "do not
 * fail the calling operation" (a hook, a listener or a host callback threw, a task reported
 * something, a task keeps its old definition), so the work went on: `Recovered`.
 *
 * Keyed by `ReportInfo['type']`, so a report type Pi adds fails typecheck here until it is placed.
 */
const reportImpact = {
  session_failed: 'Incident',
  task_faulted: 'Incident',
  task_parked: 'Incident',
  migration_failed: 'Incident',
  task_outdated: 'Recovered',
  task_error: 'Recovered',
  extension_error: 'Recovered',
  host_error: 'Recovered',
  listener_error: 'Recovered',
} as const satisfies Record<ReportInfo['type'], Impact>

/** Pi's closed word for what it reported, read from `reportImpact` so the two cannot drift. */
const PiReport = Schema.Literals(Struct.keys(reportImpact))

/**
 * A failure inside a Person's cell, said where the cell decides it. These are not `Incident`
 * cases: the cell does not know the Run an admission becomes (the server derives the `RunId`
 * from the Thread and the idempotency key), and the outcomes the server sees (a refused
 * admission, a failed Run) are the server's to record once. What only the cell sees is said here,
 * with the same closed vocabulary (`IncidentCause`, `vivid.incident.*`), so one search in the
 * error tracker finds both, and the trace joins them.
 *
 * - `CellFailed`: the cell could not do what one of its events asked: open the Person (activation
 *   reads configuration and local SQLite and opens Pi), answer a request, run its alarm, or write
 *   the alarm Pi asked for. The cause's first hop says which (`Cell.answer`, `Cell.alarm`,
 *   `Cell.arm`) and the next where it broke (`Cell.open`, `Cell.route`, `Cell.wake`).
 * - `PiReported`: Pi reported a failure. `report` is Pi's word for it; the cause's hop names the
 *   task kind Pi was running (`vivid.learning`) or `Harness` when it names none, and the thrown
 *   value's class.
 *
 * An input Pi settled with no answer is not said here: its chain travels in the settlement
 * (`RuntimeSettlement.Failed.cause`) and the server's `RunFailed` records it, once.
 */
export const CellFailure = Schema.TaggedUnion({
  CellFailed: { personId: PersonId, cause: IncidentCause },
  PiReported: { personId: PersonId, report: PiReport, cause: IncidentCause },
})
export type CellFailure = typeof CellFailure.Type

/** A cell failure that stops a Person's work is an `Incident`; a Pi report costs what Pi says. */
const impactOf = (failure: CellFailure): Impact =>
  CellFailure.match(failure, {
    CellFailed: (): Impact => 'Incident',
    PiReported: ({ report }) => reportImpact[report],
  })

/**
 * Classes whose instances are reported under a fixed name, checked in order (subclasses first).
 * The name is written here, never read from the value: a `name` or `message` is whatever the
 * thrower set, and a provider's error can build either from a response (the server's rule,
 * `apps/server/src/observability/failure.ts` `thrownType`). `ConfigError` is a plain class in
 * Effect 4.0.2 and `SchemaError` a `Data.TaggedError`, so neither is a schema class.
 */
const NAMED: ReadonlyArray<
  readonly [abstract new (...parameters: Array<never>) => object, string]
> = [
  [Config.ConfigError, 'ConfigError'],
  [Schema.SchemaError, 'SchemaError'],
  [TypeError, 'TypeError'],
  [RangeError, 'RangeError'],
  [SyntaxError, 'SyntaxError'],
  [ReferenceError, 'ReferenceError'],
  [Error, 'Error'],
]

/** A `Schema.TaggedError` class's declared tag, read from the class's schema, not from the value. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- whatever was thrown is classified here.
const schemaTag = (value: unknown): Option.Option<string> => {
  if (!Predicate.isObject(value)) return Option.none()
  const made: unknown = value.constructor
  if (!Predicate.isFunction(made) || !Schema.isSchema(made) || !(value instanceof made))
    return Option.none()
  if (!Predicate.hasProperty(made, 'fields')) return Option.none()
  const { fields } = made
  if (!Predicate.hasProperty(fields, '_tag') || !Schema.isSchema(fields._tag)) return Option.none()
  const { ast } = fields._tag
  return SchemaAST.isLiteral(ast) && Predicate.isString(ast.literal)
    ? Option.some(ast.literal)
    : Option.none()
}

const decodeCodeName = Schema.decodeUnknownOption(CodeName)
/** What a thrown value is reported as when its class is none of the above, or it is not an object. */
const UNCLASSED = CodeName.make('Thrown')

/** The tag of a thrown value for an `IncidentHop`: its schema class's tag, else a listed class. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- whatever was thrown is classified here.
export const thrownTag = (value: unknown): CodeName =>
  Option.getOrElse(
    Option.flatMap(
      Option.orElse(schemaTag(value), () =>
        Option.fromNullishOr(NAMED.find(([made]) => value instanceof made)).pipe(
          Option.map(([, name]) => name),
        ),
      ),
      decodeCodeName,
    ),
    () => UNCLASSED,
  )

/** One hop of a failure inside this cell. `operation` is always a literal from code. */
export const cellHop = (operation: CodeName, tag: CodeName): IncidentHop => ({
  service: 'cell',
  operation,
  tag,
})

/**
 * The caller's trace, from the W3C `traceparent` (or B3) header the server's Effect `HttpClient`
 * sends on every request (`TracerPropagationEnabled` defaults to true in Effect 4.0.2). celld
 * passes the header through to the Worker and on to the Person's `fetch` unchanged.
 */
export const parentOf = (request: Request): Option.Option<Tracer.ExternalSpan> =>
  HttpTraceContext.fromHeaders(Headers.fromInput(request.headers))

/** Says one cell failure. It cannot fail: telemetry never changes the outcome it describes. */
export interface CellReportsService {
  readonly record: (
    failure: CellFailure,
    parent: Option.Option<Tracer.ExternalSpan>,
  ) => Effect.Effect<void>
}

/** The fixed log message, so the line leaves the process the way the server's fixed messages do. */
const MESSAGE = 'Person cell failure'

/**
 * The closed attributes of a failure, in the server's keys (`apps/server/src/observability/
 * incidents.ts`): `vivid.incident.kind`, `vivid.incident.<field>` for every field but the cause,
 * and `vivid.incident.cause.<n>.<part>` for every hop. Every value is a literal of a closed set,
 * a branded id or a code name, so all of it may leave the process.
 */
const attributesOf = (failure: CellFailure) => {
  const { _tag, cause, ...fields } = failure
  return Object.fromEntries([
    ['vivid.incident.kind', _tag],
    ...Object.entries(fields).map(([field, value]) => [`vivid.incident.${field}`, value] as const),
    ...cause.flatMap((hop, n) => hopAttributes(`vivid.incident.cause.${n}`, hop)),
  ])
}

/** One hop's attributes under `at`; `status` and `issues` only where the hop has them. */
const hopAttributes = (at: string, hop: IncidentHop) => [
  [`${at}.service`, hop.service] as const,
  [`${at}.operation`, hop.operation] as const,
  [`${at}.tag`, hop.tag] as const,
  ...Option.toArray(
    Option.map(
      Option.fromUndefinedOr(hop.status),
      (status) => [`${at}.status`, String(status)] as const,
    ),
  ),
  ...Option.toArray(
    Option.map(
      Option.fromUndefinedOr(hop.issues),
      (issues) =>
        [
          `${at}.issues`,
          issues.map((issue) => `${issue.path.join('.')}:${issue.kind}`).join(','),
        ] as const,
    ),
  ),
]

/** The log line at the impact's level (`impactSignal`), with the closed attributes. */
const say = (failure: CellFailure) =>
  Effect.logWithLevel(impactSignal[impactOf(failure)].level)(MESSAGE).pipe(
    Effect.annotateLogs(attributesOf(failure)),
  )

/** No address to send to: the cell says the failure in its log and nothing more, as tests do. */
const logOnly: CellReportsService = { record: say }

/**
 * The cell's reporter. Its default only logs, so a Person opened outside celld (the runtime's
 * test harness, `tests/process.ts`) says failures the way it always did; `openCell` provides the
 * one the Worker made from its bindings.
 */
export const CellReports = Context.Reference<CellReportsService>('vivid/Runtime/CellReports', {
  defaultValue: () => logOnly,
})

/** Where one Sentry project takes envelopes, from its DSN (`<scheme>://<key>@<host>/<project>`). */
interface Endpoint {
  readonly url: string
  readonly key: string
}

/** A DSN's envelope endpoint, or nothing when the address is not a DSN. */
const endpointOf = (dsn: URL): Option.Option<Endpoint> => {
  const segments = dsn.pathname.split('/')
  const project = segments.pop()
  if (dsn.username === '' || project === undefined || !/^\d+$/u.test(project)) return Option.none()
  return Option.some({
    url: `${dsn.protocol}//${dsn.host}${segments.join('/')}/api/${project}/envelope/`,
    key: dsn.username,
  })
}

/** `bytes` random bytes as lowercase hex: a Sentry event id is 16, a span id 8. */
const hex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')

/** Sentry's level words for Effect's (`impactSignal` levels). */
const sentryLevel = { Error: 'error', Warn: 'warning', Info: 'info' } as const

/**
 * One Sentry event as an envelope (Sentry's envelope format: a header line, an item header line,
 * the event). Built by hand rather than through an SDK because every part of it is chosen here:
 * no exception, no stack, no breadcrumbs and no request, only the closed attributes.
 *
 * - `fingerprint`: the failure's kind, then `<service>.<tag>` of every hop, so a different path of
 *   failure is a different issue (the server's rule in `incidents.ts`).
 * - `contexts.trace`: under the caller's trace when there is one, as a new span whose parent is
 *   the caller's span, so the issue opens the server's trace; otherwise a trace of its own.
 */
const envelopeOf = (
  failure: CellFailure,
  parent: Option.Option<Tracer.ExternalSpan>,
  environment: Option.Option<string>,
  now: number,
) => {
  const eventId = hex(16)
  const tags = attributesOf(failure)
  const event = {
    event_id: eventId,
    timestamp: now / 1000,
    platform: 'javascript',
    logger: 'vivid.cell',
    level: sentryLevel[impactSignal[impactOf(failure)].level],
    environment: Option.getOrUndefined(environment),
    message: { formatted: failure._tag },
    fingerprint: [failure._tag, ...failure.cause.map((hop) => `${hop.service}.${hop.tag}`)],
    tags,
    contexts: {
      trace: Option.match(parent, {
        onNone: () => ({ trace_id: hex(16), span_id: hex(8) }),
        onSome: (span) => ({
          trace_id: span.traceId,
          span_id: hex(8),
          parent_span_id: span.spanId,
        }),
      }),
    },
  }
  return [
    JSON.stringify({ event_id: eventId, sent_at: new Date(now).toISOString() }),
    JSON.stringify({ type: 'event' }),
    JSON.stringify(event),
  ].join('\n')
}

/** The ingest answered the envelope with a refusal. */
class IssueRefused extends Schema.TaggedError<IssueRefused>()(
  'IssueRefused',
  { status: Schema.Int },
  { title: 'Person cell failure was refused by the error tracker' },
) {}

/** The ingest could not be reached. */
class IssueUnreached extends Schema.TaggedError<IssueUnreached>()(
  'IssueUnreached',
  {},
  { title: 'Person cell failure could not reach the error tracker' },
) {}

/**
 * Sending is best effort by design: telemetry never changes the outcome it describes. A plain
 * `fetch` rather than Effect's `HttpClient`, whose layer would have to be provided here: the
 * ingest request is not part of the Person's work, and celld traces it on its own.
 */
const send = (endpoint: Endpoint, envelope: string) =>
  Effect.tryPromise({
    try: (signal) =>
      fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-sentry-envelope',
          'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${endpoint.key}, sentry_client=vivid-cell/1`,
        },
        body: envelope,
        signal,
      }),
    catch: () => IssueUnreached.make({}),
  }).pipe(
    Effect.flatMap((response) =>
      response.ok ? Effect.void : Effect.fail(IssueRefused.make({ status: response.status })),
    ),
    Effect.catchTags({
      IssueRefused: ({ status }) =>
        Effect.logWarning('Person cell failure was not sent').pipe(
          Effect.annotateLogs({ refusal: 'IssueRefused', status }),
        ),
      IssueUnreached: () =>
        Effect.logWarning('Person cell failure was not sent').pipe(
          Effect.annotateLogs({ refusal: 'IssueUnreached' }),
        ),
    }),
  )

/**
 * The Worker bindings telemetry reads, as text: each is absent when the deploy exports no
 * telemetry (`cellVariables` sets both or neither), and `makeCellReports` decodes them.
 */
export interface TelemetryBindings {
  readonly SENTRY_DSN?: string
  readonly VIVID_ENVIRONMENT?: string
}

/**
 * The reporter a Worker makes from its bindings: `SENTRY_DSN` (where issues go) and
 * `VIVID_ENVIRONMENT` (the issue's environment), both set by `cellVariables` in `infra/cells.ts`
 * only when the deploy exports telemetry. Without a DSN it only logs.
 *
 * `hold` runs a send beyond the fiber that recorded it. celld keeps an event's outbound request
 * only while the event or its `waitUntil` work lives, and a Pi report can fire from an event that
 * is about to end, so the Worker passes `waitUntil` here.
 *
 * A DSN that is set but is not one is a deploy mistake that must not stop a Person's cell: the
 * reporter says so once, at error, and only logs. Every other failure of telemetry is the same.
 */
export const makeCellReports = (
  bindings: TelemetryBindings,
  hold: (send: Effect.Effect<void>) => void,
): Effect.Effect<CellReportsService> =>
  Effect.gen(function* () {
    const dsn = yield* Config.option(Config.URL('SENTRY_DSN'))
    const name = yield* Config.option(Config.NonEmptyString('VIVID_ENVIRONMENT'))
    const endpoint = Option.flatMap(dsn, endpointOf)
    if (Option.isSome(dsn) && Option.isNone(endpoint))
      yield* Effect.logError('SENTRY_DSN is not a Sentry DSN; the cell sends no issues')
    return Option.match(endpoint, {
      onNone: () => logOnly,
      onSome: (to): CellReportsService => ({
        record: (failure, parent) =>
          Effect.gen(function* () {
            yield* say(failure)
            if (!impactSignal[impactOf(failure)].issue) return
            const envelope = envelopeOf(failure, parent, name, Date.now())
            yield* Effect.sync(() => hold(send(to, envelope)))
          }),
      }),
    })
  }).pipe(
    Effect.catchTag('ConfigError', () =>
      Effect.as(Effect.logError('SENTRY_DSN is not an address; the cell sends no issues'), logOnly),
    ),
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(bindings)),
  )
