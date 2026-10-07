import { Deferred, Effect, Option } from 'effect'
import { runForPi } from '../pi.ts'
import { FixtureFailed } from '../fixtures/harness.ts'
import { consumeReadable } from '../fixtures/reading.ts'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from '@effect/vitest'
import { PlainChat } from '../fixtures/chat.ts'
import { TurnConflict, streamRun, respond, waiting, type InputPart } from '../main.ts'
import { call, context, host, shop } from './fixtures/host.ts'
/** Pi's request-id winner is immutable even when a stock Chat edits and retries its own user part. */
for (const state of ['active', 'done'] as const)
  it.live(`refuses different content for the same ${state} input id with HTTP 409`, () =>
    Effect.gen(function* () {
      const opened = yield* (yield* shop()).open()
      opened.faux.setResponses([
        state === 'active' ? call('pay', { amount: 1 }, 'held') : fauxAssistantMessage('Once.'),
      ])
      const first = new PlainChat({ transport: opened.transport, generateId: () => 'immutable' })
      yield* Effect.promise(() => first.sendMessage({ text: 'Original' }))
      const held = yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context))
      const retry = new PlainChat({ transport: opened.transport, generateId: () => 'immutable' })
      yield* Effect.promise(() => retry.sendMessage({ text: 'Changed' }))
      expect(retry.status).toBe('error')
      if (retry.error === undefined) throw new Error('Expected content refusal')
      expect(retry.error.message).toBe(new TurnConflict({ messageId: 'immutable' }).message)
      yield* Effect.map(
        Effect.flip(
          Effect.tryPromise({
            try: () =>
              streamRun(
                opened.harness,
                { conversationId: opened.root.id, content: 'Changed', requestId: 'immutable' },
                context,
              ),
            catch: (cause) => new FixtureFailed({ cause }),
          }),
        ),
        (failed) => expect(failed.cause).toBeInstanceOf(TurnConflict),
      )
      const same = yield* consumeReadable(
        yield* Effect.promise(() =>
          streamRun(
            opened.harness,
            { conversationId: opened.root.id, content: 'Original', requestId: 'immutable' },
            context,
          ),
        ),
        Option.none(),
      )
      if (first.lastMessage === undefined) throw new Error('Expected original assistant')
      expect(same.message.parts).toEqual(first.lastMessage.parts)
      expect(yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context))).toEqual(
        held,
      )
      expect(opened.faux.state.callCount).toBe(1)
    }),
  )
