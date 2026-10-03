import * as Schema from 'effect/Schema'

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
/** Invitation identifier: one pending offer of a Membership. */
export const InvitationId = identifier('InvitationId')
export type InvitationId = typeof InvitationId.Type
/** Project identifier used by project contracts. */
export const ProjectId = identifier('ProjectId')
export type ProjectId = typeof ProjectId.Type
/** Durable Thread identifier used by collaboration and Flue transport routes. */
export const ThreadId = identifier('ThreadId')
/** Decoded Thread identifier. */
export type ThreadId = typeof ThreadId.Type
/** Run identifier. It is Flue's submission id, so a Message can be joined to the Run that carried it. */
export const RunId = identifier('RunId')
export type RunId = typeof RunId.Type
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
/** Input request identifier: one question a Run could not answer alone. */
export const InputRequestId = identifier('InputRequestId')
export type InputRequestId = typeof InputRequestId.Type
/** Approval identifier: authorization for one consequential action. */
export const ApprovalId = identifier('ApprovalId')
export type ApprovalId = typeof ApprovalId.Type
/** Rule identifier: one standing instruction about what Vivid may do without asking. */
export const RuleId = identifier('RuleId')
export type RuleId = typeof RuleId.Type
/** A service Vivid can be connected to, as named by the Connection catalog. */
export const ServiceId = identifier('ServiceId')
export type ServiceId = typeof ServiceId.Type
/** Connection identifier: one authorized relationship with an external account. */
export const ConnectionId = identifier('ConnectionId')
export type ConnectionId = typeof ConnectionId.Type
/** Memory record identifier. */
export const MemoryId = identifier('MemoryId')
export type MemoryId = typeof MemoryId.Type
/** Skill identifier: one saved procedure. */
export const SkillId = identifier('SkillId')
export type SkillId = typeof SkillId.Type
/** Audit entry identifier. */
export const AuditEntryId = identifier('AuditEntryId')
export type AuditEntryId = typeof AuditEntryId.Type
/** Artifact identifier: one durable thing made in a Thread. */
export const ArtifactId = identifier('ArtifactId')
export type ArtifactId = typeof ArtifactId.Type
/** Computer identifier: one Person's machine. */
export const ComputerId = identifier('ComputerId')
export type ComputerId = typeof ComputerId.Type

export class Person extends Schema.Class<Person>('Person')(
  {
    id: PersonId,
    name: Schema.String,
    email: Schema.String,
    image: Schema.optional(Schema.NullOr(Schema.String)),
  },
  { title: 'Person' },
) {}

/**
 * The part of a Person another Person may see: enough to show a face and a name beside a Message
 * or on a shared Thread. An email address is not part of it.
 */
export const PersonSummary = Schema.Struct({
  id: PersonId,
  name: Schema.String,
  image: Schema.NullOr(Schema.String),
}).annotate({ identifier: 'PersonSummary', title: 'Person summary' })
export interface PersonSummary extends Schema.Schema.Type<typeof PersonSummary> {}

export class Session extends Schema.Class<Session>('Session')(
  {
    id: SessionId,
    personId: PersonId,
    activeCompanyId: Schema.optional(CompanyId),
    expiresAt: Schema.DateTimeUtc,
  },
  { title: 'Session' },
) {}
