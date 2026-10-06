import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { watchEvents, type AgentEvent } from '@earendil-works/pi-durable'
import { expect, it } from '@effect/vitest'
import { tool } from 'ai'
import { Effect } from 'effect'
import { onTestFinished } from 'vitest'
import { z } from 'zod'

import { streamRun } from '../main.ts'
import { runForPi } from '../pi.ts'
import { consume, context, host, signal } from './fixtures/host.ts'

/** Pi AI faux.js streams raw JSON fragments, unlike Pi Durable's persisted partial-message watch. */
it.live('receives raw argument JSON from the provider before the durable boundary', () =>
  Effect.promise(async () => {
    const input = { account: 'savings', amount: 100 }
    const faux = fauxProvider({ tokenSize: { min: 1, max: 1 } })
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('pay', input, { id: 'wire' })], {
        stopReason: 'toolUse',
      }),
    ])
    const models = createModels()
    models.setProvider(faux.provider)
    const stream = models.streamSimple(faux.getModel(), { messages: [] })
    const deltas: string[] = []
    for await (const event of stream) if (event.type === 'toolcall_delta') deltas.push(event.delta)
    expect(deltas.length).toBeGreaterThan(1)
    expect(deltas.join('')).toBe(JSON.stringify(input))
    expect((await stream.result()).content).toEqual([
      { type: 'toolCall', id: 'wire', name: 'pay', arguments: input },
    ])
  }),
)

/**
 * generation.js streamResponse persists event.partial only; events.js messageChanges translates
 * parsed-object edits. Drain a real watch through an appended receipt, proving raw provider JSON
 * never reaches this seam without sleeps, polling or a mocked translator. Every bridge chunk is
 * validated and folded by the stock SDK reader through consume.
 */
it.live('reports parsed tool arguments through a real durable watch, without raw JSON deltas', () =>
  Effect.promise(async () => {
    const input = { account: 'savings '.repeat(20), amount: 100 }
    const fixture = await host(
      {
        pay: tool({
          inputSchema: z.object({ account: z.string(), amount: z.number() }),
          execute: async ({ amount }) => amount,
        }),
      },
      { approval: { pay: true } },
      { progress: { partialIntervalMs: 1 } },
      { tokensPerSecond: 1500, tokenSize: { min: 1, max: 1 } },
    )
    const opened = await fixture.open()
    opened.faux.setResponses([
      fauxAssistantMessage(
        [fauxText('Before '.repeat(20)), fauxToolCall('pay', input, { id: 'wire' })],
        { stopReason: 'toolUse' },
      ),
    ])
    const events = await watchEvents(opened.harness, opened.root.id, context)
    onTestFinished(async () => {
      await events.stop()
    })
    const delivered: AgentEvent[] = []
    const receipt = signal()
    events.start((batch) =>
      runForPi(
        Effect.sync(() => {
          delivered.push(...batch)
          if (
            batch.some(
              (event) =>
                event.type === 'entry_appended' && event.entry.kind === 'arguments.receipt',
            )
          )
            receipt.resolve()
        }),
        context.abortSignal,
      ),
    )
    const result = await consume(
      await streamRun(
        opened.harness,
        { conversationId: opened.root.id, content: 'Pay', requestId: 'arguments' },
        context,
      ),
    )
    await opened.root.commit(
      (tx) => tx.appendEntry(opened.root.id, { kind: 'arguments.receipt' }),
      context,
    )
    await receipt.promise
    const changes = delivered.flatMap((event) =>
      event.type === 'message_update' ? event.changes : [],
    )
    expect(changes).toContainEqual({
      type: 'toolcall_start',
      contentIndex: 1,
      block: { type: 'toolCall', id: 'wire', name: 'pay', arguments: {} },
    })
    expect(changes.filter((change) => change.type === 'toolcall_delta')).toEqual([])
    expect(result.chunks.filter((chunk) => chunk.type.startsWith('tool-input-'))).toEqual([
      { type: 'tool-input-start', toolCallId: 'wire', toolName: 'pay' },
      { type: 'tool-input-available', toolCallId: 'wire', toolName: 'pay', input },
    ])
  }),
)
