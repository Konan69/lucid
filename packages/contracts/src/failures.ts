import { Schema } from 'effect'
import { InvitationId, PersonId } from './identity.js'

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

export class RuntimeUnavailable extends Schema.TaggedError<RuntimeUnavailable>()(
  'RuntimeUnavailable',
  { message: Schema.String },
  { title: 'Runtime unavailable' },
) {}

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
