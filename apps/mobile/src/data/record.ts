import { AuditEvent } from '@vivid/contracts'

/**
 * The words of the record of what was done: one sentence for each kind of event. They are the
 * web's, ported word for word from `apps/web/src/screen/settings/Record.tsx` (`auditSentence`),
 * and kept apart from the sheet that draws them (`screen/settings/Record.tsx`) so the sentences
 * can be tested without a phone.
 */

/**
 * One line of the record as a sentence. It says what happened, never what the content was: the
 * record names actions and services, not the words of a Thread, an email or a file. The match is
 * exhaustive, so an event added to the contract does not compile until it has a sentence here.
 */
export const auditSentence = (event: AuditEvent): string =>
  AuditEvent.match(event, {
    ActionAllowed: ({ service, tool }) => `Used ${tool} on ${service}, allowed by a rule`,
    ActionApproved: ({ service, tool }) => `Used ${tool} on ${service}, after being allowed`,
    ActionDenied: ({ service, tool }) => `Was not allowed to use ${tool} on ${service}`,
    ActionFailed: ({ service, tool }) => `Tried ${tool} on ${service}; it did not work`,
    ActionBlocked: ({ service, tool, rule }) =>
      `Blocked from ${tool} on ${service} by the rule “${rule}”`,
    ActionOutcomeUnknown: ({ service, tool }) =>
      `Used ${tool} on ${service}; it may or may not have happened`,
    ConnectionAdded: ({ service, shared }) =>
      shared ? `Connected ${service} for the company` : `Connected ${service}`,
    ConnectionRemoved: ({ service, shared }) =>
      shared ? `Removed the company’s ${service} integration` : `Removed ${service}`,
    MemberInvited: ({ email, role }) => `Invited ${email} as ${role}`,
    MemberJoined: ({ name, role }) => `${name} joined as ${role}`,
    MemberRemoved: ({ name }) => `${name} left the company`,
    RoleChanged: ({ name, role }) => `${name} became ${role}`,
    RuleAdded: ({ action, decision }) => `Rule added: ${decision.toLowerCase()} “${action}”`,
    RuleRemoved: ({ action }) => `Rule removed: “${action}”`,
    ThreadShared: ({ title, audience }) => `Shared “${title}” with ${audience}`,
    MemorySaved: ({ scope }) => `Vivid kept something (${scope})`,
    MemoryForgotten: ({ scope }) => `Vivid forgot something (${scope})`,
  })
