import * as Schema from 'effect/Schema'
import { PersonId, RunId, ThreadId } from './identity.js'
import { IncidentCause } from './incidents.js'
import { RunFailure } from './runs.js'
import { ThreadOrigin } from './threads.js'
import { MemoryEntry } from './memory.js'
import { MessageHit } from './search.js'

/**
 * The HTTP surface of the conversation runtime (Pi Durable), which only the application server
 * calls. Every
 * route but `/health` carries the runtime token as a bearer credential and names the Person whose
 * conversations are meant and the Thread:
 *
 * - `GET /contract` answers `RuntimeContract`, the fingerprint the cells were built with.
 * - `POST /persons/:personId/threads/:threadId` admits one delivery (`RuntimeAdmissionBody`) and
 *   answers 202 with `RuntimeAdmissionReceipt`. The request carries the sender's
 *   `ContractFingerprint` in `CONTRACT_HEADER`.
 * - `POST /persons/:personId/threads/:threadId/abort` stops the Thread's work: `RuntimeStopped`.
 * - `GET /persons/:personId/threads/:threadId/submissions/:submissionId` answers
 *   `RuntimeSettlement` once the submission settles. Cancelling the request ends only the wait.
 * - `GET /persons/:personId/threads/:threadId/state` answers the Thread's `ConversationState`
 *   as JSON. Asked with `accept: text/event-stream` it is the state link instead: Server-Sent
 *   Events, each event's `data` one `ConversationFrame` as JSON (`Whole` first, then `Changes`),
 *   with a comment line every 15 seconds while nothing changes, until the caller goes away.
 * - `GET /persons/:personId/threads/:threadId/attachments/:attachmentId` answers the bytes of
 *   one picture a Person sent, under its own media type. The id is the last segment of the
 *   `url` a `file` part of the state carries (`attachments/<id>`, relative to the Thread).
 * - `GET /persons/:personId/threads/:threadId/children/:runId` answers `RuntimeChildAnswer`:
 *   whether one helper's work is still running, or how it ended, with its answer and usage.
 * - `POST /persons/:personId/threads/:threadId/children/:runId/abort` aborts one helper's work
 *   and answers `RuntimeStopped` once it has ended.
 * - `POST /persons/:personId/threads/:threadId/children/:runId/messages` hands one helper its
 *   next round (`RuntimeChildMessage`) and answers `RuntimeChildMessaged` once that round began.
 *
 * The Person is the Thread's creator. The runtime keeps each Person's conversations in a
 * directory of their own, named by this id, so the id is also a file name and its alphabet is
 * closed here: a value that could leave the directory never reaches the file system.
 */
export const RuntimePersonId = PersonId.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u),
)

/** The path of every Thread route. */
export const RuntimeThreadPath = Schema.Struct({
  personId: RuntimePersonId,
  threadId: ThreadId.check(Schema.isNonEmpty()),
})
export interface RuntimeThreadPath extends Schema.Schema.Type<typeof RuntimeThreadPath> {}

/** The path of a picture read. */
export const RuntimeAttachmentPath = Schema.Struct({
  ...RuntimeThreadPath.fields,
  attachmentId: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
})
export interface RuntimeAttachmentPath extends Schema.Schema.Type<typeof RuntimeAttachmentPath> {}

/** The path of one helper's routes. */
export const RuntimeChildPath = Schema.Struct({
  ...RuntimeThreadPath.fields,
  runId: RunId.check(Schema.isNonEmpty()),
})
export interface RuntimeChildPath extends Schema.Schema.Type<typeof RuntimeChildPath> {}

/**
 * The runtime's own name for one admitted delivery: the conversation library's submission
 * number, unique within one Person's conversations. The same idempotency key always finds the
 * same one, after a retry and after a restart.
 */
export const RuntimeSubmissionId = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand('RuntimeSubmissionId'),
)
export type RuntimeSubmissionId = typeof RuntimeSubmissionId.Type

