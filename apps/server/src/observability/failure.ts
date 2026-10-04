import { EffectDrizzleQueryError } from 'drizzle-orm/effect-core/errors'
import * as Arr from 'effect/Array'
import * as Cause from 'effect/Cause'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as PlatformError from 'effect/PlatformError'
import * as Predicate from 'effect/Predicate'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as SchemaAST from 'effect/SchemaAST'
import * as HttpClientError from 'effect/unstable/http/HttpClientError'
import * as HttpServerError from 'effect/unstable/http/HttpServerError'
import { Message } from './messages.ts'

/**
 * Where a failure stopped being the caller's problem and became an answer: a product call, a plain
 * HTTP route, a scheduled pass, or a call to the runtime. The set is closed so that a count by
 * boundary in the telemetry backend never grows a misspelt bucket, and it is a schema so the
 * export allowlist (`export.ts`) admits exactly these values.
 */
export const Boundary = Schema.Literals(['rpc', 'http', 'schedule', 'runtime'])
export type Boundary = typeof Boundary.Type

/** Whether the code declared the failure (`expected`) or did not (`defect`). */
export const FailureKind = Schema.Literals(['expected', 'defect'])
export type FailureKind = typeof FailureKind.Type

/**
 * The attributes a failure is recorded under, on the span and on its log line. The export
 * allowlist (`export.ts`) names the ones that may leave and the set each value must belong to;
 * `constraint` is not among them and is read on stdout only, because a constraint's name is a
 * property of whatever was thrown and there is no set to check it against.
 *
 * The failure's message is deliberately not one of them. It is prose a provider, a driver or a
 * Person's input wrote, and no pattern can tell private prose from technical prose, so it is
 * written to the stdout line only (`MESSAGE_ANNOTATION`) and never leaves the process.
 */
export const FailureAttribute = {
  type: 'error.type',
  kind: 'vivid.failure.kind',
  boundary: 'vivid.boundary',
  root: 'vivid.failure.root',
  databaseCode: 'db.response.status_code',
  constraint: 'vivid.failure.constraint',
  table: 'db.collection.name',
} as const

/** The log annotation holding the failure's message; read on stdout, absent from the allowlist. */
const MESSAGE_ANNOTATION = 'vivid.failure.message'

/** Longest text one diagnostic string may carry; `redactBrowserText` in the reference bounds at the same length. */
const LONGEST_TEXT = 2_048
/**
 * How much of a text `redact` reads: twice what it keeps. Nothing past this is looked at, so what
 * `redact` costs does not depend on how long a failure's message is.
 */
export const LONGEST_SCAN = LONGEST_TEXT * 2
/** Longest path kept of an address. A path is where a webhook's token sits, so it is not kept whole. */
const LONGEST_PATH = 200
const LONGEST_MESSAGE = 1_000
const LONGEST_DATABASE_NAME = 200
/** How far the `cause` chain is followed; a foreign chain can be cyclic or arbitrarily long. */
const DEEPEST_CAUSE = 8

/**
 * OpenTelemetry's `error.type` value for a failure that names no type (a thrown string, a bare
 * object). The semantic convention reserves `_OTHER` for exactly this, so the attribute is always
 * present and a missing type is countable instead of being an absent attribute.
 */
export const UNTYPED = '_OTHER'

/**
 * What stands for removed text: `label` when the removed text is at least that long, and one `*`
 * when it is shorter. Removed text is never empty (every pattern below takes at least one
 * character of it), so the mark is never longer than what it replaces.
 */
const mark = (label: string, removed: string) => (removed.length < label.length ? '*' : label)

const SECRET = '[REDACTED]'

/** Keeps what introduces a credential (`Bearer `, `token=`) and marks the credential itself. */
const credential = (_matched: string, introduction: string, secret: string) =>
  `${introduction}${mark(SECRET, secret)}`

