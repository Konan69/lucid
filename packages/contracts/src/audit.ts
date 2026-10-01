import { Schema } from 'effect'
import { AuditEntryId, PersonSummary, ThreadId } from './identity.js'

/**
 * What happened, as a closed set. The record answers four questions a year later: who asked, what
 * Vivid did, what it touched, and what changed. It holds the access, never a Message or a
 * credential.
 */
export const AuditEvent = Schema.TaggedUnion({
  ActionAllowed: { summary: Schema.String, service: Schema.String, effect: Schema.String },
  ActionApproved: { summary: Schema.String, service: Schema.String },
  ActionDenied: { summary: Schema.String, service: Schema.String },
  ActionBlocked: { summary: Schema.String, service: Schema.String, rule: Schema.String },
  ActionOutcomeUnknown: { summary: Schema.String, service: Schema.String },
  ConnectionAdded: { service: Schema.String, shared: Schema.Boolean },
  ConnectionRemoved: { service: Schema.String, shared: Schema.Boolean },
  MemberInvited: { email: Schema.String, role: Schema.String },
  MemberJoined: { name: Schema.String, role: Schema.String },
  MemberRemoved: { name: Schema.String },
  RoleChanged: { name: Schema.String, role: Schema.String },
  RuleAdded: { action: Schema.String, decision: Schema.String },
  RuleRemoved: { action: Schema.String },
  ThreadShared: { title: Schema.String, audience: Schema.String },
  MemorySaved: { scope: Schema.String },
  MemoryForgotten: { scope: Schema.String },
})
export type AuditEvent = typeof AuditEvent.Type

export const AuditEntry = Schema.Struct({
  id: AuditEntryId,
  at: Schema.Number,
  /** The Person who acted, or on whose behalf Vivid did. */
  actor: PersonSummary,
  /** Whether the Person did it themselves or Vivid did it for them. */
  by: Schema.Literals(['person', 'vivid'] as const),
  threadId: Schema.NullOr(ThreadId),
  event: AuditEvent,
}).annotate({ identifier: 'AuditEntry', title: 'Audit entry' })
export interface AuditEntry extends Schema.Schema.Type<typeof AuditEntry> {}

export const AuditListResponse = Schema.Struct({ entries: Schema.Array(AuditEntry) })
