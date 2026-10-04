import * as Cause from 'effect/Cause'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Predicate from 'effect/Predicate'
import * as Schema from 'effect/Schema'

/**
 * Where a failure stopped being the caller's problem and became an answer: a product call, a plain
 * HTTP route, a scheduled pass, or a call to the runtime. The set is closed so that a count by
 * boundary in the telemetry backend never grows a misspelt bucket.
 */
export type Boundary = 'rpc' | 'http' | 'schedule' | 'runtime'

/** Longest text one diagnostic string may carry; `redactBrowserText` in the reference bounds at the same length. */
const LONGEST_TEXT = 2_048
const LONGEST_MESSAGE = 1_000
const LONGEST_TYPE = 160
const LONGEST_DATABASE_NAME = 200
/** How far the `cause` chain is followed; a foreign chain can be cyclic or arbitrarily long. */
const DEEPEST_CAUSE = 8

/**
 * OpenTelemetry's `error.type` value for a failure that names no type (a thrown string, a bare
 * object). The semantic convention reserves `_OTHER` for exactly this, so the attribute is always
 * present and a missing type is countable instead of being an absent attribute.
 */
const UNTYPED = '_OTHER'

/**
 * Effect Drizzle's wrapper error. Its message is the whole SQL statement followed by every
 * parameter, and the parameters are a Person's content, so the wrapper's own message is never
 * quoted: the driver error underneath carries the code that says what went wrong.
 */
const STATEMENT_WRAPPER = 'EffectDrizzleQueryError'

/**
 * Removes credentials, address query strings and personal identifiers from diagnostic text, and
 * bounds it.
 *
 * Ported from VCOS `apps/web/src/shared/privacy.ts` `redactBrowserText`, with two changes for
 * Vivid. A Drizzle statement (`Failed query: … params: …`) is replaced whole, because here the
 * text also reaches the backend inside stack traces and rendered causes, where the reference's
 * per-record look-through cannot reach it. And any `…key=` assignment is treated as a credential,
 * because the export header itself is one (`sentry_key=`).
 *
 * This is defence in depth, as in the reference: prose can still hold private data, so messages on
 * typed errors must stay technical.
 */
