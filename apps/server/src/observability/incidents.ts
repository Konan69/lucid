import * as Sentry from '@sentry/effect/server'
import {
  CodeName,
  DEEPEST_CAUSE,
  Incident,
  IncidentSource,
  IssueKind,
  impactSignal,
  type IncidentCause,
  type IncidentHop,
} from '@vivid/contracts'
import { Context, Effect, Layer, Option, Predicate, Result, Schema, Struct } from 'effect'
import type * as SchemaAST from 'effect/SchemaAST'
import { isSpanId, isTraceId } from './guard.ts'
import { isCodeName, Message } from './messages.ts'
import { membersOf } from './refusal.ts'

/**
 * Says one `Incident`: the one way the server says that a Person's work did not happen.
 *
 * It is a service and not a function because it owns the error tracker's client, which exists
 * only when `SENTRY_DSN` is set (`issues.ts` `issuesLayer`), and because a test observes what was
 * said through it rather than through the tracker.
 *
 * `record` cannot fail and returns nothing, so a producer calls it beside the outcome it decided
 * (the Run's terminal write, the push receipt, the Computer's start result) without changing
 * that outcome. It is called once per outcome, where the outcome is decided and only when the
 * write that decides it changed something, so a replay or a second observer does not say it twice
 * (`threads/delivery.ts` already guards `recordRunFailure` this way).
 *
 * What the implementation must do, in this order, all from the one `Incident` value:
 *
 * 1. The span. Annotate the current span with the attributes below and set its status to error.
 *    It is untraced itself (`Effect.fnUntraced`), as `refusal.ts` `recordRefusal` is, so the
 *    producer's span is the one that carries them.
 * 2. The log line. One `Effect.logError` with a fixed message from `messages.ts` (`Message.incident`,
 *    to be added: "Person's work did not happen") annotated with the same attributes, so the line
 *    leaves the process (`export.ts` keeps a body only when it is a fixed message).
 * 3. The issue. One event in the error tracker at level `error` (`impactSignal.Incident` in
 *    `@vivid/contracts`), through the client `issuesLayer` initialises and not through
 *    `ErrorReporter` (an Incident is an outcome, not an exception), with:
 *    - `fingerprint`: the case's tag, then `<service>.<tag>` of every hop of the cause. One group
 *      per path of failure, so a cell `SchemaError` under a send is a different issue from a cell
 *      `PiRejected` under a send, which a fingerprint of only the first hop would merge.
 *    - `tags`: every attribute below, so someone holding only the tracker can filter by case,
 *      by service, by tag and by the affected ids.
 *    - `contexts.trace`: `trace_id` and `span_id` of the current Effect span, read from the fiber
 *      as `issues.ts` `reporterLayer` reads them, so the issue opens the trace.
 *    - the event's message: the case's tag, a code name; no exception and no stack, since none
 *      exists and the case says what happened.
 *    The event goes through the same `beforeSend` scrub as every other, which must keep
 *    `fingerprint` and the `vivid.incident.*` tags it now drops.
 *
 * The attributes, derived from `Incident`'s schema and never listed by hand (the way
 * `refusal.ts` derives `refusalExport` from `Refusal.cases`):
 *
 * - `vivid.incident.kind`: the case's tag, one of `Struct.keys(Incident.cases)`.
 * - `vivid.incident.<field>` for each field of each case other than `cause`. A field whose schema
 *   is a closed set of literals (`reason`, `delivery`, `step`) is admitted when its value is a
 *   member (`refusal.ts` `membersOf`). A field that is a branded id is admitted by the shape its
 *   generator guarantees, the way `export.ts` admits `vivid.connection.id` only as a version 4
 *   UUID; an id with no guaranteed shape stays on the stdout line.
 * - `vivid.incident.cause.<n>.service`, `.operation`, `.tag`, `.status` for hop `n` from 0, and
 *   `.issues` as `<path joined by .>:<kind>` items joined by `,`. `service` is admitted as a
 *   member of `IncidentSource`, `operation` and `tag` by `CodeName`, `status` as an integer from
 *   100 to 599, `issues` when every item is built of code names, indices and `IssueKind`
 *   members. `n` runs below `DEEPEST_CAUSE`, so the set of keys is finite and known.
 *
 * So `export.ts` gains one spread, `...incidentExport.map(...)`, beside `refusalExport`, and a case
 * or a field added to `Incident` is exported without a second list to extend.
 */
