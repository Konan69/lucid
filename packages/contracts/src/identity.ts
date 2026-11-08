import * as Schema from 'effect/Schema'

// Each identifier brands a string with its own literal name. Effect 4.0.2's `Schema.brand` takes one
// literal key (`EnsureSingleBrandKey`), so the brand is written at each identifier, not through a
// generic helper.

/** Person identifier used by identity and attribution contracts. */
export const PersonId = Schema.String.pipe(Schema.brand('PersonId'))
export type PersonId = typeof PersonId.Type
/** Session identifier used by authentication contracts. */
export const SessionId = Schema.String.pipe(Schema.brand('SessionId'))
export type SessionId = typeof SessionId.Type
/** Company identifier used by tenancy contracts. */
export const CompanyId = Schema.String.pipe(Schema.brand('CompanyId'))
export type CompanyId = typeof CompanyId.Type
/** Membership identifier used by tenancy contracts. */
export const MembershipId = Schema.String.pipe(Schema.brand('MembershipId'))
export type MembershipId = typeof MembershipId.Type
/** Invitation identifier: one pending offer of a Membership. */
export const InvitationId = Schema.String.pipe(Schema.brand('InvitationId'))
export type InvitationId = typeof InvitationId.Type
/** Project identifier used by project contracts. */
export const ProjectId = Schema.String.pipe(Schema.brand('ProjectId'))
export type ProjectId = typeof ProjectId.Type

/** One thing a Person is owed and Vivid chases (`owed.ts`). */
export const OwedId = Schema.String.pipe(Schema.brand('OwedId'))
export type OwedId = typeof OwedId.Type

/** One thing on a Person's own to-do list (`todos.ts`). */
export const TodoId = Schema.String.pipe(Schema.brand('TodoId'))
export type TodoId = typeof TodoId.Type
/** Durable Thread identifier used by collaboration and conversation routes. */
export const ThreadId = Schema.String.pipe(Schema.brand('ThreadId'))
/** Decoded Thread identifier. */
export type ThreadId = typeof ThreadId.Type
/**
 * One message of a Thread's conversation, as the runtime names it in `ConversationMessage.id`:
 * `entry-<n>` for a Person's words (the Pi transcript entry that holds them) and `run-<n>` for
 * Vivid's reply (the entry its run started at). Pi transcript entries are append-only and never
 * renumbered, compaction included (pi-durable 1.4.0 `entries.d.ts`, `CompactionEntry` adds a
 * summary entry), so either name points at the same message for as long as the Thread lives
 * (`packages/agent/runtime/src/state/project.ts` `personMessage`, `replyMessage`).
 */
export const MessageId = Schema.String.check(Schema.isPattern(/^(entry|run)-[1-9][0-9]*$/u)).pipe(
  Schema.brand('MessageId'),
)
export type MessageId = typeof MessageId.Type
/** Product Run identifier. The admission receipt links it to a runtime submission. */
export const RunId = Schema.String.pipe(Schema.brand('RunId'))
export type RunId = typeof RunId.Type
/** Durable notification identifier. */
export const NotificationId = Schema.String.pipe(Schema.brand('NotificationId'))
/** Decoded notification identifier. */
export type NotificationId = typeof NotificationId.Type
/** Durable Library item identifier. */
export const LibraryItemId = Schema.String.pipe(Schema.brand('LibraryItemId'))
/** Decoded Library item identifier. */
export type LibraryItemId = typeof LibraryItemId.Type
/** Durable Library folder identifier. */
export const LibraryFolderId = Schema.String.pipe(Schema.brand('LibraryFolderId'))
/** Decoded Library folder identifier. */
export type LibraryFolderId = typeof LibraryFolderId.Type
/** Input request identifier: one question a Run could not answer alone. */
export const InputRequestId = Schema.String.pipe(Schema.brand('InputRequestId'))
export type InputRequestId = typeof InputRequestId.Type
/** Handoff identifier: one step on the Computer that only the Person asked can do. */
export const HandoffId = Schema.String.pipe(Schema.brand('HandoffId'))
export type HandoffId = typeof HandoffId.Type
/** One prepared field of a handoff, named by the server so a value never travels with a label. */
export const HandoffFieldId = Schema.String.pipe(Schema.brand('HandoffFieldId'))
export type HandoffFieldId = typeof HandoffFieldId.Type
/** Approval identifier: authorization for one consequential action. */
export const ApprovalId = Schema.String.pipe(Schema.brand('ApprovalId'))
export type ApprovalId = typeof ApprovalId.Type
/**
 * One outward operation Vivid sent, or is about to send, to a service or a Computer. The server
 * makes it from the runtime's own call identity or the Approval it carries out, never from model
 * text, so a retried call names the same operation.
 */
export const ActionOperationId = Schema.String.pipe(Schema.brand('ActionOperationId'))
export type ActionOperationId = typeof ActionOperationId.Type
/** Rule identifier: one standing instruction about what Vivid may do without asking. */
export const RuleId = Schema.String.pipe(Schema.brand('RuleId'))
export type RuleId = typeof RuleId.Type
/** A service Vivid can be connected to, as named by the Connection catalog. */
export const ServiceId = Schema.String.pipe(Schema.brand('ServiceId'))
export type ServiceId = typeof ServiceId.Type
/** Connection identifier: one authorized relationship with an external account. */
export const ConnectionId = Schema.String.pipe(Schema.brand('ConnectionId'))
export type ConnectionId = typeof ConnectionId.Type
/** Skill identifier: one saved procedure. */
export const SkillId = Schema.String.pipe(Schema.brand('SkillId'))
export type SkillId = typeof SkillId.Type
/** Audit entry identifier. */
export const AuditEntryId = Schema.String.pipe(Schema.brand('AuditEntryId'))
export type AuditEntryId = typeof AuditEntryId.Type
/** Artifact identifier: one durable thing made in a Thread. */
export const ArtifactId = Schema.String.pipe(Schema.brand('ArtifactId'))
export type ArtifactId = typeof ArtifactId.Type
/** Computer identifier: one Person's machine. */
export const ComputerId = Schema.String.pipe(Schema.brand('ComputerId'))
export type ComputerId = typeof ComputerId.Type

/** The longest name a Person can give themselves in Settings. */
export const PERSON_NAME_MAX = 64

/**
 * What a Person asks to be called, as they set it in Settings: 1 to 64 characters, with no space
 * at either end, on one line and without a backslash. It is drawn in headers and said to the model
 * as plain text, so a line break or an escape has no honest meaning in it (`VividName` holds the
 * same rule for Vivid's own name). A client trims what was typed before it sends; the server
 * refuses rather than repairs.
 *
 * `Person.name` stays a plain string: it also holds the name a sign-in provider gave, which no
 * one checked against this rule, and refusing to read such a Person would lock them out.
 */
export const PersonName = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isBetweenLength(1, PERSON_NAME_MAX),
  Schema.isPattern(/^[^\\\r\n]*$/u),
)
export type PersonName = typeof PersonName.Type

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
