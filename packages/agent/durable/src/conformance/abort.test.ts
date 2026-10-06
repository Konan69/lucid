import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from 'vitest'

import { abort, attachRun, CallNotWaiting, decide, streamRun, waiting } from '../main.ts'
import { call, consume, context, host, shop, signal, texts } from './fixtures/host.ts'

/** A real partial receipt arms cancellation; no clock wait is used to guess provider progress. */
it('aborts producing text, emits abort, and retains the committed partial', async () => {
  const fixture = await host({}, {}, {}, { tokensPerSecond: 60 })
  const opened = await fixture.open()
  const full = 'word '.repeat(3000)
  opened.faux.setResponses([fauxAssistantMessage(full)])
  const stream = await streamRun(
    opened.harness,
    {
      conversationId: opened.root.id,
      content: 'Write',
      requestId: 'partial',
    },
    context,
  )
  const [observed, folded] = stream.tee()
  const started = signal()
  const chunks = consume(folded)
  const watching = (async () => {
    const types: string[] = []
    for await (const chunk of observed) {
      types.push(chunk.type)
      if (chunk.type === 'text-delta') started.resolve()
    }
    return types
  })()
  await started.promise
  await abort(opened.harness, opened.root.id, context)
  const result = await chunks
  expect(await watching).toContain('abort')
  const partial = texts(result.message).join('')
  expect(partial.length).toBeGreaterThan(0)
  expect(partial.length).toBeLessThan(full.length)
  expect(await attachRun(opened.harness, opened.root.id, context)).toEqual({ status: 'idle' })
  const entries = await opened.root.entries({}, 100, undefined, context)
  const assistant = entries.items.find((entry) => entry.kind === 'pi.assistant')
  if (assistant === undefined || assistant.model === undefined)
    throw new Error('Expected an aborted entry')
  expect(assistant.model[0]).toMatchObject({
    stopReason: 'aborted',
    content: [{ type: 'text', text: partial }],
  })
})

/** Interrupting a beforeTool Deferred settles abort without executing or leaving an answerable hold. */
it('aborts a parked approval and rejects a late decision', async () => {
  const fixture = await shop()
  const opened = await fixture.open()
  opened.faux.setResponses([call('pay', { amount: 100 }, 'held')])
  await consume(
    await streamRun(
      opened.harness,
      {
        conversationId: opened.root.id,
        content: 'Pay',
        requestId: 'held',
      },
      context,
    ),
  )
  expect(await waiting(opened.harness, opened.root.id, context)).toHaveLength(1)
  await abort(opened.harness, opened.root.id, context)
  expect(await waiting(opened.harness, opened.root.id, context)).toEqual([])
  await expect(
    decide(opened.harness, opened.root.id, { callId: 'held', approved: true }, context),
  ).rejects.toBeInstanceOf(CallNotWaiting)
  expect(await attachRun(opened.harness, opened.root.id, context)).toEqual({ status: 'idle' })
  expect(fixture.paid).toEqual([])
})

/** Queued follow-ups are withdrawn by the same durable abort, without creating another user entry. */
it('withdraws a queued follow-up when aborting a held run', async () => {
  const fixture = await shop()
  const opened = await fixture.open()
  opened.faux.setResponses([
    call('pay', { amount: 100 }, 'held'),
    fauxAssistantMessage('Never run.'),
  ])
  await consume(
    await streamRun(
      opened.harness,
      {
        conversationId: opened.root.id,
        content: 'Pay',
        requestId: 'held',
      },
      context,
    ),
  )
  const follow = await opened.root.submit(
    {
      type: 'input',
      content: 'Follow up',
      requestId: 'follow',
      whenBusy: 'followUp',
    },
    context,
  )
  expect((await follow.status(context)).status).toBe('queued')
  await abort(opened.harness, opened.root.id, context)
  expect(await follow.status(context)).toMatchObject({ status: 'unanswered', reason: 'aborted' })
  expect(await waiting(opened.harness, opened.root.id, context)).toEqual([])
  expect(await attachRun(opened.harness, opened.root.id, context)).toEqual({ status: 'idle' })
  const entries = await opened.root.entries({}, 100, undefined, context)
  expect(entries.items.filter((entry) => entry.kind === 'pi.user')).toHaveLength(1)
  expect(fixture.paid).toEqual([])
})
