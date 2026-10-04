import { describe, expect, it } from '@effect/vitest'
import {
  ApprovalId,
  BrowseOutcome,
  CommandOutcome,
  DesktopOutcome,
  ServiceId,
  ToolOutcome,
} from '@vivid/contracts'
import { Effect } from 'effect'
import { browseOutcome, commandOutcome, desktopOutcome, toolOutcome } from './outcomes.ts'

const approval = { approvalId: ApprovalId.make('approval-1'), summary: 'Send the draft.' }

describe('outcome mapping', () => {
  it('distinguishes a refused page from missing computer permission and ended work', () => {
    expect(browseOutcome(BrowseOutcome.cases.AddressRefused.make({})).output).toEqual({
      ok: false,
      message:
        'That page or address cannot be opened on the Person’s computer. Use a public web address.',
    })
    expect(browseOutcome(BrowseOutcome.cases.NotAllowed.make({})).output).toEqual({
      ok: false,
      message:
        'The Person has not allowed access to their computer. Ask them to allow it in the desktop app.',
    })
    expect(browseOutcome(BrowseOutcome.cases.RunRequired.make({}))).toEqual({
      output: {
        ok: false,
        message:
          'Nothing was sent, because the work that asked for it has ended. Ask the Person before trying again.',
      },
      terminate: true,
    })
  })

  it.effect('uncertain Computer dispatch refuses blind retries for all three tools', () =>
    Effect.sync(() => {
      const outcomes = [
        commandOutcome(CommandOutcome.cases.OutcomeUnknown.make({})),
        browseOutcome(BrowseOutcome.cases.OutcomeUnknown.make({})),
        desktopOutcome(DesktopOutcome.cases.OutcomeUnknown.make({})),
      ]
      for (const result of outcomes) {
        expect(result.output).toEqual({
          ok: false,
          message:
            'The action may or may not have happened; do not retry without asking the person.',
        })
      }
    }),
  )

  it.effect(
    'ends the turn for every approval-bearing capability with a client-renderable card',
    () =>
      Effect.sync(() => {
        const results = [
          toolOutcome(ToolOutcome.cases.ApprovalRequired.make(approval)),
          commandOutcome(CommandOutcome.cases.ApprovalRequired.make(approval)),
          browseOutcome(BrowseOutcome.cases.ApprovalRequired.make(approval)),
        ]
        for (const result of results) {
          expect(result.terminate).toBe(true)
          expect(result.output).toEqual({
            kind: 'approval-request',
            ...approval,
            message: 'Stop and wait; the person has been asked to approve this action.',
          })
        }
      }),
  )

  it.effect('preserves completed data and Computer truncation and exit status', () =>
    Effect.sync(() => {
      const output = { subject: 'The signed agreement', messages: [{ text: 'Attached.' }] }
      expect(toolOutcome(ToolOutcome.cases.Completed.make({ output }))).toEqual({
        output: { ok: true, output, message: 'The action completed.' },
      })
      const command = { exitCode: 7, output: 'Permission denied.', truncated: true }
      expect(commandOutcome(CommandOutcome.cases.Completed.make({ result: command }))).toEqual({
        output: {
          ok: true,
          result: command,
          message: 'The command completed; check its exit code.',
        },
      })
      const page = {
        address: 'https://example.test',
        title: 'Agreement',
        outline: 'Signed',
        truncated: false,
        tabs: [{ title: 'Agreement', address: 'https://example.test', showing: true }],
      }
      expect(browseOutcome(BrowseOutcome.cases.Completed.make({ result: page }))).toEqual({
        output: {
          ok: true,
          result: page,
          message: 'The browser action completed.',
        },
      })
    }),
  )

  it.effect('quotes authoritative rules and never proposes retrying a forbidden action', () =>
    Effect.sync(() => {
      const rule = 'Never send a payment.'
      for (const result of [
        toolOutcome(ToolOutcome.cases.Blocked.make({ rule })),
        commandOutcome(CommandOutcome.cases.Blocked.make({ rule })),
        browseOutcome(BrowseOutcome.cases.Blocked.make({ rule })),
      ]) {
        expect(result.output).toEqual({
          ok: false,
          rule,
          message: `A rule forbids this action: “${rule}”.`,
        })
        expect(result.terminate).toBeUndefined()
      }
    }),
  )

  it.effect('distinguishes reconnection, rejection and an unknown external side effect', () =>
    Effect.sync(() => {
      expect(
        toolOutcome(
          ToolOutcome.cases.ConnectionNotReady.make({
            service: ServiceId.make('mail'),
            serviceName: 'Mail',
          }),
        ).output,
      ).toEqual({
        ok: false,
        serviceName: 'Mail',
        message: 'Mail needs connecting; offer it to the person with connect.',
      })
      expect(
        toolOutcome(ToolOutcome.cases.Rejected.make({ message: 'Recipient is invalid' })).output,
      ).toEqual({
        ok: false,
        message: 'The service rejected the action: Recipient is invalid.',
        problems: [],
      })
      expect(toolOutcome(ToolOutcome.cases.OutcomeUnknown.make({})).output).toEqual({
        ok: false,
        message: 'The action may or may not have happened; do not retry without asking the person.',
      })
    }),
  )

  it.effect('explains a Person holding the Computer without suggesting a bypass', () =>
    Effect.sync(() => {
      const reason = 'The person holds the keyboard'
      for (const result of [
        commandOutcome(CommandOutcome.cases.Unavailable.make({ reason })),
        browseOutcome(BrowseOutcome.cases.Unavailable.make({ reason })),
      ]) {
        expect(result.output).toEqual({
          ok: false,
          reason,
          message: `The Computer is unavailable: ${reason}.`,
        })
      }
    }),
  )
})