/** The path of the settlement read. */
export const RuntimeSubmissionPath = Schema.Struct({
  ...RuntimeThreadPath.fields,
  submissionId: Schema.FiniteFromString.pipe(Schema.decodeTo(RuntimeSubmissionId)),
})
export interface RuntimeSubmissionPath extends Schema.Schema.Type<typeof RuntimeSubmissionPath> {}

/**
 * The runtime holds the delivery durably. `repeated` says the key was already admitted when this
 * request arrived; two first attempts sent at the same moment are one delivery and may both say
 * false.
 */
export const RuntimeAdmissionReceipt = Schema.Struct({
  submissionId: RuntimeSubmissionId,
  repeated: Schema.Boolean,
})
export interface RuntimeAdmissionReceipt extends Schema.Schema.Type<
  typeof RuntimeAdmissionReceipt
> {}

/** Whether a stop found work to stop. */
export const RuntimeStopped = Schema.Struct({ aborted: Schema.Boolean })
export interface RuntimeStopped extends Schema.Schema.Type<typeof RuntimeStopped> {}

/**
 * The committed terminal state of one submission, enough for the server to settle its Run.
 *
 * - `Done`: answered. `answeredBy` is the submission whose response answered it: itself, or the
 *   one whose response it joined, so several Runs that end together claim one answer once.
 *   `reply` is the words of the final answer, and `toolCalls` counts the tools the response
 *   used, so an answer with no words after real work is told from no answer at all.
 * - `Failed`: it can no longer be answered. `failure` is the product's own category and `status`
 *   the provider's HTTP status when it gave one. `cause` is the cell's chain for it, outermost
 *   first (Pi's reason, then the model's hop when the model failed), which the server's `RunFailed`
 *   records: the cell opens no issue of its own for it, so one outcome is one Incident. The
 *   provider's words never leave the runtime: they can quote a request, a path or a key.
 * - `Stopped`: it was stopped, or withdrawn before it was placed.
 */
export const RuntimeSettlement = Schema.TaggedUnion({
  Done: {
    answeredBy: RuntimeSubmissionId,
    reply: Schema.String,
    toolCalls: Schema.Int,
  },
  Failed: {
    failure: RunFailure,
    status: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 400, maximum: 599 }))),
    cause: IncidentCause,
  },
  Stopped: {},
})
export type RuntimeSettlement = typeof RuntimeSettlement.Type

/**
 * A hash of the wire schemas the server and a cell must share to admit work (`fingerprint.ts`
 * computes it). Equal fingerprints mean both were built from the same schemas; it is not secret.
 */
export const ContractFingerprint = Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}$/u)).pipe(
  Schema.brand('ContractFingerprint'),
)
export type ContractFingerprint = typeof ContractFingerprint.Type

/** The header an admission carries its sender's `ContractFingerprint` in. */
export const CONTRACT_HEADER = 'vivid-contract'

/** The answer of the cells' `GET /contract`: the fingerprint the published Worker was built with. */
export const RuntimeContract = Schema.Struct({ contract: ContractFingerprint })
export interface RuntimeContract extends Schema.Schema.Type<typeof RuntimeContract> {}

/**
 * Why the runtime did not do what a request asked. `error` is what the caller acts on; `cause` is
 * why, as an `IncidentCause` whose first hop is the cell's own (`service: 'cell'`, the route's
 * operation, the failure's tag and the status it answered with). It holds no free text, so it
 * may cross where a raw cause may not: a schema issue or a storage error can quote the request it
 * failed on, and an `IncidentCause` keeps only field names, issue kinds and code names.
 *
 * - `InvalidRequest` from a `SchemaError`: the cause's `issues` name each field that did not
 *   decode and how. From an `HttpServerError`: its reason's tag (`RequestParseError`).
 * - `WrongThread`: `issues` name the field whose check failed, with kind `InvalidValue`:
 *   `threadId` (the body names another Thread than the route), `initialData.creator` (the body's
 *   creator is not the route's Person), or `personId` (the route's Person is not this cell's).
 * - `Unavailable`: the Pi or storage failure's tag, and under it what that failure carried.
 * - `ContractMismatch`: an admission body did not decode and the sender's contract fingerprint is
 *   not this cell's (`contractFingerprint` in `fingerprint.ts`); `issues` are the decode's. The
 *   two sides were built from different wire schemas, so no retry of this body can succeed.
 *
 * `contract` is the answering cell's own fingerprint, on every refusal, so a refusal read by a
 * server of another build says which build answered it.
 *
 * The receiver puts the chain after its own hop (the keep-cause rule on `IncidentCause`).
 *
 * Required, not optional: cells deploy in the server's pre-deploy step (`infra/railway.ts`,
 * `apps/cells/scripts/build.mjs deploy`), so a new cell answers before the new server reads it,
 * and the server before it ignores a key it does not know.
 */
