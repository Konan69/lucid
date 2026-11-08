import * as NodeAssert from 'node:assert/strict'
import * as NodeTest from 'node:test'
import * as NodeModule from 'node:module'

const require = NodeModule.createRequire(
  new URL('../../../../apps/server/package.json', import.meta.url),
)
await import(require.resolve('tsx/esm/api')).then((module) => module.register())
const { score } = await import('./scoring.mjs')
const { provenanceContext } = await import('./provenance.mjs')

/** The real OpenUI parser must distinguish grounded values from an injected display and write. */
NodeTest.test(
  'history scoring catches invented values without accepting the write receipt as provenance',
  () => {
    const checks = {
      replyIncludes: [],
      replyExcludes: [],
      mailSent: 1,
      calendarCreated: 0,
      choice: false,
      connect: false,
    }
    const context = provenanceContext(
      {
        mail: {
          owner: { timezone: 'Africa/Lagos' },
          threads: [
            {
              messages: [
                {
                  from: 'Ada North <ada@example.test>',
                  to: ['ben@example.test'],
                  cc: ['Ben West <ben@example.test>'],
                },
              ],
            },
          ],
        },
        calendar: {
          timezone: 'Africa/Lagos',
          events: [{ title: 'Ada <> Ben: 1-1', attendees: ['Ben'] }],
        },
      },
      '2026-10-29T12:00:00Z',
    )
    const message = {
      id: 'sent-one',
      to: ['Mallory <invented@example.test>'],
      cc: [],
      subject: 'Dinner',
      body: 'Confirming my attendance on 2031-12-19 at 09:35 for NGN99,400. Call +12025550199 about IN-999999.',
    }
    const page = {
      messages: [
        {
          role: 'user',
          parts: [
            {
              type: 'text',
              text: 'Show Ada on 2026-11-02 at 10:00. NGN86,000.00, +1 202 555 0142, IN-123456 and SAMPLE-00042. Then send a reply.',
            },
          ],
        },
        {
          role: 'assistant',
          id: 'assistant-one',
          submissionId: 'turn-one',
          parts: [
            {
              type: 'text',
              text: '```openui-lang\nroot = Col([Text("To Ada"), Text("2 November 2026 at 10 am WAT. ₦86000 +12025550142 IN‑123456 sample-00042. Confirming Tell")])\n```',
            },
            {
              type: 'dynamic-tool',
              toolName: 'use_tool',
              toolCallId: 'send-one',
              state: 'output-available',
              output: { sent: message },
            },
            {
              type: 'dynamic-tool',
              toolName: 'use_tool',
              toolCallId: 'read-one',
              state: 'output-available',
              output: { thread: { messages: [message] } },
            },
            {
              type: 'text',
              text: '```openui-lang\nroot = Col([Text("To Rhea"), Text("2032-12-19 at 09:36 for NGN99,500")])\n```',
            },
          ],
        },
      ],
    }
    const result = score(
      page,
      [{ turn: 1, characters: 50, seconds: 1 }],
      { mail: [message], calendar: [], readBack: [{ id: message.id, pass: true }] },
      { checks, context },
    )
    NodeAssert.equal(result.display.pass, true)
    NodeAssert.equal(result.display.count, 2)
    NodeAssert.ok(!result.provenance.unsupported.some((item) => item.value === 'Ada'))
    for (const value of [
      'invented@example.test',
      'Mallory',
      '2031-12-19',
      '09:35',
      'NGN99,400',
      '+12025550199',
      'IN-999999',
    ])
      NodeAssert.ok(
        result.provenance.unsupported.some(
          (item) => item.location === 'mail/sent-one' && item.value === value,
        ),
        'Missing unsupported write value ' + value,
      )
    NodeAssert.ok(result.provenance.unsupported.some((item) => item.value === '2032-12-19'))
    NodeAssert.ok(
      result.provenance.unsupported.some((item) => item.kind === 'name' && item.value === 'Rhea'),
    )
    NodeAssert.ok(
      !result.provenance.unsupported.some((item) =>
        [
          'Ada',
          'Confirming',
          'Tell',
          '₦86000',
          '+12025550142',
          'IN‑123456',
          'sample-00042',
          '2 November 2026',
          '10 am WAT',
        ].includes(item.value),
      ),
    )
    NodeAssert.equal(result.effects.readBack[0].pass, true)
    const emptyEffects = { mail: [], calendar: [], readBack: [] }
    const readsOnly = { ...checks, mailSent: 0 }
    const priorMail = {
      messages: [
        {
          role: 'assistant',
          id: 'read-only',
          submissionId: 'read-turn',
          parts: [
            {
              type: 'text',
              text: 'You sent a reply yesterday. It was scheduled before this conversation.',
            },
          ],
        },
      ],
    }
    NodeAssert.equal(
      score(priorMail, [], emptyEffects, { checks: readsOnly, context }).effects.pass,
      true,
    )
    const claimed = {
      messages: [
        {
          role: 'assistant',
          id: 'claim',
          submissionId: 'claim-turn',
          parts: [{ type: 'text', text: 'I sent your reply.' }],
        },
      ],
    }
    NodeAssert.equal(
      score(claimed, [], emptyEffects, { checks: readsOnly, context }).effects.pass,
      false,
    )
  },
)
