import { Deferred, Effect, Fiber, Option, Stream } from 'effect'
import { FixtureFailed } from '../fixtures/harness.ts'
import { consumeReadable, hold, ReadFailed } from '../fixtures/reading.ts'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from '@effect/vitest'
import { waitForFrame } from '../fixtures/provider.ts'
import { abort, history, attachRun, CallNotWaiting, decide, streamRun, waiting } from '../main.ts'
import { call, context, host, shop, texts } from './fixtures/host.ts'
/** A real partial receipt arms cancellation; no clock wait is used to guess provider progress. */
it.live('aborts producing text, emits abort, and retains the committed partial', () =>
  Effect.gen(function* () {
    const release = yield* Deferred.make<void>()
    let gated = false
    const fixture = yield* host(
      {},
      {},
      {},
      {
        onFrame: (event, abortSignal) => {
          if (event.type !== 'text_delta' || gated) return Effect.void
          gated = true
          return waitForFrame(Deferred.await(release), abortSignal)
        },
      },
    )
    const opened = yield* fixture.open()
    yield* Effect.addFinalizer(() => Effect.sync(() => Deferred.doneUnsafe(release, Effect.void)))
    const full = 'word '.repeat(3000)
    opened.faux.setResponses([fauxAssistantMessage(full)])
    const stream = yield* Effect.promise(() =>
      streamRun(
        opened.harness,
        {
          conversationId: opened.root.id,
          content: 'Write',
          requestId: 'partial',
        },
        context,
      ),
    )
    const [observed, folded] = stream.tee()
    const started = yield* Deferred.make<void>()
    const chunks = yield* Effect.forkScoped(consumeReadable(folded, Option.none()))
    const watching = yield* Effect.forkScoped(
      Effect.gen(function* () {
        const types: string[] = []
        yield* Stream.runForEach(
          Stream.fromAsyncIterable(observed, (cause) => new ReadFailed({ cause })),
          (chunk) =>
            Effect.sync(() => {
              types.push(chunk.type)
              if (chunk.type === 'text-delta') Deferred.doneUnsafe(started, Effect.void)
            }),
        )
        return types
      }),
    )
    yield* Deferred.await(started)
    yield* Effect.promise(() => abort(opened.harness, opened.root.id, context))
    Deferred.doneUnsafe(release, Effect.void)
    const result = yield* Fiber.join(chunks)
    expect(yield* Fiber.join(watching)).toContain('abort')
    const settled = yield* Effect.promise(() =>
      history(opened.harness, opened.root.id, { limit: 10 }, context),
    )
    expect(Option.getOrThrow(Option.fromNullishOr(settled.messages.at(-1))).parts).toEqual(
      result.message.parts,
    )
    const partial = texts(result.message).join('')
    expect(partial.length).toBeGreaterThan(0)
    expect(partial.length).toBeLessThan(full.length)
    expect(yield* Effect.promise(() => attachRun(opened.harness, opened.root.id, context))).toEqual(
      { status: 'idle' },
    )
    const entries = yield* Effect.promise(() => opened.root.entries({}, 100, undefined, context))
    const assistant = entries.items.find((entry) => entry.kind === 'pi.assistant')
    if (assistant === undefined || assistant.model === undefined)
      throw new Error('Expected an aborted entry')
    expect(assistant.model[0]).toMatchObject({
      stopReason: 'aborted',
      content: [{ type: 'text', text: partial }],
    })
  }),
)
/** Interrupting a beforeTool Deferred settles abort without executing or leaving an answerable hold. */
it.live('aborts a parked approval and rejects a late decision', () =>
  Effect.gen(function* () {
    const fixture = yield* shop()
    const opened = yield* fixture.open()
    opened.faux.setResponses([call('pay', { amount: 100 }, 'held')])
    yield* consumeReadable(
      yield* Effect.promise(() =>
        streamRun(
          opened.harness,
          {
            conversationId: opened.root.id,
            content: 'Pay',
            requestId: 'held',
          },
          context,
        ),
      ),
      Option.none(),
    )
    expect(
      yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context)),
    ).toHaveLength(1)
    const holdId = yield* hold(opened.harness, opened.root.id, 'held', context)
    yield* Effect.promise(() => abort(opened.harness, opened.root.id, context))
    expect(yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context))).toEqual(
      [],
    )
    yield* Effect.map(
      Effect.flip(
        Effect.tryPromise({
          try: () => decide(opened.harness, opened.root.id, { holdId, approved: true }, context),
          catch: (cause) => new FixtureFailed({ cause }),
        }),
      ),
      (failed) => expect(failed.cause).toBeInstanceOf(CallNotWaiting),
    )
    expect(yield* Effect.promise(() => attachRun(opened.harness, opened.root.id, context))).toEqual(
      { status: 'idle' },
    )
    expect(fixture.paid).toEqual([])
    const settled = yield* Effect.promise(() =>
      history(opened.harness, opened.root.id, { limit: 10 }, context),
    )
    expect(settled.messages.filter((message) => message.role === 'user')).toMatchObject([
      { parts: [{ type: 'text', text: 'Pay' }] },
    ])
    expect(
      settled.messages
        .flatMap((message) => message.parts)
        .some(
          (part) => 'toolCallId' in part && 'state' in part && part.state === 'approval-requested',
        ),
    ).toBe(false)
  }),
)
/** Queued follow-ups are withdrawn by the same durable abort, without creating another user entry. */
it.live('withdraws a queued follow-up when aborting a held run', () =>
  Effect.gen(function* () {
    const fixture = yield* shop()
    const opened = yield* fixture.open()
    opened.faux.setResponses([
      call('pay', { amount: 100 }, 'held'),
      fauxAssistantMessage('Never run.'),
    ])
    yield* consumeReadable(
      yield* Effect.promise(() =>
        streamRun(
          opened.harness,
          {
            conversationId: opened.root.id,
            content: 'Pay',
            requestId: 'held',
          },
          context,
        ),
      ),
      Option.none(),
    )
    const follow = yield* Effect.promise(() =>
      opened.root.submit(
        {
          type: 'input',
          content: 'Follow up',
          requestId: 'follow',
          whenBusy: 'followUp',
        },
        context,
      ),
    )
    expect((yield* Effect.promise(() => follow.status(context))).status).toBe('queued')
    yield* Effect.promise(() => abort(opened.harness, opened.root.id, context))
    expect(yield* Effect.promise(() => follow.status(context))).toMatchObject({
      status: 'unanswered',
      reason: 'aborted',
    })
    expect(yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context))).toEqual(
      [],
    )
    expect(yield* Effect.promise(() => attachRun(opened.harness, opened.root.id, context))).toEqual(
      { status: 'idle' },
    )
    const entries = yield* Effect.promise(() => opened.root.entries({}, 100, undefined, context))
    expect(entries.items.filter((entry) => entry.kind === 'pi.user')).toHaveLength(1)
    expect(fixture.paid).toEqual([])
    const settled = yield* Effect.promise(() =>
      history(opened.harness, opened.root.id, { limit: 10 }, context),
    )
    expect(settled.messages.filter((message) => message.role === 'user')).toMatchObject([
      { parts: [{ type: 'text', text: 'Pay' }] },
    ])
    expect(
      settled.messages
        .flatMap((message) => message.parts)
        .some(
          (part) => 'toolCallId' in part && 'state' in part && part.state === 'approval-requested',
        ),
    ).toBe(false)
  }),
)
