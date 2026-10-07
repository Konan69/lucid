import { Deferred, Effect } from 'effect'
import { FixtureFailed } from '../fixtures/harness.ts'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from '@effect/vitest'
import { isToolUIPart, lastAssistantMessageIsCompleteWithApprovalResponses, tool } from 'ai'
import { z } from 'zod'
import { PlainChat } from '../fixtures/chat.ts'
import type { ProviderFamily } from '../fixtures/provider.ts'
import { history } from '../main.ts'
import { context, host } from './fixtures/host.ts'
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
    Effect.gen(function* () {
      const paid: number[] = []
      const fixture = yield* host(
        {
          pay: tool({
            inputSchema: z.object({ amount: z.number() }),
            execute: ({ amount }) => {
              paid.push(amount)
              return Promise.resolve(amount)
            },
          }),
        },
        { approval: { pay: true } },
        { progress: { partialIntervalMs: 0 } },
        {
          partialFamily: given.family,
          commitFrames: true,
          tokenSize: { min: 1, max: 1 },
        },
      )
      const opened = yield* fixture.open()
      opened.faux.setResponses([
        fauxAssistantMessage([fauxToolCall(given.name, { amount: 1 }, { id: given.id })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('Done.'),
      ])
      let done = yield* Deferred.make<void, FixtureFailed>()
      const chat = new PlainChat({
        transport: opened.transport,
        sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
        onFinish: () => Deferred.doneUnsafe(done, Effect.void),
        onError: (error) =>
          Deferred.doneUnsafe(done, Effect.fail(new FixtureFailed({ cause: error }))),
      })
      yield* Effect.promise(() => chat.sendMessage({ text: 'Pay' }))
      if (chat.lastMessage === undefined) throw new Error('Expected assistant')
      if (given.executes) {
        const part = chat.lastMessage.parts.find(isToolUIPart)
        if (part === undefined || part.state !== 'approval-requested')
          throw new Error('Expected approval')
        expect(part.toolCallId).toBe(given.id)
        expect(part.input).toEqual({ amount: 1 })
        done = yield* Deferred.make<void, FixtureFailed>()
        yield* Effect.promise(() =>
          Promise.resolve(chat.addToolApprovalResponse({ id: part.approval.id, approved: true })),
        )
        yield* Deferred.await(done)
      }
      expect(chat.status).toBe('ready')
      expect(paid).toEqual(given.executes ? [1] : [])
      expect(chat.lastMessage.parts.filter(isToolUIPart)).toHaveLength(given.executes ? 1 : 0)
      const page = yield* Effect.promise(() =>
        history(opened.harness, opened.root.id, { limit: 10 }, context),
      )
      const assistant = page.messages.find((message) => message.role === 'assistant')
      if (assistant === undefined) throw new Error('Expected history')
      expect(assistant.parts).toEqual(chat.lastMessage.parts)
      const entries = yield* Effect.promise(() => opened.root.context(context))
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