export const RuntimeRefusal = Schema.Struct({
  error: Schema.Literals([
    'Unauthorized',
    'InvalidRequest',
    'WrongThread',
    'UnknownThread',
    'UnknownSubmission',
    'NotFound',
    'Unavailable',
    'ContractMismatch',
  ]),
  cause: IncidentCause,
  contract: ContractFingerprint,
})
export interface RuntimeRefusal extends Schema.Schema.Type<typeof RuntimeRefusal> {}

/** Historical Pi drafts use the model message shape supported by the source reader. */
const HistoryText = Schema.Struct({
  type: Schema.Literal('text'),
  text: Schema.String,
  textSignature: Schema.optionalKey(Schema.String),
})
const HistoryImage = Schema.Struct({
  type: Schema.Literal('image'),
  data: Schema.String,
  mimeType: Schema.String,
})
const HistoryUsage = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
  totalTokens: Schema.Finite,
  cacheWrite1h: Schema.optionalKey(Schema.Finite),
  reasoning: Schema.optionalKey(Schema.Finite),
  cost: Schema.Struct({
    input: Schema.Finite,
    output: Schema.Finite,
    cacheRead: Schema.Finite,
    cacheWrite: Schema.Finite,
    total: Schema.Finite,
  }),
})
const HistoryMessage = Schema.Union([
  Schema.Struct({
    role: Schema.Literal('user'),
    timestamp: Schema.Finite,
    content: Schema.Union([
      Schema.String,
      Schema.Array(Schema.Union([HistoryText, HistoryImage])).pipe(Schema.mutable),
    ]),
  }),
  Schema.Struct({
    role: Schema.Literal('assistant'),
    timestamp: Schema.Finite,
    content: Schema.Array(
      Schema.Union([
        HistoryText,
        Schema.Struct({
          type: Schema.Literal('thinking'),
          thinking: Schema.String,
          thinkingSignature: Schema.optionalKey(Schema.String),
          redacted: Schema.optionalKey(Schema.Boolean),
        }),
        Schema.Struct({
          type: Schema.Literal('toolCall'),
          id: Schema.String,
          name: Schema.String,
          arguments: Schema.Record(Schema.String, Schema.Json),
          thoughtSignature: Schema.optionalKey(Schema.String),
        }),
      ]),
    ).pipe(Schema.mutable),
    api: Schema.String,
    provider: Schema.String,
    model: Schema.String,
    usage: HistoryUsage,
    stopReason: Schema.Literals([
      'pending',
      'stop',
      'length',
      'toolUse',
      'error',
      'aborted',
      'deferred',
    ]),
    errorMessage: Schema.optionalKey(Schema.String),
    responseModel: Schema.optionalKey(Schema.String),
    responseId: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    role: Schema.Literal('toolResult'),
    timestamp: Schema.Finite,
    toolCallId: Schema.String,
    toolName: Schema.String,
    isError: Schema.Boolean,
    content: Schema.Array(Schema.Union([HistoryText, HistoryImage])).pipe(Schema.mutable),
    details: Schema.optionalKey(Schema.Json),
    durationMs: Schema.optionalKey(Schema.Finite),
  }),
])
const RuntimeHistoryDraft = Schema.Struct({
  kind: Schema.NonEmptyString,
  model: Schema.optionalKey(Schema.Array(HistoryMessage)),
  data: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
})