/**
 * An address without its sign-in, query and fragment, built only from pieces of the text that was
 * matched: the scheme, the host as written, and the opening of the path. Nothing is parsed or
 * re-encoded. `URL#toString` percent-encodes, which turned 4,096 characters of non-ASCII path into
 * about 36,700 and handed that to the patterns after it.
 *
 * A path that holds an `@` means the sign-in was not where the pattern looked for it (a password
 * with a `/` in it ends the authority early), so nothing of that address is kept.
 */
const address = (_matched: string, scheme: string, host: string, path: string) =>
  path.includes('@') ? '[URL]' : `${scheme}${host}${path.slice(0, LONGEST_PATH)}`

/** One pass of `redact`: what to find, and what stands in its place. */
type Redaction = readonly [
  pattern: RegExp,
  replace: (matched: string, ...groups: Array<string>) => string,
]

/**
 * The passes of `redact`, in the order they run. Each is written so that its time is linear in the
 * text, by one of three constructions, and `failure.test.ts` checks the first of them on the
 * sources:
 *
 * - No group that repeats without bound: every `(...)` is followed by nothing, `?`, or `{m,n}`.
 * - A repetition without bound is of one character class and is followed by something that class
 *   excludes (or by nothing), so where it stops is decided once and backing off finds nothing new.
 *   Where a failed attempt could be started again inside the same run of characters (the token
 *   patterns), a lookbehind forbids a start there, so a run is read a fixed number of times.
 * - Everything else is counted: an address's local part is at most 64 characters and a label of
 *   its domain at most 63 (RFC 5321), a key's name is read 40 characters back, a gap is at most 8
 *   spaces. An attempt from one position then costs a fixed amount.
 *
 * Each also leaves the text no longer than it found it: a replacement is a piece of what was
 * matched, or a mark no longer than it (`mark`), or a fixed text no longer than the shortest
 * match.
 *
 * A credential that the cut (`LONGEST_SCAN`) left unfinished is removed to the end of the text:
 * a quoted value whose closing quote is beyond the cut, a statement whose `params:` line is, a
 * token whose later segments are. Before, none of these matched and its opening was written out.
 */
