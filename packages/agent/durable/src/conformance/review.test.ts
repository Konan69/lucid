import { runForPi } from '../pi.ts'
import { consumeReadable as consume, hold, ReadFailed } from '../fixtures/reading.ts'
import { holdId } from '../main.ts'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { tool } from 'ai'
import { expect, it } from '@effect/vitest'
import { Effect, Deferred, Fiber, Option, Stream } from 'effect'
import { waitForFrame } from '../fixtures/provider.ts'
import { z } from 'zod'

import { CallNotWaiting, continueRun, decide, respond, streamRun, waiting } from '../main.ts'
import { call, context, host, modelText, shop } from './fixtures/host.ts'

// Review dup.test.ts: Pi generation.startToolRound accepts duplicate ids but public decisions cannot distinguish them.
it.live('blocks every duplicate id in a round without requesting approval or paying', () =>
  Effect.gen(function* () {
    const fixture = yield* shop()
    const opened = yield* fixture.open()
    let reason = ''
    opened.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('pay', { amount: 1 }, { id: 'dup' }),
          fauxToolCall('pay', { amount: 999 }, { id: 'dup' }),
        ],
        { stopReason: 'toolUse' },
      ),
      (request) => {
        reason = modelText(request.messages)
        return fauxAssistantMessage('Blocked.')
      },
    ])
    const result = yield* consume(
      yield* Effect.promise(() =>
        streamRun(
          opened.harness,
          {
            conversationId: opened.root.id,
            content: 'Pay',
            requestId: 'duplicate',
          },
          context,
        ),
      ),
      Option.none(),
    )
    expect(result.chunks.filter((chunk) => chunk.type === 'tool-approval-request')).toEqual([])
    expect(yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context))).toEqual(
      [],
    )
    expect(
      (yield* rejected(() =>
        decide(
          opened.harness,
          opened.root.id,
          { holdId: holdId('hold:99999999'), approved: true },
          context,
        ),
      )).cause,
    ).toBeInstanceOf(CallNotWaiting)
    yield* Effect.promise(() => opened.root.waitForIdle(context))
    expect(reason).toContain('duplicate tool call id')
    expect(fixture.paid).toEqual([])
  }),
)

// Review probe.test.ts E: a completed unrelated task must retain its actual error, not an older denial.
it.live('does not apply a stale denial to a failing unheld task with the same id', () =>
  Effect.gen(function* () {
    const fixture = yield* host(
      {
        pay: tool({ inputSchema: z.object({}), execute: () => Promise.resolve('paid') }),
        boom: tool({
          inputSchema: z.object({}),
          execute: () => {
            return Promise.reject<string>(new Error('exploded'))
          },
        }),
      },
      { approval: { pay: true } },
    )
    const opened = yield* fixture.open()
    opened.faux.setResponses([
      call('pay', {}, 'same'),
      fauxAssistantMessage('Denied.'),
      call('boom', {}, 'same'),
      fauxAssistantMessage('Failed.'),
    ])
    yield* consume(
      yield* Effect.promise(() =>
        streamRun(
          opened.harness,
          {
            conversationId: opened.root.id,
            content: 'Pay',
            requestId: 'denied',
          },
          context,
        ),
      ),
      Option.none(),
    )
    const resolved6 = yield* hold(opened.harness, opened.root.id, 'same', context)
    yield* Effect.promise(() =>
      decide(
        opened.harness,
        opened.root.id,
        { holdId: resolved6, approved: false, reason: 'no' },
        context,
      ),
    )
    yield* Effect.promise(() => opened.root.waitForIdle(context))
    const result = yield* consume(
      yield* Effect.promise(() =>
        streamRun(
          opened.harness,
          {
            conversationId: opened.root.id,
            content: 'Fail',
            requestId: 'failed',
          },
          context,
        ),
      ),
      Option.none(),
    )
    expect(result.chunks.filter((chunk) => chunk.type === 'tool-output-denied')).toEqual([])
    expect(result.chunks.find((chunk) => chunk.type === 'tool-output-error')).toMatchObject({
      toolCallId: 'same',
      errorText: expect.stringContaining('exploded'),
    })
    const entries = (yield* Effect.promise(() => opened.root.context(context))).entries
    const resultEntry = entries.findLast((entry) =>
      (entry.model ?? []).some(
        (message) => message.role === 'toolResult' && message.toolCallId === 'same',
      ),
    )
    const failedTask = resultEntry === undefined ? undefined : resultEntry.byTaskId
    if (failedTask === undefined) throw new Error('Expected failed task provenance')
    expect(
      (yield* rejected(() =>
        decide(
          opened.harness,
          opened.root.id,
          { holdId: holdId(`hold:${failedTask}`), approved: true },
          context,
        ),
      )).cause,
    ).toBeInstanceOf(CallNotWaiting)
  }),
)

