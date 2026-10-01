import { Schema } from 'effect'

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

export const ApiError = Schema.Union([
  Unauthenticated,
  Forbidden,
  NotFound,
  Conflict,
  DatabaseUnavailable,
  DatabaseConstraintViolation,
  DatabaseFailure,
])
export type ApiError = typeof ApiError.Type

/** Existing runtime error envelope retained on the HTTP wire. */
export const RuntimeErrorResponse = Schema.Struct({ error: Schema.String })
/** Empty successful response used by 204 routes. */
export const EmptyResponse = Schema.Void
