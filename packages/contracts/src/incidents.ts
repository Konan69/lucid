import * as Match from 'effect/Match'
import * as Option from 'effect/Option'
import * as Predicate from 'effect/Predicate'
import * as Schema from 'effect/Schema'
import * as SchemaAST from 'effect/SchemaAST'
import type * as SchemaIssue from 'effect/SchemaIssue'
import * as Struct from 'effect/Struct'
import { ConnectionId, NotificationId, PersonId, RunId, ThreadId } from './identity.js'
import { PushTargetId } from './push.js'
import { RunFailure } from './runs.js'
import { SignalCue } from './threads.js'
import { WatchId } from './watches.js'

/**
 * A code identifier, optionally dotted: an error's `_tag`, an `Effect.fn` name, an RPC's tag.
 * No spaces, quotes, slashes or punctuation, so prose, an address and a statement cannot have
 * this shape, and the bound keeps a generated name from being a payload. It is the same rule as
 * the server's `isCodeName` (`apps/server/src/observability/messages.ts`), which is to become
 * `Schema.is(CodeName)` so the rule has one home.
 *
 * Shape is not provenance: a name built from data can have this shape. Every writer of a
 * `CodeName` writes a literal from code (a class's declared tag, an `Effect.fn` name), and the
 * lint that enforces the keep-cause rule (`IncidentCause`) checks the operation is a literal.
 */
export const CodeName = Schema.String.check(
  Schema.isMaxLength(120),
  Schema.isPattern(/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/u),
).pipe(Schema.brand('CodeName'))
export type CodeName = typeof CodeName.Type

/**
 * Which part of Vivid, or which party it depends on, a hop of a cause happened in. Each is a
 * process or a provider someone holding only the telemetry backend can go and look at:
 *
 * - `server`, `cell`: Vivid's application server and a Person's conversation runtime.
 * - `phone`, `web`, `desktop`: Vivid's clients.
 * - `executor`: the Integration layer. `boat`: the Computer provider. `model`: the model
 *   provider. `push`: the phone push service. `postgres`: the product database.
 *
 * `postgres` and `push` are here beside the ones first proposed because both refuse work a
 * Person is owed today (`DatabaseUnavailable` at every boundary, `PushRejected` in
 * `apps/server/src/push/delivery.ts`). A part Vivid comes to depend on is added here, and the
 * export allowlist follows by derivation.
 */
export const IncidentSource = Schema.Literals([
  'server',
  'cell',
  'phone',
  'web',
  'desktop',
  'executor',
  'boat',
  'model',
  'push',
  'postgres',
])
export type IncidentSource = typeof IncidentSource.Type

/**
 * What kind of thing was wrong with a value that did not decode: the leaf tags of Effect 4.0.2's
 * `SchemaIssue.Leaf` (`effect/src/SchemaIssue.ts`), plus `AnyOf` for a union no member of which
 * matched, which is the one composite that can stand with no leaf under it.
 */
export const IssueKind = Schema.Literals([
  'InvalidType',
  'InvalidValue',
  'MissingKey',
  'UnexpectedKey',
  'Forbidden',
  'OneOf',
  'AnyOf',
])
export type IssueKind = typeof IssueKind.Type

/** The most issues one hop carries; the rest are dropped, since the first already says what broke. */
export const MOST_ISSUES = 8
/** The deepest path kept for one issue. */
export const LONGEST_ISSUE_PATH = 8

/**
 * One reason a value did not decode, without the value: where in the schema it was, and what
 * kind of wrong. A step of the path is a field the schema declares or an index into an array.
 *
 * The path stops before the first step that is not a property the schema declares: a key of a
 * `Schema.Record` and the key an `UnexpectedKey` names are the sender's data, and a model's tool
 * arguments are such a record. So a path never carries a key nobody wrote in code, and the
 * producer, not this schema, is where that is decided: the producer walks the schema's AST beside
 * the issue's `Pointer` path and cuts it there.
 */
export const Issue = Schema.Struct({
  path: Schema.Array(
    Schema.Union([CodeName, Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))]),
  ).check(Schema.isMaxLength(LONGEST_ISSUE_PATH)),
  kind: IssueKind,
})
export interface Issue extends Schema.Schema.Type<typeof Issue> {}