// Review probe.test.ts B: streamed input exists before its new tool task; historical approvals never apply.
it.live(
  'requests a fresh approval for a reused id in a later run with streamed partial input',
  () =>
    Effect.gen(function* () {
      const paid: number[] = []
      const release = yield* Deferred.make<void>()
      let generation = 0
      const fixture = yield* host(
        {
          pay: tool({
            inputSchema: z.object({ amount: z.number() }),
            execute: ({ amount }) => {
              paid.push(amount)
              return Promise.resolve(amount)
            },
          }),
        },
        { approval: { pay: true } },
        { progress: { partialIntervalMs: 1 } },
        {
          partialFamily: 'anthropic',
          onFrame: (event, abortSignal) => {
            if (event.type === 'toolcall_start') generation += 1
            return event.type === 'toolcall_start' && generation === 2
              ? waitForFrame(Deferred.await(release), abortSignal)
              : Effect.void
          },
        },
      )
      const opened = yield* fixture.open()
      yield* Effect.addFinalizer(() => Effect.sync(() => Deferred.doneUnsafe(release, Effect.void)))
      opened.faux.setResponses([
        call('pay', { amount: 100 }, 'reused'),
        fauxAssistantMessage('First paid.'),
        fauxAssistantMessage(
          [
            fauxToolCall('pay', { amount: 200 }, { id: 'reused' }),
            { type: 'text', text: 'word '.repeat(60) },
          ],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('Second denied.'),
      ])
      yield* consume(
        yield* Effect.promise(() =>
          streamRun(
            opened.harness,
            {
              conversationId: opened.root.id,
              content: 'Pay',
              requestId: 'first',
            },
            context,
          ),
        ),
        Option.none(),
      )
      const resolved7 = yield* hold(opened.harness, opened.root.id, 'reused', context)
      yield* Effect.promise(() =>
        decide(opened.harness, opened.root.id, { holdId: resolved7, approved: true }, context),
      )
      yield* Effect.promise(() => opened.root.waitForIdle(context))
      const stream = yield* Effect.promise(() =>
        streamRun(
          opened.harness,
          {
            conversationId: opened.root.id,
            content: 'Again',
            requestId: 'second',
          },
          context,
        ),
      )
      const [observed, folded] = stream.tee()
      const started = yield* Deferred.make<void>()
      const resultPromise = yield* consume(folded, Option.none()).pipe(Effect.forkScoped)
      const drain = yield* Stream.runForEach(
        Stream.fromReadableStream({
          evaluate: () => observed,
          onError: (cause) => new ReadFailed({ cause }),
        }),
        (chunk) =>
          chunk.type === 'tool-input-start' ? Deferred.succeed(started, undefined) : Effect.void,
      ).pipe(Effect.forkScoped)
      yield* Deferred.await(started)
      expect(yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context))).toEqual(
        [],
      )
      expect(paid).toEqual([100])
      yield* Deferred.succeed(release, undefined)
      const result = yield* Fiber.join(resultPromise)
      yield* Fiber.join(drain)
      expect(result.chunks.filter((chunk) => chunk.type === 'tool-approval-response')).toEqual([])
      expect(result.chunks.filter((chunk) => chunk.type === 'tool-approval-request')).toHaveLength(
        1,
      )
      expect(
        yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context)),
      ).toMatchObject([{ callId: 'reused', input: { amount: 200 } }])
      expect(paid).toEqual([100])
      const resolved8 = yield* hold(opened.harness, opened.root.id, 'reused', context)
      yield* Effect.promise(() =>
        decide(opened.harness, opened.root.id, { holdId: resolved8, approved: false }, context),
      )
      yield* Effect.promise(() => opened.root.waitForIdle(context))
      expect(paid).toEqual([100])
    }),
)

