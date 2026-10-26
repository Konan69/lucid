import * as Schema from 'effect/Schema'
import { PersonId, ThreadId } from './identity.js'
import { RunFailure } from './threads.js'

/**
 * The HTTP surface of the Pi Durable runtime, the second of the two conversation runtimes while
 * Threads move off Flue (Flue's surface is `RuntimeAdmissionBody` and its neighbours in
 * `threads.ts`). Only the application server calls it. Every
 * route but `/health` carries the runtime token as a bearer credential and names the Person whose
 * conversations are meant and the Thread:
 *
 * - `POST /persons/:personId/threads/:threadId` admits one delivery (`RuntimeAdmissionBody`) and
 *   answers 202 with `RuntimeAdmissionReceipt`.
 * - `POST /persons/:personId/threads/:threadId/abort` stops the Thread's work: `RuntimeStopped`.
 * - `GET /persons/:personId/threads/:threadId/submissions/:submissionId` answers
 *   `RuntimeSettlement`; with `?wait=1` it holds the request until the submission settles.
 * - `GET /persons/:personId/threads/:threadId/state` answers the Thread's `ConversationState`
 *   as JSON. Asked with `accept: text/event-stream` it is the state link instead: Server-Sent
 *   Events, each event's `data` one `ConversationFrame` as JSON (`Whole` first, then `Changes`),
 *   with a comment line every 15 seconds while nothing changes, until the caller goes away.
 * - `GET /persons/:personId/threads/:threadId/attachments/:attachmentId` answers the bytes of
 *   one picture a Person sent, under its own media type. The id is the last segment of the
 *   `url` a `file` part of the state carries (`attachments/<id>`, relative to the Thread).
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

/** The search of the settlement read: any `wait` value asks the runtime to hold the request. */
export const RuntimeSettlementSearch = Schema.Struct({
  wait: Schema.optionalKey(Schema.String),
})

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
 * The committed state of one submission, enough for the server to settle its Run.
 *
 * - `Pending`: admitted and not answered yet, waiting its turn or being answered.
 * - `Done`: answered. `answeredBy` is the submission whose response answered it: itself, or the
 *   one whose response it joined, so several Runs that end together claim one answer once.
 *   `reply` is the words of the final answer, and `toolCalls` counts the tools the response
 *   used, so an answer with no words after real work is told from no answer at all.
 * - `Failed`: it can no longer be answered. `failure` is the product's own category and `status`
 *   the provider's HTTP status when it gave one. The provider's words never leave the runtime:
 *   they can quote a request, a path or a key.
 * - `Stopped`: it was stopped, or withdrawn before it was placed.
 */
export const RuntimeSettlement = Schema.TaggedUnion({
  Pending: {},
  Done: {
    answeredBy: RuntimeSubmissionId,
    reply: Schema.String,
    toolCalls: Schema.Int,
  },
  Failed: {
    failure: RunFailure,
    status: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 400, maximum: 599 }))),
  },
  Stopped: {},
})
export type RuntimeSettlement = typeof RuntimeSettlement.Type

/** Why the runtime did not do what a request asked; only the tag crosses, never a cause. */
export const RuntimeRefusal = Schema.Struct({
  error: Schema.Literals([
    'Unauthorized',
    'InvalidRequest',
    'WrongThread',
    'UnknownThread',
    'UnknownSubmission',
    'NotFound',
    'Unavailable',
  ]),
})
export interface RuntimeRefusal extends Schema.Schema.Type<typeof RuntimeRefusal> {}
