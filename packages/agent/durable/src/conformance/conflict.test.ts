import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { PlainChat } from '../fixtures/chat.ts'
import { TurnConflict, streamRun, respond, waiting, type InputPart } from '../main.ts'
import { call, consume, context, host, shop, signal } from './fixtures/host.ts'
import { onTestFinished } from 'vitest'

/** Pi's request-id winner is immutable even when a stock Chat edits and retries its own user part. */
for (const state of ['active', 'done'] as const)
  it.live(`refuses different content for the same ${state} input id with HTTP 409`, () =>
    Effect.promise(async () => {
      const opened = await (await shop()).open()
      opened.faux.setResponses([
        state === 'active' ? call('pay', { amount: 1 }, 'held') : fauxAssistantMessage('Once.'),
      ])
      const first = new PlainChat({ transport: opened.transport, generateId: () => 'immutable' })
      await first.sendMessage({ text: 'Original' })
      const held = await waiting(opened.harness, opened.root.id, context)
      const retry = new PlainChat({ transport: opened.transport, generateId: () => 'immutable' })
      await retry.sendMessage({ text: 'Changed' })
      expect(retry.status).toBe('error')
      if (retry.error === undefined) throw new Error('Expected content refusal')
      expect(retry.error.message).toBe(new TurnConflict({ messageId: 'immutable' }).message)
      await expect(
        streamRun(
          opened.harness,
          { conversationId: opened.root.id, content: 'Changed', requestId: 'immutable' },
          context,
        ),
      ).rejects.toBeInstanceOf(TurnConflict)
      const same = await consume(
        await streamRun(
          opened.harness,
          { conversationId: opened.root.id, content: 'Original', requestId: 'immutable' },
          context,
        ),
      )
      if (first.lastMessage === undefined) throw new Error('Expected original assistant')
      expect(same.message.parts).toEqual(first.lastMessage.parts)
      expect(await waiting(opened.harness, opened.root.id, context)).toEqual(held)
      expect(opened.faux.state.callCount).toBe(1)
    }),
  )

/** Concurrent first admissions share Pi's atomic request winner; neither may replace its content. */
it.live('admits one content winner and refuses its concurrent different-content rival', () =>
  Effect.promise(async () => {
    const opened = await (await shop()).open()
    opened.faux.setResponses([call('pay', { amount: 1 }, 'held')])
    const candidates = ['One', 'Two']
    const outcomes = await Promise.allSettled(
      candidates.map((content) =>
        streamRun(
          opened.harness,
          { conversationId: opened.root.id, content, requestId: 'race' },
          context,
        ),
      ),
    )
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1)
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.status === 'rejected') {
        expect(outcome.reason).toBeInstanceOf(TurnConflict)
        continue
      }
      const original = await consume(outcome.value)
      const content = candidates[index]
      if (content === undefined) throw new Error('Missing candidate')
      const repeated = await consume(
        await streamRun(
          opened.harness,
          { conversationId: opened.root.id, content, requestId: 'race' },
          context,
        ),
      )
      expect(repeated.message).toEqual(original.message)
    }
    expect(opened.faux.state.callCount).toBe(1)
  }),
)

/** A conflicting queued retry fails immediately; the original Person input remains in the inbox. */
it.live('refuses changed queued content before placement and keeps the original follow-up', () =>
  Effect.promise(async () => {
    const opened = await (await host({}, {})).open()
    const entered = signal()
    const release = signal()
    onTestFinished(() => release.resolve())
    opened.faux.setResponses([
      async () => {
        entered.resolve()
        await release.promise
        return fauxAssistantMessage('First.')
      },
      fauxAssistantMessage('Queued.'),
    ])
    const original = await streamRun(
      opened.harness,
      { conversationId: opened.root.id, content: 'First', requestId: 'first' },
      context,
    )
    await entered.promise
    const second = await opened.root.submit(
      { type: 'input', content: 'Original queued', requestId: 'queued' },
      context,
    )
    expect((await second.status(context)).status).toBe('queued')
    await expect(
      streamRun(
        opened.harness,
        { conversationId: opened.root.id, content: 'Changed queued', requestId: 'queued' },
        context,
      ),
    ).rejects.toBeInstanceOf(TurnConflict)
    expect((await second.status(context)).status).toBe('queued')
    const retry = streamRun(
      opened.harness,
      { conversationId: opened.root.id, content: 'Original queued', requestId: 'queued' },
      context,
    )
    release.resolve()
    await consume(original)
    await consume(await retry)
    expect(opened.faux.state.callCount).toBe(2)
  }),
)

/** Ordered images and their persisted filename are part of the immutable identity too. */
it.live('compares image content and order without allocating JSON copies of the payload', () =>
  Effect.promise(async () => {
    const opened = await (
      await host(
        {},
        {},
        {},
        {
          models: [{ id: 'faux-1', input: ['text', 'image'] }],
        },
      )
    ).open()
    opened.faux.setResponses([fauxAssistantMessage('Picture accepted.')])
    const picture: InputPart = {
      type: 'file',
      mediaType: 'image/png',
      filename: 'first.png',
      url: 'data:image/png;base64,iVBORw0KGgoAAA==',
    }
    const parts: readonly InputPart[] = [picture, { type: 'text', text: 'Original' }]
    const first = await consume(
      await streamRun(
        opened.harness,
        { conversationId: opened.root.id, content: parts, requestId: 'picture' },
        context,
      ),
    )
    for (const content of [
      parts.toReversed(),
      [{ ...picture, filename: 'second.png' }, parts[1]],
    ]) {
      if (content.some((part) => part === undefined)) throw new Error('Missing picture input')
      const response = await respond(
        opened.harness,
        opened.root.id,
        new Request('http://durable.test/chat', {
          method: 'POST',
          body: JSON.stringify({
            messages: [{ role: 'user', id: 'picture', parts: content }],
          }),
        }),
        context,
      )
      expect(response.status).toBe(409)
    }
    const same = await consume(
      await streamRun(
        opened.harness,
        { conversationId: opened.root.id, content: parts, requestId: 'picture' },
        context,
      ),
    )
    expect(same.message).toEqual(first.message)
    expect(opened.faux.state.callCount).toBe(1)
  }),
)