export const redact = (value: string): string =>
  value
    .replace(/Failed query:[\s\S]*?\nparams:[^\n]*/g, 'Failed query: [statement omitted]')
    .replace(/https?:\/\/[^\s"'<>\\]+/gi, (candidate) => {
      if (!URL.canParse(candidate)) return '[URL omitted]'
      const url = new URL(candidate)
      url.username = ''
      url.password = ''
      url.search = ''
      url.hash = ''
      return url.toString()
    })
    .replace(/\bBearer\s+[^\s,"'<>]+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/\b(?:sk[-_]|gh[pousr]_)[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(
      /((?:authorization|cookie|password|passwd|secret|token|[a-z0-9_-]*key)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&"']+)/gi,
      '$1[REDACTED]',
    )
    .replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi, '[EMAIL REDACTED]')
    .slice(0, LONGEST_TEXT)

/**
 * The fields a failure may be asked for. Everything else on a thrown object is ignored, so a
 * provider's response body or a request's payload cannot be exported by being attached to an
 * error. `code`, `constraint` and `table` are the PostgreSQL driver's own field names.
 *
 * VCOS `apps/web/src/observability/cause.ts` `CapturedCauseDiagnostics`, without `detail` (a
 * constraint's detail quotes the offending row values) and without `stack`, `column` and `schema`,
 * which the summary below does not report.
 */
const Diagnostics = Schema.Struct({
  _tag: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
  code: Schema.optional(Schema.String),
  constraint: Schema.optional(Schema.String),
  table: Schema.optional(Schema.String),
})
interface Diagnostics extends Schema.Schema.Type<typeof Diagnostics> {}

const decodeDiagnostics = Schema.decodeUnknownOption(Diagnostics)
const decodeText = Schema.decodeUnknownOption(Schema.String)

/** One diagnostic string, redacted, bounded, and absent when nothing is left of it. */
const bounded = (value: Option.Option<string>, longest: number): Option.Option<string> =>
  value.pipe(
    Option.map((text) => redact(text).slice(0, longest)),
    Option.filter((text) => text.length > 0),
  )

/** The typed `_tag`, else the native error name. VCOS `exceptions.ts` `kindOf`. */
const typeOf = (record: Diagnostics): Option.Option<string> =>
  Option.orElse(bounded(Option.fromUndefinedOr(record._tag), LONGEST_TYPE), () =>
    bounded(Option.fromUndefinedOr(record.name), LONGEST_TYPE),
  )

/** A record's own message, unless the record is the statement wrapper. VCOS `recordMessage`. */
const messageOf = (record: Diagnostics): Option.Option<string> =>
  Option.exists(typeOf(record), (type) => type === STATEMENT_WRAPPER)
    ? Option.none()
    : bounded(Option.fromUndefinedOr(record.message), LONGEST_MESSAGE)

/**
 * Follows `cause` from the failure inward, reading only the allowed fields at each link. A nested
 * Effect `Cause` stands for the failure inside it (VCOS `cause.ts` `unwrapCapturedCause`). The
 * walk stops at the depth bound, at a link already visited, and at the first value that is not an
 * object; a string left at that point is the terminal message (`throw "text"`).
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- A failure is unknown by Effect's contract (`Die.defect`, a foreign `cause`); this is where it is decoded.
const chain = (failure: unknown) => {
  const seen = new WeakSet<object>()
  const records: Array<Diagnostics> = []
  let current = failure
  for (let depth = 0; depth < DEEPEST_CAUSE; depth += 1) {
    const link = Cause.isCause(current) ? Cause.squash(current) : current
    const decoded = decodeDiagnostics(link)
    if (Option.isNone(decoded) || !Predicate.isObject(link) || seen.has(link)) break
    seen.add(link)
    records.push(decoded.value)
    current = decoded.value.cause
  }
  return { records, terminal: bounded(decodeText(current), LONGEST_MESSAGE) }
}

/** What is exported about one failure. Every string here has been through `redact`. */
export interface FailureSummary {
  /** The error's `_tag`, else its `name`, else `_OTHER`. */
  readonly type: string
  readonly message: Option.Option<string>
  /** The type of the innermost cause, when there is a cause below the failure itself. */
  readonly rootType: Option.Option<string>
  /** PostgreSQL's SQLSTATE and the schema names it reported, from whichever link carries them. */
  readonly databaseCode: Option.Option<string>
  readonly databaseConstraint: Option.Option<string>
  readonly databaseTable: Option.Option<string>
}

/**
 * Reduces one failure value to its exportable summary.
 *
 * Ported from VCOS `apps/web/src/observability/exceptions.ts` `capturedExceptionSummary`: the type
 * prefers `_tag` over `name`, the message is the failure's own unless that is the statement
 * wrapper's, then the innermost cause's, then a terminal string. Vivid drops the reference's
 * organization and product identity (VCOS concepts with no counterpart on a failure here) and its
 * constraint `detail` and source frame.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- The typed error channel is generic and a defect is unknown; `chain` decodes it at once.
export const summarize = (failure: unknown): FailureSummary => {
  const { records, terminal } = chain(failure)
  const outer = Option.fromUndefinedOr(records.at(0))
  const inner = records.length > 1 ? Option.fromUndefinedOr(records.at(-1)) : Option.none()
  const field = (key: 'code' | 'constraint' | 'table') =>
    Option.firstSomeOf(
      records.map((record) => bounded(Option.fromUndefinedOr(record[key]), LONGEST_DATABASE_NAME)),
    )
  return {
    type: Option.getOrElse(Option.flatMap(outer, typeOf), () => UNTYPED),
    message: Option.firstSomeOf([
      Option.flatMap(outer, messageOf),
      Option.flatMap(inner, messageOf),
      terminal,
    ]),
    rootType: Option.flatMap(inner, typeOf),
    databaseCode: field('code'),
    databaseConstraint: field('constraint'),
    databaseTable: field('table'),
  }
}

/**
 * How an effect ended when it did not succeed. `Expected` is a typed failure the code declared;
 * `Defect` is one it did not. `Interrupted` is not a failure at all (a client went away, the
 * server is stopping) and nothing is recorded for it.
 */
export type FailureOutcome = Data.TaggedEnum<{
  Expected: { readonly summary: FailureSummary }
  Defect: { readonly summary: FailureSummary }
  Interrupted: {}
}>
export const FailureOutcome = Data.taggedEnum<FailureOutcome>()

/**
 * Classifies a `Cause`. A defect outranks a typed failure in the same cause: it is the one that
 * needs a person to look, and `RpcServer` treats a cause with any `Die` as fatal for the same
 * reason. A cause with neither holds only interruptions.
 */
export const failureOf = <E>(cause: Cause.Cause<E>): FailureOutcome => {
  const die = cause.reasons.find(Cause.isDieReason)
  if (die !== undefined) return FailureOutcome.Defect({ summary: summarize(die.defect) })
  const fail = cause.reasons.find(Cause.isFailReason)
  if (fail !== undefined) return FailureOutcome.Expected({ summary: summarize(fail.error) })
  return FailureOutcome.Interrupted()
}

/**
 * The exported attributes of one failure. The first three are always present; the rest only when
 * the failure carries them, since an absent database code is different from an empty one.
 */
const attributesOf = (boundary: Boundary, kind: 'expected' | 'defect', summary: FailureSummary) => {
  const present = [
    ['vivid.failure.message', summary.message],
    ['vivid.failure.root', summary.rootType],
    ['db.response.status_code', summary.databaseCode],
    ['vivid.failure.constraint', summary.databaseConstraint],
    ['db.collection.name', summary.databaseTable],
  ] as const
  return {
    'error.type': summary.type,
    'vivid.failure.kind': kind,
    'vivid.boundary': boundary,
    ...Object.fromEntries(
      present.flatMap(([key, value]) => (Option.isSome(value) ? [[key, value.value]] : [])),
    ),
  }
}

/**
 * Writes one failure onto the current span and as one log line with the same attributes. An
 * expected failure is a warning and a defect is an error, so the backend can alert on defects
 * without being paged for every refused sign-in.
 */
const record = (boundary: Boundary, kind: 'expected' | 'defect', summary: FailureSummary) => {
  const attributes = attributesOf(boundary, kind, summary)
  const line =
    kind === 'defect'
      ? Effect.logError('Defect reached a boundary')
      : Effect.logWarning('Failure reached a boundary')
  return Effect.annotateCurrentSpan(attributes).pipe(
    Effect.andThen(Effect.annotateLogs(line, attributes)),
  )
}

/**
 * Records every failure that passes through `effect`, and changes nothing about it: the result,
 * the error channel and the cause are the ones the effect produced.
 *
 * Apply it to the operation before the boundary turns its failures into an answer (`catchTags`, a
 * status code, a retry), because after that mapping the failure no longer exists. The span
 * annotated is the one current where this runs: the span of a named `Effect.fn` when passed as
 * one of its trailing transforms (rc.116 `internal/effect.ts` `makeFn` applies those inside the
 * span), otherwise the enclosing one, such as the HTTP request's. Where no span is current only
 * the log line is written.
 *
 * VCOS decides per failure whether to report it (`apps/web/src/server/app/failure.ts`
 * `shouldCaptureServerFnFailure`); Vivid reports every one and marks it `expected` or `defect`,
 * because the request here is a count of all typed errors, not a pager.
 */
export const observeFailures =
  (boundary: Boundary) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.tapCause(effect, (cause) =>
      FailureOutcome.$match(failureOf(cause), {
        Expected: ({ summary }) => record(boundary, 'expected', summary),
        Defect: ({ summary }) => record(boundary, 'defect', summary),
        Interrupted: () => Effect.void,
      }),
    )