export interface IncidentsService {
  readonly record: (incident: Incident) => Effect.Effect<void>
}

export class Incidents extends Context.Service<Incidents, IncidentsService>()('vivid/Incidents') {}

/** The attribute an Incident's part is written under, on the span, the log line and the issue. */
const attribute = (name: string) => `vivid.incident.${name}`

/** The attribute naming which case an Incident is. */
export const INCIDENT_KIND = attribute('kind')

/** The parts of one hop, each written under `vivid.incident.cause.<n>.<part>`. */
type HopPart = 'service' | 'operation' | 'tag' | 'status' | 'issues'
const hopAttribute = (index: number, part: HopPart) => attribute(`cause.${index}.${part}`)

/**
 * A value one attribute may hold when it leaves the process. Status is a number on a span and a
 * log line and a string of three digits on an issue's tag, since a tag's value is always text.
 */
type Scalar = string | number
type Admits = (value: Scalar) => boolean

const words =
  (members: ReadonlyArray<string>): Admits =>
  (value) =>
    Predicate.isString(value) && members.includes(value)
const shaped =
  (pattern: RegExp): Admits =>
  (value) =>
    Predicate.isString(value) && value.length <= 200 && pattern.test(value)
const codeName: Admits = (value) => Predicate.isString(value) && isCodeName(value)
const httpStatus: Admits = (value) => {
  const status = Predicate.isString(value) && /^[1-5][0-9]{2}$/u.test(value) ? Number(value) : value
  return Predicate.isNumber(status) && Number.isInteger(status) && status >= 100 && status <= 599
}

/**
 * The fields of the cases other than their tag and cause, and the type each holds where it is a
 * branded id: Effect 4.0.2 `Brand.ts` keys a brand under `"~effect/Brand"`, which a literal of a
 * closed set does not carry.
 */
type FieldOf<T> = T extends unknown ? Exclude<keyof T, '_tag' | 'cause'> : never
type ValueAt<T, K extends PropertyKey> = T extends { readonly [P in K]: infer V } ? V : never
type IdField = {
  [K in FieldOf<Incident>]: ValueAt<Incident, K> extends { readonly '~effect/Brand': unknown }
    ? K
    : never
}[FieldOf<Incident>]

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const exactly = (...shapes: ReadonlyArray<string>) => new RegExp(`^(?:${shapes.join('|')})$`, 'u')

/**
 * The shape each id's generators guarantee, so an id leaves only when it cannot be text anybody
 * wrote. A field added to an Incident that is a branded id fails to typecheck here until its shape
 * is written, and an id with another shape (a test's, a future generator's) stays on stdout.
 *
 * - `personId`: Better Auth 1.7.5 `@better-auth/core/utils/id` `generateId`, 32 of `a-zA-Z0-9`;
 *   `auth/provider.ts` sets no `generateId` of its own.
 * - `threadId`: `randomUUID` from the clients and the server, `watch-` and `dream-` with 32 hex
 *   (`watches/receiver.ts` `threadOf`, `dreams/thread.ts` `dreamThread`), `forget-` and a UUID
 *   (`forget/close.ts`).
 * - `runId`: `run_` or `helper_` and a SHA-256 (`threads/key.ts` `deliveryRunId`,
 *   `runs/store.ts` `childRunId`).
 * - `notificationId`: `randomUUID` (`notifications/notifier.ts`), a SHA-256
 *   (`notifications/attention.ts`), or a Run's id and `:finished` (`threads/delivery.ts`).
 * - `connectionId`, `watchId`, `targetId`: `randomUUID` (`connections/store.ts`,
 *   `watches/lifecycle.ts`, `push/targets.ts`).
 */
const idShapes = {
  personId: exactly('[A-Za-z0-9]{32}'),
  threadId: exactly(UUID, '(?:watch|dream)-[0-9a-f]{32}', `forget-${UUID}`),
  runId: exactly('(?:run|helper)_[0-9a-f]{64}'),
  notificationId: exactly(UUID, '[0-9a-f]{64}', 'run_[0-9a-f]{64}:finished'),
  connectionId: exactly(UUID),
  watchId: exactly(UUID),
  targetId: exactly(UUID),
} satisfies Record<IdField, RegExp>

const isIdField = (field: string): field is IdField => Predicate.hasProperty(idShapes, field)

