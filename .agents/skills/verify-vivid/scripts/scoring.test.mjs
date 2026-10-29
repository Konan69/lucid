import * as NodeAssert from 'node:assert/strict'
import * as NodeTest from 'node:test'
import * as NodeModule from 'node:module'

const require = NodeModule.createRequire(
  new URL('../../../../apps/server/package.json', import.meta.url),
)
await import(require.resolve('tsx/esm/api')).then((module) => module.register())
const { score } = await import('./scoring.mjs')

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
    const message = {
      id: 'sent-one',
      to: ['invented@example.test'],
      cc: [],
      subject: 'Dinner',
      body: 'Meet Mallory on 2031-12-19 at 09:35 for NGN99,400',
    }
    const page = {
      messages: [
        {
          role: 'user',
          parts: [{ type: 'text', text: 'Show Ada on 2026-11-02 at 10:00. Then send a reply.' }],
        },
        {
          role: 'assistant',
          id: 'assistant-one',
          submissionId: 'turn-one',
          parts: [
            {
              type: 'text',
              text: '```openui-lang\nroot = Col([Text("Ada on 2026-11-02 at 10:00")])\n```',
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
              text: '```openui-lang\nroot = Col([Text("Mallory on 2032-12-19 at 09:36 for NGN99,500")])\n```',
            },
          ],
        },
      ],
    }
    const result = score(
      page,
      [{ turn: 1, characters: 50, seconds: 1 }],
      { mail: [message], calendar: [], readBack: [{ id: message.id, pass: true }] },
      checks,
    )
    NodeAssert.equal(result.display.pass, true)
    NodeAssert.equal(result.display.count, 2)
    NodeAssert.ok(!result.provenance.unsupported.some((item) => item.value === 'Ada'))
    for (const value of ['invented@example.test', 'Mallory', '2031-12-19', '09:35', 'NGN99,400'])
      NodeAssert.ok(
        result.provenance.unsupported.some(
          (item) => item.location === 'mail/sent-one' && item.value === value,
        ),
        'Missing unsupported write value ' + value,
      )
    NodeAssert.ok(result.provenance.unsupported.some((item) => item.value === '2032-12-19'))
    NodeAssert.equal(result.effects.readBack[0].pass, true)
  },
)
