import { describe, expect, it } from '@effect/vitest'
import {
  ApprovalId,
  BrowseOutcome,
  DesktopOutcome,
  ServiceId,
  ToolOutcome,
  WindowOutcome,
  WindowResult,
  AppId,
  WindowId,
} from '@vivid/contracts'
import { Effect } from 'effect'
import { browseOutcome, desktopOutcome, toolOutcome, windowOutcome } from './outcomes.ts'

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

  it.effect('uncertain Computer dispatch refuses blind retries for both tools', () =>
    Effect.sync(() => {
      const outcomes = [
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

  it.effect('preserves completed data', () =>
    Effect.sync(() => {
      const output = { subject: 'The signed agreement', messages: [{ text: 'Attached.' }] }
      expect(toolOutcome(ToolOutcome.cases.Completed.make({ output }))).toEqual({
        output: { ok: true, output, message: 'The action completed.' },
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
      for (const result of [browseOutcome(BrowseOutcome.cases.Unavailable.make({ reason }))]) {
        expect(result.output).toEqual({
          ok: false,
          reason,
          message: `The Computer is unavailable: ${reason}.`,
        })
      }
    }),
  )
})

/** Native receipts give operating-system refusals actionable, fixed model instructions. */
describe('Person window outcomes', () => {
  it('returns app IDs and window IDs with titles in compact text', () => {
    expect(
      windowOutcome(
        WindowOutcome.cases.Completed.make({
          result: WindowResult.cases.Apps.make({
            apps: [{ id: AppId.make('terminal'), name: 'Terminal' }],
            skipped: 0,
          }),
        }),
      ).output,
    ).toMatchObject({ apps: 'terminal: Terminal' })
    expect(
      windowOutcome(
        WindowOutcome.cases.Completed.make({
          result: WindowResult.cases.Windows.make({
            windows: [{ id: WindowId.make('window'), app: 'Terminal', title: 'Project shell' }],
          }),
        }),
      ).output,
    ).toMatchObject({ windows: 'window: Terminal — Project shell' })
  })

  it('explains elevation and recovery from vanished windows or stale looks', () => {
    for (const [reason, message] of [
      [
        'Elevated',
        'Windows does not let Vivid type into an administrator window. Ask the person to do that step.',
      ],
      ['WindowGone', 'The window is gone. List the windows again.'],
      ['LookStale', 'This look is stale. Look at the window again before acting.'],
      [
        'NotInFront',
        'Windows would not bring this window forward. Ask the person to bring it forward.',
      ],
      ['Unsupported', 'This computer cannot do that action. Ask the person to do it.'],
    ] as const) {
      const receipt = windowOutcome(WindowOutcome.cases.Refused.make({ reason }))
      expect(receipt.output).toMatchObject({ ok: false, reason, message })
      expect(receipt.terminate).toBe(false)
    }
  })

  it('keeps missing connection distinct from uncertainty and ends an expired Run', () => {
    expect(windowOutcome(WindowOutcome.cases.NotConnected.make({})).output).toMatchObject({
      message: 'The person’s desktop app is not connected. Ask them to connect it.',
    })
    expect(windowOutcome(WindowOutcome.cases.OutcomeUnknown.make({})).output).toMatchObject({
      message: 'The action may or may not have happened; do not retry without asking the person.',
    })
    expect(windowOutcome(WindowOutcome.cases.RunRequired.make({})).terminate).toBe(true)
    expect(windowOutcome(WindowOutcome.cases.Busy.make({})).output).toMatchObject({ ok: false })
    expect(
      windowOutcome(WindowOutcome.cases.Unavailable.make({ reason: 'The helper stopped.' })).output,
    ).toMatchObject({ ok: false, reason: 'The helper stopped.' })
  })
})