/**
 * One step of a cause: in `service`, the operation `operation` stopped with the failure `tag`.
 *
 * - `operation` is the code operation where that failure stopped being what it was, either
 *   because it was answered (a cell route refused, the server's boundary answered an RPC) or
 *   because it was replaced by another typed error. It is an `Effect.fn` name or an RPC's tag.
 * - `tag` is the failure's code-owned tag, taken from its class (the way
 *   `apps/server/src/observability/failure.ts` `schemaTag` reads it), never from a property of
 *   what was thrown. An Effect error with a reason takes the reason's tag where the reason is the
 *   part that tells failures apart: `HttpServerError` is `RequestParseError`, `RouteNotFound`,
 *   `InternalError` or `ResponseError`; `HttpClientError` is its reason's tag.
 * - `status` is the HTTP status this hop answered with, or for a `model` or `push` hop the status
 *   the provider answered with. Absent where the hop did not cross HTTP.
 * - `issues` says which fields failed and how, when `tag` is a decoding failure, or when a check
 *   on a decoded value refused named fields (see `RuntimeRefusal`'s `WrongThread`). Absent when
 *   there is no field to name.
 *
 * Nothing here is free text: every value is a literal of a closed set, a code name, a number in
 * a range or an issue built of those. So all of it may leave the process.
 */
export const IncidentHop = Schema.Struct({
  service: IncidentSource,
  operation: CodeName,
  tag: CodeName,
  status: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 }))),
  issues: Schema.optionalKey(
    Schema.Array(Issue).check(Schema.isNonEmpty(), Schema.isMaxLength(MOST_ISSUES)),
  ),
})
export interface IncidentHop extends Schema.Schema.Type<typeof IncidentHop> {}

/** One step of an `Issue`'s path. */
type IssueStep = Issue['path'][number]

const isCodeName = Schema.is(CodeName)

/**
 * The step `key` makes under `parent`, when it is one the schema declares: a property of a struct
 * whose name is a code name, or an index into an array. Anything else (a record's key, a key the
 * sender added, an AST this walk does not know) is the sender's data, and the path stops there.
 */
const declaredStep = (parent: Option.Option<SchemaAST.AST>, key: PropertyKey) =>
  Option.flatMap(parent, (ast): Option.Option<IssueStep> => {
    if (SchemaAST.isArrays(ast))
      return Predicate.isNumber(key) && Number.isInteger(key) && key >= 0
        ? Option.some(key)
        : Option.none()
    if (!SchemaAST.isObjects(ast) || !isCodeName(key)) return Option.none()
    return ast.propertySignatures.some((property) => property.name === key)
      ? Option.some(key)
      : Option.none()
  })

/**
 * Walks Effect 4.0.2's issue tree (`effect/src/SchemaIssue.ts`) beside the AST each `Composite`
 * carries. A `Pointer` adds its step only while every step so far was declared (`declaredStep`);
 * once the path is closed it stays at the last declared step, so the leaf is still reported, at
 * the deepest place the schema names. `AnyOf` stands for its union without descending: each
 * member's issues would say why the value was not that member, which is noise beside "no member".
 */
const walkIssue = (
  issue: SchemaIssue.Issue,
  path: ReadonlyArray<IssueStep>,
  open: boolean,
  parent: Option.Option<SchemaAST.AST>,
): ReadonlyArray<Issue> => {
  const leaf = ({ _tag }: SchemaIssue.Leaf | SchemaIssue.AnyOf): ReadonlyArray<Issue> => [
    { path, kind: _tag },
  ]
  return Match.value(issue).pipe(
    Match.tagsExhaustive({
      Pointer: (pointer) => {
        const [key, ...more] = pointer.path
        const step =
          open && key !== undefined && more.length === 0 && path.length < LONGEST_ISSUE_PATH
            ? declaredStep(parent, key)
            : Option.none<IssueStep>()
        return Option.match(step, {
          onNone: () => walkIssue(pointer.issue, path, false, Option.none()),
          onSome: (kept) => walkIssue(pointer.issue, [...path, kept], true, Option.none()),
        })
      },
      Composite: (composite) =>
        composite.issues.flatMap((inner) =>
          walkIssue(inner, path, open, Option.some(composite.ast)),
        ),
      Filter: (filter) => walkIssue(filter.issue, path, open, parent),
      Encoding: (encoding) => walkIssue(encoding.issue, path, open, parent),
      AnyOf: leaf,
      InvalidType: leaf,
      InvalidValue: leaf,
      MissingKey: leaf,
      UnexpectedKey: leaf,
      Forbidden: leaf,
      OneOf: leaf,
    }),
  )
}

