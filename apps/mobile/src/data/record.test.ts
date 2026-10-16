import { AuditEvent } from '@vivid/contracts'
import { describe, expect, it } from 'vitest'
import { auditSentence } from './record.ts'

describe('a line of the record', () => {
  it('names the rule that stopped Vivid, with the tool and the service it stopped', () => {
    expect(
      auditSentence(
        AuditEvent.cases.ActionBlocked.make({
          service: 'Gmail',
          tool: 'send_email',
          rule: 'Send email to people outside my company',
        }),
      ),
    ).toBe('Blocked from send_email on Gmail by the rule “Send email to people outside my company”')
  })

  it('says whose an Integration is when it is added or removed', () => {
    const added = (shared: boolean) =>
      auditSentence(AuditEvent.cases.ConnectionAdded.make({ service: 'Slack', shared }))
    const removed = (shared: boolean) =>
      auditSentence(AuditEvent.cases.ConnectionRemoved.make({ service: 'Slack', shared }))
    expect(added(true)).toBe('Connected Slack for the company')
    expect(added(false)).toBe('Connected Slack')
    expect(removed(true)).toBe('Removed the company’s Slack integration')
    expect(removed(false)).toBe('Removed Slack')
  })

  it('writes a new rule’s decision as a word in the sentence', () => {
    expect(
      auditSentence(
        AuditEvent.cases.RuleAdded.make({ action: 'Delete a shared file', decision: 'Never' }),
      ),
    ).toBe('Rule added: never “Delete a shared file”')
  })
})
