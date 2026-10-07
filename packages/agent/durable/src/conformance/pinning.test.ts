import { Effect, Option } from 'effect'

import { consumeReadable } from '../fixtures/reading.ts'
import { runForPi } from '../pi.ts'
import { expect, it } from '@effect/vitest'

import { isToolUIPart, tool } from 'ai'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { z } from 'zod'
import { PlainChat } from '../fixtures/chat.ts'
import { attachRun, decide, waiting } from '../main.ts'
import { call, context, host } from './fixtures/host.ts'
/** Reconnect must expose the persisted request even when a deployment changes its declaration. */
for (const changed of ['free', 'throws'] as const)
  it.live(`reconnects a pinned approval after the policy becomes ${changed}`, () =>
    Effect.gen(function* () {
      let executions = 0
      let evaluations = 0
      const definition = tool({
        inputSchema: z.object({}),
        needsApproval: true,
        execute: () =>
          runForPi(
            Effect.sync(() => {
              executions++
              return 'paid'
            }),
            undefined,
          ),
      })
      const fixture = yield* host({ pay: definition }, {})
      const opened = yield* fixture.open()
      opened.faux.setResponses([call('pay', {}, 'pay')])
      const chat = new PlainChat({ transport: opened.transport })
      yield* Effect.promise(() => chat.sendMessage({ text: 'Pay' }))
      const rows = yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context))
      const row = rows[0]
      if (row === undefined) throw new Error('Expected held call')
      if (chat.lastMessage === undefined) throw new Error('Expected assistant id')
      yield* fixture.close(opened.harness)
      Object.defineProperty(definition, 'needsApproval', {
        value: () => {
          evaluations++
          if (changed === 'throws') throw new Error('New policy is broken')
          return false
        },
      })
      const reopened = yield* fixture.open()
      const attached = yield* Effect.promise(() =>
        attachRun(reopened.harness, reopened.root.id, context),
      )
      if (attached.status === 'idle') throw new Error('Expected active run')
      const replay = yield* consumeReadable(attached.stream, Option.none())
      expect(replay.message.parts.find(isToolUIPart)).toMatchObject({
        state: 'approval-requested',
        approval: { id: row.holdId },
      })
      expect(evaluations).toBe(0)
      expect(
        yield* Effect.promise(() => waiting(reopened.harness, reopened.root.id, context)),
      ).toEqual(rows)
      reopened.faux.setResponses([fauxAssistantMessage('Paid.')])
      reopened.harness.resume()
      yield* Effect.promise(() =>
        decide(reopened.harness, reopened.root.id, { holdId: row.holdId, approved: true }, context),
      )
      yield* Effect.promise(() => reopened.root.waitForIdle(context))
      expect(executions).toBe(1)
      expect(evaluations).toBe(0)
    }),
  )
