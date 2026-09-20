import { Schema } from 'effect'

/** Creates a branded identifier schema for one Vivid ownership boundary. */
const identifier = <Name extends string>(name: Name) => Schema.String.pipe(Schema.brand(name))

/** Person identifier used by identity and attribution contracts. */
export const PersonId = identifier('PersonId')
export type PersonId = typeof PersonId.Type
/** Session identifier used by authentication contracts. */
export const SessionId = identifier('SessionId')
export type SessionId = typeof SessionId.Type
/** Company identifier used by tenancy contracts. */
export const CompanyId = identifier('CompanyId')
export type CompanyId = typeof CompanyId.Type
/** Membership identifier used by tenancy contracts. */
export const MembershipId = identifier('MembershipId')
export type MembershipId = typeof MembershipId.Type
/** Project identifier used by project contracts. */
export const ProjectId = identifier('ProjectId')
export type ProjectId = typeof ProjectId.Type
/** Durable Thread identifier used by collaboration and Flue transport routes. */
export const ThreadId = identifier('ThreadId')
/** Decoded Thread identifier. */
export type ThreadId = typeof ThreadId.Type
/** Durable Task identifier. */
export const TaskId = identifier('TaskId')
/** Decoded Task identifier. */
export type TaskId = typeof TaskId.Type
/** Durable follow-up identifier. */
export const FollowUpId = identifier('FollowUpId')
/** Decoded follow-up identifier. */
export type FollowUpId = typeof FollowUpId.Type
/** Durable notification identifier. */
export const NotificationId = identifier('NotificationId')
/** Decoded notification identifier. */
export type NotificationId = typeof NotificationId.Type
/** Durable Routine identifier. */
export const RoutineId = identifier('RoutineId')
/** Decoded Routine identifier. */
export type RoutineId = typeof RoutineId.Type
/** Durable Routine occurrence identifier. */
export const OccurrenceId = identifier('OccurrenceId')
/** Decoded Routine occurrence identifier. */
export type OccurrenceId = typeof OccurrenceId.Type
/** Durable Library item identifier. */
export const LibraryItemId = identifier('LibraryItemId')
/** Decoded Library item identifier. */
export type LibraryItemId = typeof LibraryItemId.Type
/** Durable Library folder identifier. */
export const LibraryFolderId = identifier('LibraryFolderId')
/** Decoded Library folder identifier. */
export type LibraryFolderId = typeof LibraryFolderId.Type

export class Person extends Schema.Class<Person>('Person')(
  {
    id: PersonId,
    name: Schema.String,
    email: Schema.String,
    image: Schema.optional(Schema.NullOr(Schema.String)),
  },
  { title: 'Person' },
) {}

export class Session extends Schema.Class<Session>('Session')(
  {
    id: SessionId,
    personId: PersonId,
    activeCompanyId: Schema.optional(CompanyId),
    expiresAt: Schema.DateTimeUtc,
  },
  { title: 'Session' },
) {}