/** Concurrent first admissions share Pi's atomic request winner; neither may replace its content. */
it.live('admits one content winner and refuses its concurrent different-content rival', () =>
  Effect.gen(function* () {
    const opened = yield* (yield* shop()).open()
    opened.faux.setResponses([call('pay', { amount: 1 }, 'held')])
    const candidates = ['One', 'Two']
    // Settle both rivals without fail-fast interruption, preserving their original causes.
    const outcomes = yield* Effect.forEach(
      candidates,
      (content) =>
        Effect.tryPromise({
          try: () =>
            streamRun(
              opened.harness,
              { conversationId: opened.root.id, content, requestId: 'race' },
              context,
            ),
          catch: (cause) => new FixtureFailed({ cause }),
        }).pipe(
          Effect.match({
            onFailure: (failed) => ({ status: 'rejected' as const, reason: failed.cause }),
            onSuccess: (value) => ({ status: 'fulfilled' as const, value }),
          }),
        ),
      { concurrency: 'unbounded' },
    )
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1)
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.status === 'rejected') {
        expect(outcome.reason).toBeInstanceOf(TurnConflict)
        continue
      }
      const original = yield* consumeReadable(outcome.value, Option.none())
      const content = candidates[index]
      if (content === undefined) throw new Error('Missing candidate')
      const repeated = yield* consumeReadable(
        yield* Effect.promise(() =>
          streamRun(
            opened.harness,
            { conversationId: opened.root.id, content, requestId: 'race' },
            context,
          ),
        ),
        Option.none(),
      )
      expect(repeated.message).toEqual(original.message)
    }
    expect(opened.faux.state.callCount).toBe(1)
  }),
)
/** A conflicting queued retry fails immediately; the original Person input remains in the inbox. */
it.live('refuses changed queued content before placement and keeps the original follow-up', () =>
  Effect.gen(function* () {
    const opened = yield* (yield* host({}, {})).open()
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    yield* Effect.addFinalizer(() => Effect.sync(() => Deferred.doneUnsafe(release, Effect.void)))
    opened.faux.setResponses([
      () =>
        runForPi(
          Effect.gen(function* () {
            Deferred.doneUnsafe(entered, Effect.void)
            yield* Deferred.await(release)
            return fauxAssistantMessage('First.')
          }),
          undefined,
        ),
      fauxAssistantMessage('Queued.'),
    ])
    const original = yield* Effect.promise(() =>
      streamRun(
        opened.harness,
        { conversationId: opened.root.id, content: 'First', requestId: 'first' },
        context,
      ),
    )
    yield* Deferred.await(entered)
    const second = yield* Effect.promise(() =>
      opened.root.submit(
        { type: 'input', content: 'Original queued', requestId: 'queued' },
        context,
      ),
    )
    expect((yield* Effect.promise(() => second.status(context))).status).toBe('queued')
    yield* Effect.map(
      Effect.flip(
        Effect.tryPromise({
          try: () =>
            streamRun(
              opened.harness,
              { conversationId: opened.root.id, content: 'Changed queued', requestId: 'queued' },
              context,
            ),
          catch: (cause) => new FixtureFailed({ cause }),
        }),
      ),
      (failed) => expect(failed.cause).toBeInstanceOf(TurnConflict),
    )
    expect((yield* Effect.promise(() => second.status(context))).status).toBe('queued')
    const retry = streamRun(
      opened.harness,
      { conversationId: opened.root.id, content: 'Original queued', requestId: 'queued' },
      context,
    )
    Deferred.doneUnsafe(release, Effect.void)
    yield* consumeReadable(original, Option.none())
    yield* consumeReadable(yield* Effect.promise(() => retry), Option.none())
    expect(opened.faux.state.callCount).toBe(2)
  }),
)
/** Ordered images and their persisted filename are part of the immutable identity too. */
it.live('compares image content and order without allocating JSON copies of the payload', () =>
  Effect.gen(function* () {
    const opened = yield* (yield* host(
      {},
      {},
      {},
      {
        models: [{ id: 'faux-1', input: ['text', 'image'] }],
      },
    )).open()
    opened.faux.setResponses([fauxAssistantMessage('Picture accepted.')])
    const picture: InputPart = {
      type: 'file',
      mediaType: 'image/png',
      filename: 'first.png',
      url: 'data:image/png;base64,iVBORw0KGgoAAA==',
    }
    const parts: readonly InputPart[] = [picture, { type: 'text', text: 'Original' }]
    const first = yield* consumeReadable(
      yield* Effect.promise(() =>
        streamRun(
          opened.harness,
          { conversationId: opened.root.id, content: parts, requestId: 'picture' },
          context,
        ),
      ),
      Option.none(),
    )
    for (const content of [
      parts.toReversed(),
      [{ ...picture, filename: 'second.png' }, parts[1]],
    ]) {
      if (content.some((part) => part === undefined)) throw new Error('Missing picture input')
      const response = yield* Effect.promise(() =>
        respond(
          opened.harness,
          opened.root.id,
          new Request('http://durable.test/chat', {
            method: 'POST',
            body: JSON.stringify({
              messages: [{ role: 'user', id: 'picture', parts: content }],
            }),
          }),
          context,
        ),
      )
      expect(response.status).toBe(409)
    }
    const same = yield* consumeReadable(
      yield* Effect.promise(() =>
        streamRun(
          opened.harness,
          { conversationId: opened.root.id, content: parts, requestId: 'picture' },
          context,
        ),
      ),
      Option.none(),
    )
    expect(same.message).toEqual(first.message)
    expect(opened.faux.state.callCount).toBe(1)
  }),
)