/**
 * The `issues` of a hop whose failure is a value that did not decode: which declared fields
 * failed and how, never a value or a key the sender wrote. At most `MOST_ISSUES`, in the order
 * Effect reported them.
 */
export const issuesOf = (issue: SchemaIssue.Issue): ReadonlyArray<Issue> =>
  walkIssue(issue, [], true, Option.none()).slice(0, MOST_ISSUES)

/** The most hops one cause carries. A send that failed in the cell on a model's answer is four. */
export const DEEPEST_CAUSE = 6

/**
 * Why a Person's work did not happen, as a chain of hops from where it was decided (first) to
 * where it began (last), across processes: server, then cell, then model. It is the diagnostic
 * reason that survives every hop, so a cell's `SchemaError` on one field is still visible when
 * the server records the Run it failed.
 *
 * A flat bounded array rather than a nested `cause` field: the bound is one length check rather
 * than a recursive filter, a chain that grows past the bound keeps its root (see below), and the
 * export names each hop by its place without walking a tree.
 *
 * Bound: a chain longer than `DEEPEST_CAUSE` keeps its first `DEEPEST_CAUSE - 1` hops and its
 * last one. The root is the hop that says what broke, and the first hops say what it broke for;
 * the middle is what the trace already shows.
 *
 * The keep-cause rule (to be a lint; this is its specification).
 *
 * A failure that is replaced must not lose why it happened. So wherever a typed failure is turned
 * into a different typed failure, the new one carries the old one's cause:
 *
 * - The sites are `Effect.catchTag`, `Effect.catchTags`, `Effect.mapError`, `Effect.catch`,
 *   `Effect.catchIf` and `Effect.orElse`, and their `Stream` and `Layer` forms, whose handler
 *   returns or fails with a `Schema.TaggedError` of another tag than the one it caught.
 * - The new error's schema declares `cause: IncidentCause`, and the handler sets it to the caught
 *   error's cause with one hop added in front: `{ service: <this process>, operation: <the
 *   enclosing Effect.fn name, as a string literal>, tag: <the caught error's tag> }`, plus
 *   `status` and `issues` when the caught error has them. When the caught error itself carries
 *   `cause: IncidentCause`, that chain follows the new hop; otherwise the new hop is the root.
 * - A refusal answered over HTTP to another process (a cell's `refuse`) carries its cause in the
 *   body (`RuntimeRefusal.cause`), and the receiver puts that chain after its own hop.
 * - Exempt: a handler that answers a success value (that is recovery, judged by `Impact`), and a
 *   handler that re-fails with the same error it caught.
 * - The lint names the fix in its message: "<NewTag> replaces <CaughtTag> without its cause; give
 *   it `cause: IncidentCause` and pass the caught error's chain".
 */
export const IncidentCause = Schema.Array(IncidentHop).check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(DEEPEST_CAUSE),
)
export type IncidentCause = typeof IncidentCause.Type

/**
 * One hop, from the names code owns: `operation` is an `Effect.fn` name or a route's, `tag` a
 * failure's `_tag` or its reason's. `status` and `issues` are kept only when there are some, as
 * `IncidentHop` declares them.
 */
export const incidentHop = (input: {
  readonly service: IncidentSource
  readonly operation: string
  readonly tag: string
  readonly status: Option.Option<number>
  readonly issues: ReadonlyArray<Issue>
}): IncidentHop => {
  const named = {
    service: input.service,
    operation: CodeName.make(input.operation),
    tag: CodeName.make(input.tag),
  }
  const answered = Option.match(input.status, {
    onNone: () => named,
    onSome: (status) => ({ ...named, status }),
  })
  return input.issues.length === 0 ? answered : { ...answered, issues: input.issues }
}

/**
 * `cause` with `hop` put in front of it: the keep-cause rule's one step. Past `DEEPEST_CAUSE` it
 * keeps the first hops and the root, as `IncidentCause` says, so a chain that crosses one more
 * process never loses what broke.
 */
