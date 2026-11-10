import { Schema } from 'effect'
import { IntegrationRequestId } from './asks.js'
import { AuditEntryId, PersonSummary, ThreadId } from './identity.js'

/** The authority that allowed a call, also retained when Vivid answers its Integration. */
export const GateBasis = Schema.Literals([
  'Reviewed',
  'AllowRule',
  'PersonApproved',
  'PersonPress',
  'Read',
  'Unreviewed',
  'Contained',
])
export type GateBasis = typeof GateBasis.Type

/**
 * What happened, as a closed set. The record answers four questions a year later: who asked, what
 * Vivid did, what it touched, and what changed. It holds the access, never a Message or a
 * credential.
 */
export const AuditEvent = Schema.TaggedUnion({
  // An action is recorded by where it happened and what kind of thing it was: the account, the
  // tool, the effect. Vivid's own sentence about it is deliberately absent: it paraphrases the
  // Thread it came from, and an admin reading this record does not read Members' Threads.
  ActionAllowed: {
    service: Schema.String,
    tool: Schema.String,
    effect: Schema.String,
    /** Present only on Vivid's answer to the Integration's own saved approval request. */
    integrationApproval: Schema.optionalKey(
      Schema.Struct({ requestId: IntegrationRequestId, basis: GateBasis }),
    ),
  },
  ActionApproved: { service: Schema.String, tool: Schema.String },
  ActionDenied: { service: Schema.String, tool: Schema.String },
  ActionFailed: { service: Schema.String, tool: Schema.String },
  ActionBlocked: { service: Schema.String, tool: Schema.String, rule: Schema.String },
  ActionOutcomeUnknown: { service: Schema.String, tool: Schema.String },
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
  at: Schema.Finite,
  /** The Person who acted, or on whose behalf Vivid did. */
  actor: PersonSummary,
  /** Whether the Person did it themselves or Vivid did it for them. */
  by: Schema.Literals(['person', 'vivid'] as const),
  threadId: Schema.NullOr(ThreadId),
  event: AuditEvent,
}).annotate({ identifier: 'AuditEntry', title: 'Audit entry' })
export interface AuditEntry extends Schema.Schema.Type<typeof AuditEntry> {}

export const AuditListResponse = Schema.Struct({ entries: Schema.Array(AuditEntry) })