/**
 * How a field is admitted: by the words its schema admits (`refusal.ts` `membersOf`), else by its
 * id's shape. A field that is neither has no rule and stays on stdout.
 */
const fieldRule = (field: string, schema: { readonly ast: SchemaAST.AST }): Option.Option<Admits> =>
  Option.orElse(Option.map(membersOf(schema.ast), words), () =>
    isIdField(field) ? Option.some(shaped(idShapes[field])) : Option.none(),
  )

/** `<path joined by .>:<kind>` items joined by `,`, each step a code name or an index. */
const issueItem = new RegExp(
  `^(?:(?:[A-Za-z_$][A-Za-z0-9_$]*|[0-9]+)(?:\\.(?:[A-Za-z_$][A-Za-z0-9_$]*|[0-9]+))*)?:(?:${IssueKind.literals.join('|')})$`,
  'u',
)
const issueList: Admits = (value) =>
  Predicate.isString(value) &&
  value.length <= 2_000 &&
  value.split(',').every((item) => issueItem.test(item))

/**
 * Every key an Incident is written under, with what its value must be to leave the process. Read
 * from `Incident`'s schema, as `refusal.ts` reads `refusalExport` from `Refusal`, so the export
 * allowlist (`export.ts`) and the issue's scrub (`issues.ts`) follow a case or a field added there.
 *
 * A field named in several cases (`personId`) has one rule; the cases agree on its schema.
 */
export const incidentExport: ReadonlyArray<readonly [key: string, admits: Admits]> = [
  [INCIDENT_KIND, words(Struct.keys(Incident.cases))],
  ...Object.values(Incident.cases)
    .flatMap((variant) => Object.entries(variant.fields))
    .filter(([field]) => field !== '_tag' && field !== 'cause')
    .flatMap(([field, schema]) =>
      Option.toArray(fieldRule(field, schema)).map((admits) => [attribute(field), admits] as const),
    )
    .filter(([key], index, all) => all.findIndex(([other]) => other === key) === index),
  ...Array.from({ length: DEEPEST_CAUSE }, (_, index) => [
    [hopAttribute(index, 'service'), words(IncidentSource.literals)] as const,
    [hopAttribute(index, 'operation'), codeName] as const,
    [hopAttribute(index, 'tag'), codeName] as const,
    [hopAttribute(index, 'status'), httpStatus] as const,
    [hopAttribute(index, 'issues'), issueList] as const,
  ]).flat(),
]

const encodeIncident = Schema.encodeOption(Incident)

/** One hop's attributes; `status` and `issues` only where the hop has them. */
const hopAttributes = (hop: IncidentHop, index: number): Array<readonly [string, Scalar]> => [
  [hopAttribute(index, 'service'), hop.service],
  [hopAttribute(index, 'operation'), hop.operation],
  [hopAttribute(index, 'tag'), hop.tag],
  ...(hop.status === undefined ? [] : [[hopAttribute(index, 'status'), hop.status] as const]),
  ...(hop.issues === undefined
    ? []
    : [
        [
          hopAttribute(index, 'issues'),
          hop.issues.map(({ path, kind }) => `${path.join('.')}:${kind}`).join(','),
        ] as const,
      ]),
]

/**
 * An Incident as attributes, every one of them: the kind, each field of the case and each hop of
 * the cause. Encoding through the schema keeps this total over the cases. Which of them leave the
 * process is `incidentExport`'s decision, made here for the issue and in `export.ts` for OTLP;
 * stdout has them all. `record` cannot fail, so a case whose fields will not encode is still said
 * by its kind and cause.
 */
const attributesOf = (incident: Incident): Record<string, Scalar> => ({
  [INCIDENT_KIND]: incident._tag,
  ...Option.match(encodeIncident(incident), {
    onNone: () => ({}),
    onSome: (encoded) =>
      Object.fromEntries(
        Object.entries(encoded).flatMap(([field, value]) =>
          field !== '_tag' && field !== 'cause' && Predicate.isString(value)
            ? [[attribute(field), value]]
            : [],
        ),
      ),
  }),
  ...Object.fromEntries(incident.cause.flatMap(hopAttributes)),
})

const rules = new Map(incidentExport)