const redactions: ReadonlyArray<Redaction> = [
  // A Drizzle statement to the end of its `params:` line, or to the end of the text when that
  // line is not in it. The shortest match is `Failed query:`, 13 characters, as is what replaces it.
  [/Failed query:(?:[\s\S]*?\nparams:[^\n]*|[\s\S]*$)/g, () => '[SQL omitted]'],
  // scheme, optional sign-in up to the last `@` of the authority, host, path, then query and
  // fragment. Every part after the scheme may be empty, so an attempt never fails once begun.
  [
    /(https?:\/\/)(?:[^\s"'<>\\/?#]*@)?([^\s"'<>\\/?#@]*)((?:\/[^\s"'<>\\?#]*)?)[^\s"'<>\\]*/gi,
    address,
  ],
  [/(\bBearer\s{1,8})([^\s,"'<>]+)/gi, credential],
  // A JSON Web Token: three segments, or the opening of one that runs to the end of the text.
  [
    /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:\.[A-Za-z0-9_-]*)?$)/g,
    (matched) => mark(SECRET, matched),
  ],
  [/(?<![A-Za-z0-9])(?:sk[-_]|gh[pousr]_)[A-Za-z0-9_-]+/g, (matched) => mark(SECRET, matched)],
  // `name = value`, the value quoted or bare. A quote still open at the end of the text closes there.
  [
    /((?:authorization|cookie|password|passwd|secret|token|[a-z0-9_-]{0,40}key)\s{0,8}[=:]\s{0,8})("[^"]*(?:"|$)|'[^']*(?:'|$)|[^\s,;&"']+)/gi,
    credential,
  ],
  [
    /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Z0-9-]{1,63}(?:\.[A-Z0-9-]{1,63}){1,8}/gi,
    (matched) => mark('[EMAIL REDACTED]', matched),
  ],
]

/** The patterns `redact` runs, for the test that checks how each is built. */
export const redactionPatterns: ReadonlyArray<RegExp> = redactions.map(([pattern]) => pattern)

/**
 * Removes credentials, address query strings and personal identifiers from the diagnostic text
 * written to stdout, and bounds it. It is not what keeps text out of the export: that is the
 * allowlist in `export.ts`, which drops every message whatever it contains.
 *
 * Ported from VCOS `apps/web/src/shared/privacy.ts` `redactBrowserText`, with these changes for
 * Vivid. A Drizzle statement (`Failed query: … params: …`) is replaced whole, because a statement
 * can sit inside a wrapped message where the reference's per-record look-through cannot reach
 * it. Any `…key=` assignment is treated as a credential, because the export header itself is
 * one (`sentry_key=`). And every pattern is rewritten to be linear and to shorten or keep the
 * text's length (`redactions`): the reference's address pattern takes time that grows with the
 * square of a text with no `@` in it, and its address rewrite re-encodes.
 *
 * The cost, in the worst case: the text is cut to `LONGEST_SCAN` (4,096) characters before
 * anything reads it, each of the seven passes is linear in what it is given, and no pass hands the
 * next one more than it was given. So the whole is at most seven linear passes over 4,096
 * characters, whatever the length of the failure's message; the largest constant is the address
 * pass, about 130 steps from each position (64 forward and 64 back). Measured once on a development
 * machine, the costliest text found (4,096 characters an address's local part accepts, with no
 * `@`) took 1.5 ms; the text that took 0.8 s before (a non-ASCII address) takes 0.03 ms.
 *
 * This is defence in depth for the server's own log, as in the reference: prose can still hold
 * private data, so messages on typed errors must stay technical.
 */
export const redact = (value: string): string =>
  redactions
    .reduce(
      (text, [pattern, replace]) => text.replace(pattern, replace),
      // Cut before any pattern runs: a failure's message can be a statement with its parameters or
      // a provider's echoed prompt, and recording a failure must never be what stalls the server.
      value.slice(0, LONGEST_SCAN),
    )
    .slice(0, LONGEST_TEXT)

/**
 * The fields a failure may be asked for. Everything else on a thrown object is ignored, so a
 * provider's response body or a request's payload cannot be exported by being attached to an
 * error. `code`, `constraint` and `table` are the PostgreSQL driver's own field names.
 *
 * VCOS `apps/web/src/observability/cause.ts` `CapturedCauseDiagnostics`, without `detail` (a
 * constraint's detail quotes the offending row values), without `stack`, `column` and `schema`,
 * which the summary below does not report, and without `_tag` and `name`: a failure's type is
 * taken from its class (`typeOf`), never from a property.
 */
const Diagnostics = Schema.Struct({
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

/** One link of a cause chain: the value itself, for its class, and the fields read from it. */
interface Link {
  readonly value: object
  readonly record: Diagnostics
}

/**
 * The tag a class made by `Schema.TaggedError` declares, read from the class and never from the
 * instance.
 *
 * Every typed error Vivid declares is such a class, and so are the SQL errors
 * (`effect/unstable/sql/SqlError`) and Effect Drizzle's (`drizzle-orm/effect-core/errors`). What
 * identifies one, in rc.116 `Schema.ts` `makeClass`:
 *
 * - the class is itself a schema: `static readonly [TypeId] = TypeId`, which `Schema.isSchema`
 *   tests;
 * - its `static readonly fields` holds the struct's fields, where `Schema.TaggedError` puts
 *   `_tag: Schema.tag(tagValue)`, a `Literal` whose AST carries the tag as written in code.
 *
 * A thrown value cannot forge this by carrying a property: `failure._tag` is not read at all, and
 * the value must be an instance of the class its `constructor` names. `Schema.Error` and
 * `Schema.Class` with a literal `_tag` field go through the same `makeClass` and are read the
 * same way.
 *
 * The order of the checks is what keeps `instanceof` from throwing. `constructor` is a property
 * of the thrown value like any other, so it can be anything: a function without a `prototype`
 * (an arrow function) makes `instanceof` throw a `TypeError`. It is therefore asked first whether
 * it is a schema class, which no stray function is, and whether it has a prototype object, and
 * only then is the value tested against it. `constructor` is read once. A getter or a `Proxy`
 * can still throw on that one read; `summarize` contains that.
 *
 * The residual, accepted: this proves that the type is a schema class's tag, not that the class
 * was written in Vivid's code. Three things would put outside text in an exported type name, and
 * each needs code inside the process to do it, not a request:
 *
 * - a dependency that builds a class with `Schema.TaggedError` using text it was given as the
 *   tag;
 * - a subclass that overrides `static fields` with another `_tag`;
 * - an object whose prototype was set to such a class's (`Object.setPrototypeOf`), which then is
 *   an instance of it.
 *
 * No request path reaches any of them: a request is decoded into plain data by a schema that
 * already exists (`Schema.decodeUnknownEffect`), and decoding makes instances of declared classes;
 * it never declares a class, edits one, or sets a prototype. The review that raised this found no
 * path that does. Because the proof stops there, the exporter bounds what a miss could cost: it
 * admits a fixed number of distinct type names for the life of the process and no more
 * (`export.ts` `MOST_TYPE_NAMES`).
 */
const schemaTag = ({ value }: Link): Option.Option<string> => {
  const made: unknown = value.constructor
  if (!Predicate.isFunction(made) || !Schema.isSchema(made)) return Option.none()
  if (!Predicate.isObject(made.prototype) || !(value instanceof made)) return Option.none()
  if (!Predicate.hasProperty(made, 'fields')) return Option.none()
  const { fields } = made
  if (!Predicate.hasProperty(fields, '_tag') || !Schema.isSchema(fields._tag)) return Option.none()
  const { ast } = fields._tag
  return SchemaAST.isLiteral(ast) && Predicate.isString(ast.literal)
    ? Option.some(ast.literal)
    : Option.none()
}

/** A class, for `instanceof`, beside the fixed name its instances are reported under. */
type Named = readonly [made: abstract new (...parameters: Array<never>) => object, name: string]

/**
 * Effect's own error classes that reach a boundary here without being `Schema.TaggedError`
 * classes: rc.116 builds each with `Data.TaggedError(tag)`, which leaves nothing on the class to
 * read the tag from, so the tag is written beside the class and chosen by `instanceof`.
 *
 * - `HttpServerError`: a request body or route the HTTP server could not serve (`http/faults.ts`,
 *   `http/bytes.ts`).
 * - `HttpClientError`: a call to the runtime or a provider that did not come back.
 * - `SchemaError`: a payload that did not decode.
 * - `PlatformError`: the file system under the Library and the update bundles.
 * - `TimeoutError`, `NoSuchElementError`: `Effect.timeout` and an `Option` yielded empty.
 */
const EFFECT_ERRORS: ReadonlyArray<Named> = [
  [HttpServerError.HttpServerError, 'HttpServerError'],
  [HttpClientError.HttpClientError, 'HttpClientError'],
  [Schema.SchemaError, 'SchemaError'],
  [PlatformError.PlatformError, 'PlatformError'],
  [Cause.TimeoutError, 'TimeoutError'],
  [Cause.NoSuchElementError, 'NoSuchElementError'],
]

/**
 * JavaScript's built-in error classes, the more specific before `Error`, which every one of them
 * extends. The name is the class's, chosen by `instanceof`: `error.name` is a writable property
 * and is never read.
 */
const NATIVE_ERRORS: ReadonlyArray<Named> = [
  [AggregateError, 'AggregateError'],
  [TypeError, 'TypeError'],
  [RangeError, 'RangeError'],
  [ReferenceError, 'ReferenceError'],
  [SyntaxError, 'SyntaxError'],
  [EvalError, 'EvalError'],
  [URIError, 'URIError'],
  [Error, 'Error'],
]

/**
 * Every type name that is known without looking at a failure: the two lists above. The export
 * allowlist admits `exception.type` only from this set, because the tracer writes that attribute
 * from `error.name` (rc.116 `OtlpTracer.ts` `makeOtlpSpan`) and by then the class is gone.
 */
export const fixedTypeNames: ReadonlyArray<string> = [...EFFECT_ERRORS, ...NATIVE_ERRORS].map(
  ([, name]) => name,
)

/** The name of the first listed class the link's value is an instance of. */
const namedBy = (classes: ReadonlyArray<Named>, { value }: Link): Option.Option<string> =>
  Arr.findFirst(classes, ([made]) => value instanceof made).pipe(Option.map(([, name]) => name))

/** A type the code declared: a schema class's tag, else one of Effect's listed classes. */
const declaredType = (link: Link): Option.Option<string> =>
  Option.orElse(schemaTag(link), () => namedBy(EFFECT_ERRORS, link))

/** A declared type, else the built-in error class the value is an instance of. */
const thrownType = (link: Link): Option.Option<string> =>
  Option.orElse(declaredType(link), () => namedBy(NATIVE_ERRORS, link))

/**
 * The type one failure is exported under. Lexical shape is not provenance: a `_tag` or a `name`
 * is whatever the thrower assigned, and a provider SDK can build either from a response, so
 * neither is ever read. A type is exported only when it comes from a class.
 *
 * - An expected failure is typed by what the code declared (`declaredType`).
 * - A defect is typed the same way when it is such a class (a declared error that was turned
 *   into a defect is still that error), and otherwise by its built-in error class.
 * - Anything else is `_OTHER`, which also bounds how many distinct types the backend can be sent.
 */
const typeOf = (kind: FailureKind, link: Link): string =>
  Option.getOrElse(kind === 'expected' ? declaredType(link) : thrownType(link), () => UNTYPED)

/**
 * A link's own message, unless the link is Effect Drizzle's wrapper error. That wrapper's message
 * is the whole SQL statement followed by every parameter, and the parameters are a Person's
 * content, so it is never quoted: the driver error underneath carries the code that says what
 * went wrong. VCOS `recordMessage`.
 */
const messageOf = ({ value, record }: Link): Option.Option<string> =>
  value instanceof EffectDrizzleQueryError
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
  const links: Array<Link> = []
  let current = failure
  for (let depth = 0; depth < DEEPEST_CAUSE; depth += 1) {
    const value = Cause.isCause(current) ? Cause.squash(current) : current
    const decoded = decodeDiagnostics(value)
    if (Option.isNone(decoded) || !Predicate.isObject(value) || seen.has(value)) break
    seen.add(value)
    links.push({ value, record: decoded.value })
    current = decoded.value.cause
  }
  return { links, terminal: bounded(decodeText(current), LONGEST_MESSAGE) }
}

/** What is recorded about one failure. Every free-text string here has been through `redact`. */
export interface FailureSummary {
  /** The failure's type as its class gives it (`typeOf`); `_OTHER` when no class does. */
  readonly type: string
  /** For the stdout line only; see `FailureAttribute`. */
  readonly message: Option.Option<string>
  /** The type of the innermost cause, when there is a cause below the failure and a class names it. */
  readonly rootType: Option.Option<string>
  /** PostgreSQL's SQLSTATE and the schema names it reported, from whichever link carries them. */
  readonly databaseCode: Option.Option<string>
  readonly databaseConstraint: Option.Option<string>
  readonly databaseTable: Option.Option<string>
}

/**
 * Reduces one failure value to its summary.
 *
 * Ported from VCOS `apps/web/src/observability/exceptions.ts` `capturedExceptionSummary`: the
 * message is the failure's own unless that is the statement wrapper's, then the innermost
 * cause's, then a terminal string. Vivid drops the reference's organization and product identity
 * (VCOS concepts with no counterpart on a failure here) and its constraint `detail` and source
 * frame, and it types a failure by its class where the reference reads `_tag` and `name`
 * (`typeOf`): those are properties of the thrown value, and this summary is exported.
 *
 * Reading a foreign value can throw: see `summarize`, which is the only caller.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- The typed error channel is generic and a defect is unknown; `chain` decodes it at once.
const inspect = (kind: FailureKind, failure: unknown): FailureSummary => {
  const { links, terminal } = chain(failure)
  const outer = Option.fromUndefinedOr(links.at(0))
  const inner = links.length > 1 ? Option.fromUndefinedOr(links.at(-1)) : Option.none()
  const field = (key: 'code' | 'constraint' | 'table') =>
    Option.firstSomeOf(
      links.map(({ record }) =>
        bounded(Option.fromUndefinedOr(record[key]), LONGEST_DATABASE_NAME),
      ),
    )
  return {
    type: Option.match(outer, {
      onNone: () => UNTYPED,
      onSome: (link) => typeOf(kind, link),
    }),
    message: Option.firstSomeOf([
      Option.flatMap(outer, messageOf),
      Option.flatMap(inner, messageOf),
      terminal,
    ]),
    rootType: Option.flatMap(inner, thrownType),
    databaseCode: field('code'),
    databaseConstraint: field('constraint'),
    databaseTable: field('table'),
  }
}

/** What is recorded about a failure that could not be read: that there was one, and nothing more. */
const UNREADABLE: FailureSummary = {
  type: UNTYPED,
  message: Option.none(),
  rootType: Option.none(),
  databaseCode: Option.none(),
  databaseConstraint: Option.none(),
  databaseTable: Option.none(),
}

/**
 * The summary of one failure value, for any value at all. It does not throw.
 *
 * A failure is whatever was thrown or failed with, and reading it runs its code: `inspect` reads
 * `constructor`, `message`, `cause` and the driver's fields, and asks `instanceof`. A getter that
 * throws, a `Proxy` whose traps throw, or a revoked `Proxy` (where every operation is a
 * `TypeError`, `in` and `instanceof` included) turns any of those reads into an exception, and no
 * order of checks avoids that, because the first read is already the value's own code.
 *
 * That exception is caught here, with `Result.try`, and the failure is recorded as `_OTHER` with
 * no other field. This is the one place in the server where a defect is caught and discarded,
 * and the reason is particular to it. Everywhere else a defect is a bug in Vivid's own code and
 * must stop the work it is in. Here the code that threw belongs to the failure being reported:
 * the recorder runs inside `observeFailures`, on the way out of an effect that has already
 * failed, and Effect adds a recorder's defect to that effect's cause (`Effect.tapCause`). An HTTP
 * route that answers its typed failure would answer `500` in its place, and a scheduled pass that
 * carries on after a typed failure would stop. Recording must never change the outcome it
 * records, so what could not be read is counted as unreadable and the original cause goes on
 * untouched.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- The typed error channel is generic and a defect is unknown; `chain` decodes it at once.
export const summarize = (kind: FailureKind, failure: unknown): FailureSummary =>
  Result.getOrElse(
    Result.try(() => inspect(kind, failure)),
    () => UNREADABLE,
  )

/**
 * One reason an effect did not succeed. `Expected` is a typed failure the code declared; `Defect`
 * is one it did not. An interruption is not a failure at all (a client went away, the server is
 * stopping), so it has no case and nothing is recorded for it.
 */
export type FailureOutcome = Data.TaggedEnum<{
  Expected: { readonly summary: FailureSummary }
  Defect: { readonly summary: FailureSummary }
}>
export const FailureOutcome = Data.taggedEnum<FailureOutcome>()

/**
 * Every failure in a `Cause`, in the order the cause holds them. A cause is a list of reasons:
 * concurrent work, a failing finalizer or a failure during recovery each add one, and each is a
 * separate thing that went wrong, so each is reported. Interruptions are left out.
 */
export const failuresOf = <E>(cause: Cause.Cause<E>): ReadonlyArray<FailureOutcome> =>
  cause.reasons.flatMap((reason): ReadonlyArray<FailureOutcome> => {
    if (Cause.isDieReason(reason))
      return [FailureOutcome.Defect({ summary: summarize('defect', reason.defect) })]
    if (Cause.isFailReason(reason))
      return [FailureOutcome.Expected({ summary: summarize('expected', reason.error) })]
    return []
  })

/**
 * The one failure a span is classified by. A defect outranks a typed failure in the same cause:
 * it is the one that needs a person to look, and `RpcServer` treats a cause with any `Die` as
 * fatal for the same reason. Absent when the cause holds only interruptions.
 */
export const primaryOf = (failures: ReadonlyArray<FailureOutcome>): Option.Option<FailureOutcome> =>
  Option.orElse(Arr.findFirst(failures, FailureOutcome.$is('Defect')), () => Arr.head(failures))

const kindOf: (failure: FailureOutcome) => FailureKind = FailureOutcome.$match({
  Expected: (): FailureKind => 'expected',
  Defect: (): FailureKind => 'defect',
})

/**
 * The attributes of one failure. The first three are always present; the rest only when the
 * failure carries them, since an absent database code is different from an empty one. Which of
 * them leave the process is the export allowlist's decision, not this function's.
 */
const attributesOf = (boundary: Boundary, failure: FailureOutcome) => {
  const { summary } = failure
  const present = [
    [FailureAttribute.root, summary.rootType],
    [FailureAttribute.databaseCode, summary.databaseCode],
    [FailureAttribute.constraint, summary.databaseConstraint],
    [FailureAttribute.table, summary.databaseTable],
  ] as const
  return {
    [FailureAttribute.type]: summary.type,
    [FailureAttribute.kind]: kindOf(failure),
    [FailureAttribute.boundary]: boundary,
    ...Object.fromEntries(
      present.flatMap(([key, value]) => (Option.isSome(value) ? [[key, value.value]] : [])),
    ),
  }
}

/**
 * One log line for one failure: its attributes, plus the message for whoever reads stdout. An expected failure is a warning and a defect is an error, so the backend can alert on
 * defects without being paged for every refused sign-in.
 */
const line = (boundary: Boundary, failure: FailureOutcome) => {
  const attributes = attributesOf(boundary, failure)
  return Effect.annotateLogs(
    FailureOutcome.$match(failure, {
      Expected: () => Effect.logWarning(Message.failure),
      Defect: () => Effect.logError(Message.defect),
    }),
    Option.match(failure.summary.message, {
      onNone: () => attributes,
      onSome: (message) => ({ ...attributes, [MESSAGE_ANNOTATION]: message }),
    }),
  )
}

/**
 * Records the failures of one cause: the primary one as the current span's classification, and
 * every one as a log line. A span has one `error.type`, so it takes the primary; the lines are
 * where a second, concurrent or finalizer failure is still counted. It is untraced on purpose: a
 * span of its own would take the classification in place of the boundary's.
 */
const record = Effect.fnUntraced(function* (
  boundary: Boundary,
  failures: ReadonlyArray<FailureOutcome>,
) {
  const primary = primaryOf(failures)
  if (Option.isSome(primary))
    yield* Effect.annotateCurrentSpan(attributesOf(boundary, primary.value))
  yield* Effect.forEach(failures, (failure) => line(boundary, failure), { discard: true })
})

/**
 * Records every failure that passes through `effect`, and changes nothing about it: the result,
 * the error channel and the cause are the ones the effect produced, whatever the failure is. A
 * failure that throws when it is read is recorded as `_OTHER` (`summarize`).
 *
 * Apply it to the operation before the boundary turns its failures into an answer (`catchTags`, a
 * status code, a retry), because after that mapping the failure no longer exists. The span
 * annotated is the one current where this runs: the span of a named `Effect.fn` when passed as
 * one of its trailing transforms (rc.116 `internal/effect.ts` `makeFn` applies those inside the
 * span), otherwise the enclosing one, such as the HTTP request's. Where no span is current only
 * the log lines are written.
 *
 * VCOS decides per failure whether to report it (`apps/web/src/server/app/failure.ts`
 * `shouldCaptureServerFnFailure`); Vivid reports every one and marks it `expected` or `defect`,
 * because the request here is a count of all typed errors, not a pager.
 */
export const observeFailures =
  (boundary: Boundary) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.tapCause(effect, (cause) => record(boundary, failuresOf(cause)))
