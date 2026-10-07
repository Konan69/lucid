import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from 'vitest'
import { tool } from 'ai'
import { z } from 'zod'
import { abort, continueRun, respond, streamRun, RunMissing } from '../main.ts'
import { call, consume, context, host } from './fixtures/host.ts'

/** Each turn has another generation task; a closed run still owns calls of all its turns. */
it('locates each known-call subset in a second-turn abort without borrowing the next run', async () => {
  const fixture = await host(
    {
      work: tool({ inputSchema: z.object({}), execute: async () => 'worked' }),
      pay: tool({ inputSchema: z.object({}), execute: async () => 'paid' }),
    },
    { approval: { pay: true } },
  )
  const opened = await fixture.open()
  opened.faux.setResponses([
    call('work', {}, 'a'),
    call('pay', {}, 'b'),
    fauxAssistantMessage('Next'),
  ])
  const first = await consume(
    await streamRun(
      opened.harness,
      { conversationId: opened.root.id, content: 'First', requestId: 'first' },
      context,
    ),
  )
  await abort(opened.harness, opened.root.id, context)
  await consume(
    await streamRun(
      opened.harness,
      { conversationId: opened.root.id, content: 'Next', requestId: 'next' },
      context,
    ),
  )
  for (const known of [['a'], ['b'], ['a', 'b']]) {
    const stream = await continueRun(
      opened.harness,
      opened.root.id,
      { messageId: first.message.id, known: new Set(known) },
      context,
    )
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    expect(chunks.at(-1)).toEqual({ type: 'finish' })
    const response = await respond(
      opened.harness,
      opened.root.id,
      new Request('http://durable.test/chat', {
        method: 'POST',
        body: JSON.stringify({
          messages: [
            {
              id: first.message.id,
              role: 'assistant',
              parts: known.map((toolCallId) => ({ type: 'tool-pay', toolCallId })),
            },
          ],
        }),
      }),
      context,
    )
    expect(response.status).toBe(200)
    await response.text()
  }
  await expect(
    continueRun(
      opened.harness,
      opened.root.id,
      { messageId: first.message.id, known: new Set(['not-made']) },
      context,
    ),
  ).rejects.toBeInstanceOf(RunMissing)
})