export const causeAfter = (hop: IncidentHop, cause: IncidentCause): IncidentCause => {
  const chain = [hop, ...cause]
  return chain.length <= DEEPEST_CAUSE
    ? chain
    : [...chain.slice(0, DEEPEST_CAUSE - 1), ...chain.slice(-1)]
}

/**
 * Which kind of delivery did not reach Vivid: a Person's own words (`Words`), or a server
 * delivery by its cue. Read from `SignalCue`'s cases, so a cue added there is a kind here.
 */
export const DeliveryKind = Schema.Literals(['Words', ...Struct.keys(SignalCue.cases)])
export type DeliveryKind = typeof DeliveryKind.Type

/** The Computer step that failed: making it run, or using it once it should have been running. */
export const ComputerStep = Schema.Literals(['Start', 'Use'])
export type ComputerStep = typeof ComputerStep.Type

/**
 * Every way a Person's work did not happen, said once, where it is decided.
 *
 * An Incident is not a failure that reached a boundary. It is an outcome: Vivid owed a Person
 * something and it did not happen. Several of these are successful Effects today (a Run that
 * ends `Unknown`, a push the service rejected, a Computer that did not start) and nothing reports
 * them; the case is recorded where the outcome is decided, before it becomes a returned value.
 * One outcome is one Incident: a `RunFailed` is not recorded again by the layers that carry the
 * Run's ending on, the way `Refusal` is recorded once at the Gate.
 *
 * Every case carries the ids of what it happened to, never a name, a title or any text a Person
 * or a model wrote, and an `IncidentCause`. Nothing in it is free text.
 *
 * - `AdmissionFailed`: a delivery never started a Run. The runtime refused it, or it could not be
 *   told whether the runtime held it and retrying gave up. The cause tells which
 *   (`AdmissionRefused` or `AdmissionUncertain`, then the cell's hops); one case, because to the
 *   Person both are the same: what they sent was not answered.
 * - `RunFailed`: an admitted Run ended `Failed`. `reason` is the product's category; the cause's
 *   last hop is the model's or the cell's.
 * - `RunLost`: an admitted Run ended `Unknown`: observation gave up and nobody knows how it ended.
 *   The cause is the failure observation gave up on.
 * - `ComputerFailed`: the Person's Computer did not start, or refused to be used.
 * - `IntegrationFailed`: a call through one of the Person's Integrations failed for a reason that
 *   is not the Person's own decision (a refusal by rule or by the Person is a `Refusal`).
 * - `WatchFailed`: a Watch stopped being able to wake Vivid (renewal or its callback failed).
 * - `PushUndelivered`: the push service rejected a notice for one of the Person's phones, or its
 *   answer could not be told. The Person being present, or signed out on that phone, is routine.
 * - `NotificationUndelivered`: a notification's delivery exhausted its attempts.
 * - `ClientFailed`: a client handled a failure the Person saw. It carries no Person: a sign-in can
 *   fail before there is one, and a client's Person is joined through the trace. Its cause's
 *   first hop names the client (`phone`, `web`, `desktop`).
 */
export const Incident = Schema.TaggedUnion({
  AdmissionFailed: {
    personId: PersonId,
    threadId: ThreadId,
    runId: RunId,
    delivery: DeliveryKind,
    cause: IncidentCause,
  },
  RunFailed: {
    personId: PersonId,
    threadId: ThreadId,
    runId: RunId,
    reason: RunFailure,
    cause: IncidentCause,
  },
  RunLost: {
    personId: PersonId,
    threadId: ThreadId,
    runId: RunId,
    cause: IncidentCause,
  },
  ComputerFailed: {
    personId: PersonId,
    step: ComputerStep,
    cause: IncidentCause,
  },
  IntegrationFailed: {
    personId: PersonId,
    connectionId: ConnectionId,
    cause: IncidentCause,
  },
  WatchFailed: {
    personId: PersonId,
    watchId: WatchId,
    cause: IncidentCause,
  },
  PushUndelivered: {
    personId: PersonId,
    notificationId: NotificationId,
    targetId: PushTargetId,
    cause: IncidentCause,
  },
  NotificationUndelivered: {
    personId: PersonId,
    notificationId: NotificationId,
    cause: IncidentCause,
  },
  ClientFailed: {
    cause: IncidentCause,
  },
})
export type Incident = typeof Incident.Type