// Review probe.test.ts F: the next round of one run has its own task even when its call id is reused.
it.live('requires a fresh decision when a later round of the same run reuses an id', () =>
  Effect.gen(function* () {
    const fixture = yield* shop()
    const opened = yield* fixture.open()
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    opened.faux.setResponses([
      call('pay', { amount: 100 }, 'reused'),
      () =>
        runForPi(
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
            return call('pay', { amount: 200 }, 'reused')
          }),
          undefined,
        ),
      fauxAssistantMessage('Resolved.'),
    ])
    const first = yield* consume(
      yield* Effect.promise(() =>
        streamRun(
          opened.harness,
          {
            conversationId: opened.root.id,
            content: 'Pay',
            requestId: 'rounds',
          },
          context,
        ),
      ),
      Option.none(),
    )
    const resolved9 = yield* hold(opened.harness, opened.root.id, 'reused', context)
    yield* Effect.promise(() =>
      decide(opened.harness, opened.root.id, { holdId: resolved9, approved: true }, context),
    )
    try {
      yield* Deferred.await(entered)
      const stream = yield* Effect.promise(() =>
        continueRun(
          opened.harness,
          opened.root.id,
          { messageId: first.message.id, known: new Set(['reused']) },
          context,
        ),
      )
      yield* Deferred.succeed(release, undefined)
      const result = yield* consume(stream, Option.some(first.message))
      expect(result.chunks.filter((chunk) => chunk.type === 'tool-approval-request')).toMatchObject(
        [{ toolCallId: 'reused' }],
      )
      expect(
        yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context)),
      ).toMatchObject([{ callId: 'reused', input: { amount: 200 } }])
      expect(fixture.paid).toEqual([100])
      const resolved10 = yield* hold(opened.harness, opened.root.id, 'reused', context)
      yield* Effect.promise(() =>
        decide(opened.harness, opened.root.id, { holdId: resolved10, approved: false }, context),
      )
      yield* Effect.promise(() => opened.root.waitForIdle(context))
      expect(fixture.paid).toEqual([100])
    } finally {
      yield* Deferred.succeed(release, undefined)
    }
  }),
)

// Review probe.test.ts A: an unstarted sequential slot is not approvable even if the POST names it.
// This explicitly driven HTTP test does not claim the stock automatic predicate can initiate the POST.
it.live('ignores an unstarted sequential decision instead of rejecting the resume', () =>
  Effect.gen(function* () {
    const paid: number[] = []
    const executed = yield* Deferred.make<void>()
    const fixture = yield* host(
      {
        pay: tool({
          inputSchema: z.object({ amount: z.number() }),
          execute: ({ amount }) => {
            paid.push(amount)
            Deferred.doneUnsafe(executed, Effect.void)
            return Promise.resolve(amount)
          },
        }),
      },
      { execution: 'sequential', approval: { pay: true } },
      { toolExecution: 'sequential' },
    )
    const opened = yield* fixture.open()
    opened.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('pay', { amount: 1 }, { id: 'c1' }),
          fauxToolCall('pay', { amount: 2 }, { id: 'c2' }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('Done.'),
    ])
    const first = yield* consume(
      yield* Effect.promise(() =>
        streamRun(
          opened.harness,
          {
            conversationId: opened.root.id,
            content: 'Pay',
            requestId: 'sequential',
          },
          context,
        ),
      ),
      Option.none(),
    )
    expect(first.chunks.filter((chunk) => chunk.type === 'tool-approval-request')).toMatchObject([
      { toolCallId: 'c1' },
    ])
    expect(
      yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context)),
    ).toMatchObject([{ callId: 'c1' }])
    const firstHold = yield* hold(opened.harness, opened.root.id, 'c1', context)
    const body = {
      messages: [
        {
          role: 'assistant',
          id: first.message.id,
          parts: ['c1', 'c2'].map((id) => ({
            type: 'tool-pay',
            toolCallId: id,
            state: 'approval-responded',
            approval: { id: id === 'c1' ? firstHold : holdId('hold:99999999'), approved: true },
          })),
        },
      ],
    }
    const response = yield* Effect.promise(() =>
      respond(
        opened.harness,
        opened.root.id,
        new Request('http://durable.test/chat', {
          method: 'POST',
          body: JSON.stringify(body),
        }),
        context,
      ),
    )
    expect(response.status).toBe(200)
    if (response.body === null) throw new Error('Expected the second approval response')
    // This probe sends an unsolicited c2 decision. It is ignored; the sequential suite separately
    // proves c2's live-watch presentation and its next stock automatic round trip.
    const bodyStream = response.body
    yield* Effect.promise(() => bodyStream.cancel())
    yield* Deferred.await(executed)
    expect(paid).toEqual([1])
  }),
)

/** Inspect one rejected operation's original cause without changing SDK error identity. */
function rejected<A>(operation: () => PromiseLike<A>) {
  return Effect.tryPromise({ try: operation, catch: (cause) => new ReadFailed({ cause }) }).pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        Effect.succeed({
          cause: error.cause,
          raise: () => {
            throw error.cause
          },
        }),
      onSuccess: () => Effect.die(new Error('Expected the operation to reject')),
    }),
  )
}