/** The attributes that may leave on an issue, each as a tag's text. */
export const incidentTags = (
  attributes: Readonly<Record<string, unknown>>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(attributes).flatMap(([key, value]) => {
      const admits = rules.get(key)
      return admits !== undefined &&
        (Predicate.isString(value) || Predicate.isNumber(value)) &&
        admits(value)
        ? [[key, String(value)]]
        : []
    }),
  )

/** `<service>.<tag>`, as a fingerprint names a hop. */
const hopName = (hop: IncidentHop) => `${hop.service}.${hop.tag}`
const hopNamePattern = new RegExp(`^(?:${IncidentSource.literals.join('|')})\\.`, 'u')

/**
 * Whether `fingerprint` is one an Incident writes: its case's tag, then `<service>.<tag>` of each
 * hop. `issues.ts` keeps a fingerprint only when it is.
 */
export const isIncidentFingerprint = (fingerprint: ReadonlyArray<string>): boolean => {
  const [kind, ...hops] = fingerprint
  return (
    kind !== undefined &&
    Struct.keys(Incident.cases).some((tag) => tag === kind) &&
    hops.length <= DEEPEST_CAUSE &&
    hops.every((hop) => hopNamePattern.test(hop) && isCodeName(hop.replace(hopNamePattern, '')))
  )
}

/** Whether `message` is an Incident case's tag, the only message an issue may carry. */
export const isIncidentMessage = (message: string): boolean =>
  Struct.keys(Incident.cases).some((tag) => tag === message)

/**
 * The type `_OTHER` as a code name, for a hop whose failure has no type a class gives it (OTel's
 * reserved name, `failure.ts` `UNTYPED`). It is a code name by its own spelling, so the process
 * cannot start without it.
 */
const UNNAMED = Result.getOrThrow(Schema.decodeResult(CodeName)('_OTHER'))

/**
 * One hop of a cause. `operation` is a literal from code (an `Effect.fn` name) and `tag` the
 * failure's code-owned tag (its class's, or `failure.ts` `failureType`); a tag without the shape
 * of a code name is `_OTHER`, the way `failure.ts` `typeOf` treats one.
 */
export const hop = (service: IncidentSource, operation: string, tag: string): IncidentHop => ({
  service,
  operation: Option.getOrElse(CodeName.makeOption(operation), () => UNNAMED),
  tag: Option.getOrElse(CodeName.makeOption(tag), () => UNNAMED),
})

/** A cause of one hop, for an outcome decided in this process with nothing under it to carry. */
export const causeOf = (head: IncidentHop): IncidentCause => [head]

/**
 * The recorder, in the order `IncidentsService` specifies: the span, the log line, the issue.
 *
 * The span's status is made an error at export (`export.ts` `allowSpan`), because Effect 4.0.2
 * `OtlpTracer.ts` `makeOtlpSpan` takes a span's status from how its effect ended alone, and the
 * producer's effect usually succeeds: it decided the outcome and returned it as a value.
 *
 * The event goes through the SDK's global client (`Sentry.captureEvent`), which `issuesLayer`
 * initialises when `SENTRY_DSN` is set and which drops the event when it is not, so this Layer
 * needs nothing of its own and is the same in tests.
 */
const record = Effect.fnUntraced(function* (incident: Incident) {
  const attributes = attributesOf(incident)
  yield* Effect.annotateCurrentSpan(attributes)
  yield* Effect.annotateLogs(
    Effect.logWithLevel(impactSignal.Incident.level)(Message.incident),
    attributes,
  )
  const span = yield* Effect.option(Effect.currentSpan)
  const trace = Option.filter(span, ({ traceId, spanId }) => isTraceId(traceId) && isSpanId(spanId))
  yield* Effect.sync(() => {
    Sentry.captureEvent({
      message: incident._tag,
      level: 'error',
      fingerprint: [incident._tag, ...incident.cause.map(hopName)],
      tags: incidentTags(attributes),
      contexts: Option.match(trace, {
        onNone: () => ({}),
        onSome: ({ traceId, spanId }) => ({ trace: { trace_id: traceId, span_id: spanId } }),
      }),
    })
  })
})

/**
 * The recorder. It holds nothing (see `record`), so a producer that is an exported program rather
 * than a Layer provides it with `Effect.provideService` where it says Incidents.
 */
export const recorder = Incidents.of({ record })

/** The recorder's Layer. */
export const incidentsLayer = Layer.succeed(Incidents, recorder)
