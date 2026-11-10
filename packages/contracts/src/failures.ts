import { ErrorReporter, Schema } from 'effect'
import { InvitationId, PersonId, RunId } from './identity.js'
import { IncidentCause } from './incidents.js'

export class Unauthenticated extends Schema.TaggedError<Unauthenticated>()(
  'Unauthenticated',
  {
    message: Schema.String,
  },
  { title: 'Unauthenticated' },
) {}

export class Forbidden extends Schema.TaggedError<Forbidden>()(
  'Forbidden',
  {
    message: Schema.String,
  },
  { title: 'Forbidden' },
) {}

export class NotFound extends Schema.TaggedError<NotFound>()(
  'NotFound',
  {
    message: Schema.String,
  },
  { title: 'Not found' },
) {}

export class Conflict extends Schema.TaggedError<Conflict>()(
  'Conflict',
  {
    message: Schema.String,
  },
  { title: 'Conflict' },
) {}

/**
 * The Person holds the address an invitation was sent to but has not shown that its mailbox is
 * theirs, so the invitation stays open and no Membership is made. It is a tag of its own because
 * the Person can act on it (prove the mailbox), which a `Forbidden` invitation for another address
 * never allows. Both ids are the caller's own: the Person who asked and the invitation they named.
 */
export class MailboxUnconfirmed extends Schema.TaggedError<MailboxUnconfirmed>()(
  'MailboxUnconfirmed',
  {
    personId: PersonId,
    invitationId: InvitationId,
    message: Schema.String,
  },
  { title: 'Mailbox unconfirmed' },
) {}

/** Infrastructure failures exposed without leaking driver-specific errors. */
export class DatabaseUnavailable extends Schema.TaggedError<DatabaseUnavailable>()(
  'DatabaseUnavailable',
  {
    message: Schema.String,
  },
  { title: 'Database unavailable' },
) {}

export class DatabaseConstraintViolation extends Schema.TaggedError<DatabaseConstraintViolation>()(
  'DatabaseConstraintViolation',
  {
    message: Schema.String,
  },
  { title: 'Database constraint violation' },
) {}

export class DatabaseFailure extends Schema.TaggedError<DatabaseFailure>()(
  'DatabaseFailure',
  {
    message: Schema.String,
  },
  { title: 'Database failure' },
) {}

export class InvalidRequest extends Schema.TaggedError<InvalidRequest>()(
  'InvalidRequest',
  { message: Schema.String },
  { title: 'Invalid request' },
) {}

/**
 * The conversation runtime could not be reached, or could not answer, so whether the work
 * happened is not known and asking again later may succeed. It is never a refusal renamed: a
 * runtime that answered "no" is `DeliveryRefused`. `cause` is why, outermost hop first.
 */
export class RuntimeUnavailable extends Schema.TaggedError<RuntimeUnavailable>()(
  'RuntimeUnavailable',
  { message: Schema.String, cause: IncidentCause },
  { title: 'Runtime unavailable' },
) {}

/**
 * The conversation runtime answered and refused this delivery, so the Run `runId` never started
 * and the same delivery sent again is refused again. `cause` names the server's hop and then the
 * cell's (a field that did not decode, a contract mismatch), so a client that reports it, and
 * the Incident recorded for it, say why without the request's words.
 */
export class DeliveryRefused extends Schema.TaggedError<DeliveryRefused>()(
  'DeliveryRefused',
  { runId: RunId, cause: IncidentCause },
  { title: 'Delivery refused' },
) {
  /**
   * The outcome is already said: the server raises this only after `Conversation.admissionFailed`
   * recorded `AdmissionFailed` for the same Run, with this cause. A boundary reporter that also
   * captured it would open a second, differently grouped issue for one failed send.
   */
  readonly [ErrorReporter.ignore] = true
}

/**
 * A part of the installation the request needs is not reachable: the Connection layer, the memory
 * store or the Computer provider. The rest of Vivid keeps working; the caller says which part.
 */
export class ServiceUnavailable extends Schema.TaggedError<ServiceUnavailable>()(
  'ServiceUnavailable',
  {
    service: Schema.Literals(['connections', 'memory', 'computer'] as const),
    message: Schema.String,
  },
  { title: 'Service unavailable' },
) {}

/** Existing runtime error envelope retained on the HTTP wire. */
export const RuntimeErrorResponse = Schema.Struct({ error: Schema.String })
