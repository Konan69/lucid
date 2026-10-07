import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Message } from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { createRegistry } from '@earendil-works/pi-durable'
import { tool } from 'ai'
import { expect, it } from '@effect/vitest'
import { Array as Arr, Effect, Option, Predicate } from 'effect'
import { z } from 'zod'

import { ChatTurn, respond, toolsExtension } from './core.ts'
import { memory } from './fixtures/harness.ts'
import { consume, hold } from './fixtures/reading.ts'

const context = BACKGROUND_CONTEXT

/** A harness with one approval tool and one person-answered tool, behind the HTTP handler. */
const server = Effect.fn('Test.chatServer')(function* (paid: { amount: number }[]) {
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const registry = createRegistry()
  registry.install(
    yield* toolsExtension(
      'shop',
      {
        pay: tool({
          description: 'Pay an invoice',
          inputSchema: z.object({ amount: z.number() }),
          execute: async (input) => {
            paid.push(input)
            return { receipt: `paid ${input.amount}` }
          },
        }),
        ask_person: tool({
          description: 'Ask the person',
          inputSchema: z.object({ question: z.string() }),
        }),
      },
      { approval: { pay: true } },
    ),
  )
  const harness = yield* memory(models, registry)
  const root = yield* Effect.promise(() =>
    harness.root(context, {
      agent: { model: { provider: 'faux', modelId: 'faux-1' } },
    }),
  )
  return { faux, harness, root }
})

const lastText = (messages: readonly Message[]) => {
  const last = Option.getOrThrow(Arr.last(messages))
  return Predicate.isString(last.content)
    ? last.content
    : last.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
}

/** Approval continuation keeps the same assistant message while the durable call runs exactly once. */
it.live('approves a call and continues the same message', () =>
  Effect.gen(function* () {
    const paid: { amount: number }[] = []
    const { faux, harness, root } = yield* server(paid)
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('pay', { amount: 500 }, { id: 'call-pay' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('Paid.'),
    ])
    const initial = yield* respond(
      harness,
      root.id,
      ChatTurn.cases.Input.make({
        messageId: 'pay',
        parts: [{ type: 'text', text: 'Pay the invoice' }],
      }),
      context,
    )
    const before = yield* consume(initial, Option.none())
    expect(before.message.parts.find((part) => part.type === 'tool-pay')).toMatchObject({
      state: 'approval-requested',
    })
    expect(paid).toEqual([])
    const continued = yield* respond(
      harness,
      root.id,
      ChatTurn.cases.Resume.make({
        messageId: before.message.id,
        steps: before.message.parts.filter((part) => part.type === 'step-start').length,
        known: ['call-pay'],
        decisions: [
          {
            callId: 'call-pay',
            holdId: yield* hold(harness, root.id, 'call-pay', context),
            approved: true,
          },
        ],
        outputs: [],
      }),
      context,
    )
    const after = yield* consume(continued, Option.some(before.message))
    expect(paid).toEqual([{ amount: 500 }])
    expect(after.message.id).toBe(before.message.id)
    expect(after.message.parts.find((part) => part.type === 'tool-pay')).toMatchObject({
      state: 'output-available',
      output: { receipt: 'paid 500' },
    })
    expect(after.message.parts.filter((part) => part.type === 'text')).toEqual([
      expect.objectContaining({ text: 'Paid.' }),
    ])
  }),
)

/** A supplied answer reaches the model inside the existing run, instead of creating a user input. */
it.live('answers a tool that has no server execute', () =>
  Effect.gen(function* () {
    const { faux, harness, root } = yield* server([])
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('ask_person', { question: 'Which account?' }, { id: 'call-ask' })],
        { stopReason: 'toolUse' },
      ),
      (request) => fauxAssistantMessage(`Using ${lastText(request.messages)}.`),
    ])
    const initial = yield* respond(
      harness,
      root.id,
      ChatTurn.cases.Input.make({
        messageId: 'ask',
        parts: [{ type: 'text', text: 'Pay the invoice' }],
      }),
      context,
    )
    const before = yield* consume(initial, Option.none())
    expect(before.message.parts.find((part) => part.type === 'tool-ask_person')).toMatchObject({
      state: 'input-available',
      input: { question: 'Which account?' },
    })
    const continued = yield* respond(
      harness,
      root.id,
      ChatTurn.cases.Resume.make({
        messageId: before.message.id,
        steps: before.message.parts.filter((part) => part.type === 'step-start').length,
        known: ['call-ask'],
        decisions: [],
        outputs: [{ callId: 'call-ask', output: 'savings' }],
      }),
      context,
    )
    const after = yield* consume(continued, Option.some(before.message))
    expect(after.message.parts.find((part) => part.type === 'tool-ask_person')).toMatchObject({
      state: 'output-available',
      output: 'savings',
    })
    expect(after.message.parts.filter((part) => part.type === 'text')).toEqual([
      expect.objectContaining({ text: 'Using savings.' }),
    ])
  }),
)
