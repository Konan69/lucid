import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from '@effect/vitest'
import { isToolUIPart, lastAssistantMessageIsCompleteWithApprovalResponses, tool } from 'ai'
import { Effect } from 'effect'
import { z } from 'zod'
import { PlainChat } from '../fixtures/chat.ts'
import type { ProviderFamily } from '../fixtures/provider.ts'
import { history } from '../main.ts'
import { context, host, signal } from './fixtures/host.ts'

const cases: readonly {
  readonly family: ProviderFamily
  readonly id: string
  readonly name: string
  readonly executes: boolean
}[] = [
  { family: 'end', id: 'late', name: 'pay', executes: true },
  { family: 'never', id: '', name: 'pay', executes: true },
  { family: 'never', id: 'rejected', name: '', executes: false },
  { family: 'never', id: '', name: '', executes: false },
]

/** Pi startToolRound accepts an offered name with an empty id; absent names get synthetic rejection. */
for (const given of cases)
  it.live(`keeps Chat ready for ${given.family} identity ${given.id}/${given.name}`, () =>
    Effect.promise(async () => {
      const paid: number[] = []
      const fixture = await host(
        {
          pay: tool({
            inputSchema: z.object({ amount: z.number() }),
            execute: async ({ amount }) => {
              paid.push(amount)
              return amount
            },
          }),
        },
        { approval: { pay: true } },
        { progress: { partialIntervalMs: 1 } },
        {
          partialFamily: given.family,
          tokensPerSecond: 1500,
          tokenSize: { min: 1, max: 1 },
        },
      )
      const opened = await fixture.open()
      opened.faux.setResponses([
        fauxAssistantMessage([fauxToolCall(given.name, { amount: 1 }, { id: given.id })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('Done.'),
      ])
      let done = signal()
      const chat = new PlainChat({
        transport: opened.transport,
        sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
        onFinish: () => done.resolve(),
        onError: (error) => done.reject(error),
      })
      await chat.sendMessage({ text: 'Pay' })
      if (chat.lastMessage === undefined) throw new Error('Expected assistant')
      if (given.executes) {
        const part = chat.lastMessage.parts.find(isToolUIPart)
        if (part === undefined || part.state !== 'approval-requested')
          throw new Error('Expected approval')
        expect(part.toolCallId).toBe(given.id)
        expect(part.input).toEqual({ amount: 1 })
        done = signal()
        await chat.addToolApprovalResponse({ id: part.approval.id, approved: true })
        await done.promise
      }
      expect(chat.status).toBe('ready')
      expect(paid).toEqual(given.executes ? [1] : [])
      expect(chat.lastMessage.parts.filter(isToolUIPart)).toHaveLength(given.executes ? 1 : 0)
      const page = await history(opened.harness, opened.root.id, { limit: 10 }, context)
      const assistant = page.messages.find((message) => message.role === 'assistant')
      if (assistant === undefined) throw new Error('Expected history')
      expect(assistant.parts).toEqual(chat.lastMessage.parts)
      const entries = await opened.root.context(context)
      const results = entries.entries
        .flatMap((entry) => entry.model ?? [])
        .filter((message) => message.role === 'toolResult')
      expect(results).toHaveLength(1)
      expect(results[0]).toMatchObject({
        toolCallId: given.id,
        toolName: given.name,
        isError: !given.executes,
      })
    }),
  )
