import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from 'vitest'

import { history, streamRun } from '../main.ts'
import { consume, context, host, texts } from './fixtures/host.ts'

// Flue packages/runtime/src/test-utils/define-conversation-stream-store-contract-tests.ts:233.
// Adapt the large canonical user record to the bridge's public ingress/history, not a fake Flue store.
// Ports packages/ai-chat/src/tests/get-messages-endpoint.test.ts:67 — GET /get-messages endpoint > streams a transcript with offloaded payloads as the same JSON array.
it('round-trips a batch larger than a backend cell-size cap', async () => {
  const fixture = await host({}, {})
  const opened = await fixture.open()
  opened.faux.setResponses([fauxAssistantMessage('Stored.')])
  const content = 'x'.repeat(2_500_000)
  await consume(
    await streamRun(
      opened.harness,
      { conversationId: opened.root.id, content, requestId: 'large' },
      context,
    ),
  )
  await fixture.close(opened.harness)
  const restarted = await fixture.open()
  const saved = await history(restarted.harness, restarted.root.id, { limit: 10 }, context)
  expect(saved.messages.map(texts)).toEqual([[content], ['Stored.']])
})

// Flue packages/runtime/src/test-utils/define-conversation-stream-store-contract-tests.ts:159/272.
// Pi dedupes even conflicting request ids; this assertion ports exact retry idempotency only.
// Ports packages/runtime/src/test-utils/define-conversation-stream-store-contract-tests.ts:159 — returns the original offset for an exact producer retry.
it('returns the original identity for an exact oversized retry', async () => {
  const fixture = await host({}, {})
  const opened = await fixture.open()
  opened.faux.setResponses([fauxAssistantMessage('Stored once.')])
  const content = 'x'.repeat(2_500_000)
  await consume(
    await streamRun(
      opened.harness,
      { conversationId: opened.root.id, content, requestId: 'large' },
      context,
    ),
  )
  const first = await opened.root.submit({ type: 'input', content, requestId: 'large' }, context)
  const second = await opened.root.submit({ type: 'input', content, requestId: 'large' }, context)
  expect(first.id).toBe(second.id)
  expect(await second.status(context)).toMatchObject({ status: 'done' })
  expect(opened.faux.state.callCount).toBe(1)
  expect(
    (await history(opened.harness, opened.root.id, { limit: 10 }, context)).messages.map(texts),
  ).toEqual([[content], ['Stored once.']])
})

// Flue packages/runtime/src/test-utils/define-conversation-stream-store-contract-tests.ts:201/292.
// Gap: Pi treats a reused request id as identical even when content differs; Flue rejects conflicts.
// Ports packages/runtime/src/test-utils/define-conversation-stream-store-contract-tests.ts:201 — rejects conflicting producer retries without advancing the stream.
it.fails.each([1, 2_500_000])(
  'rejects conflicting retries of %i bytes without advancing history',
  async (bytes) => {
    const fixture = await host({}, {})
    const opened = await fixture.open()
    const content = 'x'.repeat(bytes)
    opened.faux.setResponses([fauxAssistantMessage('Stored once.')])
    await consume(
      await streamRun(
        opened.harness,
        { conversationId: opened.root.id, content, requestId: 'conflict' },
        context,
      ),
    )
    const before = await history(opened.harness, opened.root.id, { limit: 10 }, context)
    const retried = await Promise.allSettled([
      opened.root.submit(
        { type: 'input', content: content.slice(0, -1) + 'y', requestId: 'conflict' },
        context,
      ),
    ])
    expect(await history(opened.harness, opened.root.id, { limit: 10 }, context)).toEqual(before)
    expect(opened.faux.state.callCount).toBe(1)
    expect(retried).toMatchObject([{ status: 'rejected' }])
  },
)
