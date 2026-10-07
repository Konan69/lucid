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
// Changed content is refused with TurnConflict at the Promise entry and HTTP 409 at the SDK ingress.
// Ports packages/runtime/src/test-utils/define-conversation-stream-store-contract-tests.ts:201 — rejects conflicting producer retries without advancing the stream.
// Ports packages/runtime/src/test-utils/define-conversation-stream-store-contract-tests.ts:292 — rejects a conflicting oversized retry without advancing the stream.
it.each([1, 2_500_000])(
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
    const changed = content.slice(0, -1) + 'y'
    const http = await Promise.allSettled([
      opened.transport.sendMessages({
        chatId: 'conflict',
        trigger: 'submit-message',
        messageId: 'conflict',
        abortSignal: undefined,
        messages: [{ id: 'conflict', role: 'user', parts: [{ type: 'text', text: changed }] }],
      }),
    ])
    // Detach any unexpected successful response before asserting the typed refusal.
    for (const attempt of http) if (attempt.status === 'fulfilled') await attempt.value.cancel()
    const retried = await Promise.allSettled([
      streamRun(
        opened.harness,
        { conversationId: opened.root.id, content: changed, requestId: 'conflict' },
        context,
      ),
    ])
    for (const attempt of retried) if (attempt.status === 'fulfilled') await attempt.value.cancel()
    expect(await history(opened.harness, opened.root.id, { limit: 10 }, context)).toEqual(before)
    expect(opened.faux.state.callCount).toBe(1)
    expect(http).toMatchObject([
      { status: 'rejected', reason: { name: 'AI_APICallError', statusCode: 409 } },
    ])
    expect(retried).toMatchObject([
      { status: 'rejected', reason: { _tag: expect.stringMatching(/conflict/iu) } },
    ])
  },
)
