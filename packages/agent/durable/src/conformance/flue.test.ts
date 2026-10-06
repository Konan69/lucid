import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { tool } from 'ai'
import { expect, it } from 'vitest'
import { z } from 'zod'

import { continueRun, decide, streamRun } from '../main.ts'
import { hold, call, consume, context, host, shop, texts } from './fixtures/host.ts'

// Flue packages/runtime/src/test-utils/define-conversation-stream-store-contract-tests.ts:
// appends one ordered canonical batch when the producer is current.
// Adapt canonical record ordering to public UI chunks; this package exposes no Flue batch offsets.
it('preserves call input then output then model continuation order', async () => {
  const fixture = await host(
    {
      report: tool({
        description: 'Build a report',
        inputSchema: z.object({}),
        execute: async () => '12 pages',
      }),
    },
    {},
  )
  const opened = await fixture.open()
  opened.faux.setResponses([call('report', {}, 'report'), fauxAssistantMessage('Ready.')])
  const result = await consume(
    await streamRun(
      opened.harness,
      { conversationId: opened.root.id, content: 'Build', requestId: 'build' },
      context,
    ),
  )
  const order = result.chunks.flatMap((chunk) => {
    if (chunk.type === 'tool-input-available') return [`input:${chunk.toolCallId}`]
    if (chunk.type === 'tool-output-available') return [`output:${chunk.toolCallId}`]
    if (chunk.type === 'text-delta') return [chunk.delta]
    return []
  })
  expect(order).toEqual(['input:report', 'output:report', 'Ready.'])
  expect(result.message.parts.find((part) => part.type === 'tool-report')).toMatchObject({
    state: 'output-available',
    output: '12 pages',
  })
  expect(texts(result.message)).toEqual(['Ready.'])
})

// Flue packages/runtime/src/test-utils/define-conversation-stream-store-contract-tests.ts:
// replays strictly after a batch offset.
// Adapt the replay boundary to known tool calls, the cursor continueRun actually exposes.
// Producer fencing, numeric offsets, atomic batches, reserved settlements and fold checkpoints
// belong to Flue's store contracts and have no corresponding public seam here.
it('replays only the suffix after known calls once the run has completed', async () => {
  const fixture = await shop()
  const opened = await fixture.open()
  opened.faux.setResponses([call('pay', { amount: 500 }, 'pay'), fauxAssistantMessage('Paid.')])
  const prefix = await consume(
    await streamRun(
      opened.harness,
      { conversationId: opened.root.id, content: 'Pay', requestId: 'pay' },
      context,
    ),
  )
  await decide(
    opened.harness,
    opened.root.id,
    { holdId: await hold(opened.harness, opened.root.id, 'pay'), approved: true },
    context,
  )
  await opened.root.waitForIdle(context)
  const stream = await continueRun(opened.harness, opened.root.id, new Set(['pay']), context)
  if (stream === undefined) throw new Error('Expected the completed suffix')
  const suffix = await consume(stream, prefix.message)
  expect(
    suffix.chunks.filter(
      (chunk) =>
        chunk.type === 'tool-input-start' ||
        chunk.type === 'tool-input-available' ||
        chunk.type === 'tool-approval-request',
    ),
  ).toEqual([])
  expect(suffix.chunks.filter((chunk) => chunk.type === 'tool-output-available')).toEqual([
    { type: 'tool-output-available', toolCallId: 'pay', output: { receipt: 500 } },
  ])
  expect(suffix.chunks.at(-1)).toMatchObject({ type: 'finish' })
  expect(suffix.message.id).toBe(prefix.message.id)
  expect(suffix.message.parts.filter((part) => part.type === 'tool-pay')).toHaveLength(1)
  expect(texts(suffix.message)).toEqual(['Paid.'])
  expect(fixture.paid).toEqual([500])
})