/** A failed input keeps a product category when one was recorded independently of model text. */
export const RuntimeHistoryInput = Schema.Union([
  Schema.Struct({ outcome: Schema.tag('completed'), requestId: Schema.NonEmptyString }),
  Schema.Struct({ outcome: Schema.tag('aborted'), requestId: Schema.NonEmptyString }),
  Schema.Struct({
    outcome: Schema.tag('failed'),
    requestId: Schema.NonEmptyString,
    failure: Schema.NullOr(RunFailure),
  }),
]).pipe(Schema.toTaggedUnion('outcome'))
export type RuntimeHistoryInput = typeof RuntimeHistoryInput.Type

/** References name earlier deliveries, never guessed native submission or entry numbers. */
export const RuntimeHistoryEntry = Schema.TaggedUnion({
  Entry: { draft: RuntimeHistoryDraft },
  Delivery: { draft: RuntimeHistoryDraft, requestId: Schema.NonEmptyString },
  Run: { inputs: Schema.Array(Schema.NonEmptyString) },
  Response: {
    draft: RuntimeHistoryDraft,
    inputs: Schema.Array(RuntimeHistoryInput),
  },
})
export type RuntimeHistoryEntry = typeof RuntimeHistoryEntry.Type
export const RuntimeHistoryThread = Schema.Struct({
  threadId: ThreadId,
  origin: ThreadOrigin,
  entries: Schema.Array(RuntimeHistoryEntry),
})
export type RuntimeHistoryThread = typeof RuntimeHistoryThread.Type
export const RuntimeHistoryBody = Schema.Struct({
  threads: Schema.Array(RuntimeHistoryThread),
  // The entry's address check remains valid when only its source timestamp is added. Carried-over
  // entries predate scope, so the body has none and the cell files them as Personal.
  memory: Schema.Array(
    MemoryEntry.mapFields(
      ({ scope: _scope, ...fields }) => ({ ...fields, updatedAt: Schema.Finite }),
      {
        unsafePreserveChecks: true,
      },
    ),
  ),
})
export type RuntimeHistoryBody = typeof RuntimeHistoryBody.Type

/** Failed Threads remain explicit while successful Threads retain their stable receipt map. */
export const RuntimeHistoryResult = Schema.TaggedUnion({
  Loaded: {
    threadId: ThreadId,
    deliveries: Schema.Array(
      Schema.Struct({ requestId: Schema.NonEmptyString, submissionId: RuntimeSubmissionId }),
    ),
  },
  Refused: {
    threadId: ThreadId,
    reason: Schema.Literals([
      'ExistingConversation',
      'ChangedHistory',
      'InvalidHistory',
      'Unavailable',
    ]),
  },
})
export const RuntimeHistoryAnswer = Schema.Struct({ threads: Schema.Array(RuntimeHistoryResult) })
export type RuntimeHistoryAnswer = typeof RuntimeHistoryAnswer.Type
/** The durable map is also the input to the server's receipt adoption command. */
export const RuntimeHistoryMap = Schema.Array(
  Schema.Struct({ personId: RuntimePersonId, ...RuntimeHistoryResult.cases.Loaded.fields }),
)
export type RuntimeHistoryMap = typeof RuntimeHistoryMap.Type

/**
 * `POST /persons/:personId/search`: find words in the Person's own conversations. The server
 * names the Threads to look in, which are the ones it lets the Person see and that live in this
 * Person's store (they created them), so deleted and foreign Threads are never read. Matching
 * follows Muse's chat search (`muse/docs/client-surfaces.md:133`): case-insensitive whole words,
 * the last word also as a prefix, newest first.
 */
export const RuntimeSearchBody = Schema.Struct({
  query: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
  threadIds: Schema.Array(ThreadId).check(Schema.isMaxLength(500)),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
})
export interface RuntimeSearchBody extends Schema.Schema.Type<typeof RuntimeSearchBody> {}

/** The matching messages, newest first, at most the asked limit. */
export const RuntimeSearchAnswer = Schema.Struct({ hits: Schema.Array(MessageHit) })
export interface RuntimeSearchAnswer extends Schema.Schema.Type<typeof RuntimeSearchAnswer> {}
