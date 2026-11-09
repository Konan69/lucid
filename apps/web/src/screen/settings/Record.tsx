import { AuditEvent, type AuditEntry } from '@vivid/contracts'
import { live, LiveState, useLive } from '../../data/live'
import { PersonAvatar } from '../../ui/Person'
import { Awaiting, Empty, Section } from './Parts'

const when = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

/** One line of the record as a sentence. It says what happened, never what the content was. */
export const auditSentence = (event: AuditEvent) =>
  AuditEvent.match(event, {
    ActionAllowed: ({ service, tool }) => `Used ${tool} on ${service}, allowed by a rule`,
    ActionApproved: ({ service, tool }) => `Used ${tool} on ${service} after approval`,
    ActionDenied: ({ service, tool }) => `Was not allowed to use ${tool} on ${service}`,
    ActionFailed: ({ service, tool }) => `Tried ${tool} on ${service}, but it didn’t work`,
    ActionBlocked: ({ service, tool, rule }) =>
      `Blocked from ${tool} on ${service} by the rule “${rule}”`,
    ActionOutcomeUnknown: ({ service, tool }) =>
      `Used ${tool} on ${service}, but it’s unclear whether it worked`,
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
    MemorySaved: ({ scope }) => `Vivid saved something (${scope})`,
    MemoryForgotten: ({ scope }) => `Vivid forgot something (${scope})`,
  })

/**
 * The record of what was done, and by whom: every action Vivid took for someone, every
 * integration, rule and membership change. In a Company an admin reads the whole Company's record
 * and a member reads their own. It names actions and services, never the contents of a Thread, an
 * email or a file.
 */
export function Record() {
  const audit = useLive(live.audit)
  if (!LiveState.$is('Ready')(audit)) return <Awaiting state={audit} />
  return (
    <Section title="What happened" detail="Newest first. This record cannot be edited.">
      {audit.value.entries.length === 0 && <Empty>Nothing recorded yet.</Empty>}
      {audit.value.entries.map((entry) => (
        <Line key={entry.id} entry={entry} />
      ))}
    </Section>
  )
}

function Line({ entry }: { entry: AuditEntry }) {
  return (
    <div className="flex min-h-12 items-center gap-3 px-4 py-2">
      <PersonAvatar name={entry.actor.name} image={entry.actor.image} size={22} />
      <div className="min-w-0 flex-1">
        <div className="text-label text-ink">{auditSentence(entry.event)}</div>
        <div className="text-meta font-meta text-ink-3">
          {entry.by === 'vivid' ? `Vivid, for ${entry.actor.name}` : entry.actor.name} ·{' '}
          {when.format(entry.at)}
        </div>
      </div>
    </div>
  )
}
