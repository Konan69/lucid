import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { isToolUIPart, tool } from 'ai'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { z } from 'zod'
import { PlainChat } from '../fixtures/chat.ts'
import { attachRun, decide, waiting } from '../main.ts'
import { call, consume, context, host } from './fixtures/host.ts'

/** Reconnect must expose the persisted request even when a deployment changes its declaration. */
for (const changed of ['free', 'throws'] as const)
  it.live(`reconnects a pinned approval after the policy becomes ${changed}`, () =>
    Effect.promise(async () => {
      let executions = 0
      let evaluations = 0
      const definition = tool({
        inputSchema: z.object({}),
        needsApproval: true,
        execute: async () => {
          executions++
          return 'paid'
        },
      })
      const fixture = await host({ pay: definition }, {})
      const opened = await fixture.open()
      opened.faux.setResponses([call('pay', {}, 'pay')])
      const chat = new PlainChat({ transport: opened.transport })
      await chat.sendMessage({ text: 'Pay' })
      const rows = await waiting(opened.harness, opened.root.id, context)
      if (rows[0] === undefined) throw new Error('Expected held call')
      const messageId = chat.lastMessage?.id
      if (messageId === undefined) throw new Error('Expected assistant id')
      await fixture.close(opened.harness)
      Object.defineProperty(definition, 'needsApproval', {
        value: () => {
          evaluations++
          if (changed === 'throws') throw new Error('New policy is broken')
          return false
        },
      })
      const reopened = await fixture.open()
      const attached = await attachRun(reopened.harness, reopened.root.id, context)
      if (attached.status === 'idle') throw new Error('Expected active run')
      const replay = await consume(attached.stream)
      expect(replay.message.parts.find(isToolUIPart)).toMatchObject({
        state: 'approval-requested',
        approval: { id: rows[0].holdId },
      })
      expect(evaluations).toBe(0)
      expect(await waiting(reopened.harness, reopened.root.id, context)).toEqual(rows)
      reopened.faux.setResponses([fauxAssistantMessage('Paid.')])
      reopened.harness.resume()
      await decide(
        reopened.harness,
        reopened.root.id,
        { holdId: rows[0].holdId, approved: true },
        context,
      )
      await reopened.root.waitForIdle(context)
      expect(executions).toBe(1)
      expect(evaluations).toBe(0)
    }),
  )
