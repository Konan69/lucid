import type { Opened } from './fixtures/host.ts'
import { runForPi } from '../pi.ts'
import { consumeReadable as consume, hold, ReadFailed } from '../fixtures/reading.ts'
import { Effect, Deferred, Option } from 'effect'
import { holdId as parseHoldId } from '../main.ts'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from '@effect/vitest'

import { CallNotWaiting, answer, continueRun, decide, streamRun, waiting } from '../main.ts'
import { call, context, modelText, shop, texts } from './fixtures/host.ts'

/** Run through the public stream until a complete tool round parks for a person. */
const park = Effect.fn('Test.park')(function* (opened: Opened) {
  return yield* consume(
    yield* Effect.promise(() =>
      streamRun(
        opened.harness,
        { conversationId: opened.root.id, content: 'Pay', requestId: 'pay' },
        context,
      ),
    ),
    Option.none(),
  )
})

// Cloudflare packages/think/src/tests/actions-durable-pause.test.ts: runs the action exactly once on approve and clears the pending row.
it.live('approval runs the tool once and clears its hold', () =>
  Effect.gen(function* () {
    const fixture = yield* shop()
    const opened = yield* fixture.open()
    opened.faux.setResponses([call('pay', { amount: 500 }, 'pay'), fauxAssistantMessage('Paid.')])
    const parked = yield* park(opened)
    expect(fixture.paid).toEqual([])
    expect(yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context))).toEqual([
      {
        holdId: expect.stringMatching(/^hold:/u),
        kind: 'approval',
        callId: 'pay',
        toolName: 'pay',
        input: { amount: 500 },
      },
    ])
    const resolved9 = yield* hold(opened.harness, opened.root.id, 'pay', context)
    yield* Effect.promise(() =>
      decide(opened.harness, opened.root.id, { holdId: resolved9, approved: true }, context),
    )
    const stream = yield* Effect.promise(() =>
      continueRun(
        opened.harness,
        opened.root.id,
        { messageId: parked.message.id, known: new Set(['pay']) },
        context,
      ),
    )
    if (stream === undefined) throw new Error('Expected the held run')
    const result = yield* consume(stream, Option.some(parked.message))
    expect(fixture.paid).toEqual([500])
    expect(result.message.parts.find((part) => part.type === 'tool-pay')).toMatchObject({
      state: 'output-available',
      output: { receipt: 500 },
    })
    expect(texts(result.message)).toEqual(['Paid.'])
    expect(yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context))).toEqual(
      [],
    )
  }),
)

// Cloudflare packages/think/src/tests/actions-durable-pause.test.ts: rejects without running the action and clears the pending row.
// Cloudflare packages/think/src/tests/execute-hitl.test.ts: reject applies a rejected output with the reason and continues.
it.live('denial never executes and gives the model the reason', () =>
  Effect.gen(function* () {
    const fixture = yield* shop()
    const opened = yield* fixture.open()
    let prompt = ''
    opened.faux.setResponses([
      call('pay', { amount: 500 }, 'pay'),
      (request) => {
        prompt = modelText(request.messages)
        return fauxAssistantMessage('Denied.')
      },
    ])
    const parked = yield* park(opened)
    const resolved10 = yield* hold(opened.harness, opened.root.id, 'pay', context)
    yield* Effect.promise(() =>
      decide(
        opened.harness,
        opened.root.id,
        {
          holdId: resolved10,
          approved: false,
          reason: 'Budget exceeded',
        },
        context,
      ),
    )
    const stream = yield* Effect.promise(() =>
      continueRun(
        opened.harness,
        opened.root.id,
        { messageId: parked.message.id, known: new Set(['pay']) },
        context,
      ),
    )
    if (stream === undefined) throw new Error('Expected the held run')
    const result = yield* consume(stream, Option.some(parked.message))
    expect(fixture.paid).toEqual([])
    expect(prompt).toContain('Budget exceeded')
    expect(result.message.parts.find((part) => part.type === 'tool-pay')).toMatchObject({
      state: 'output-denied',
    })
    expect(yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context))).toEqual(
      [],
    )
  }),
)

// Cloudflare packages/think/src/tests/actions-durable-pause.test.ts: attaches the descriptor to the paused part and continues with no open connection on approve.
it.live('a decision with no client attached completes the durable run', () =>
  Effect.gen(function* () {
    const fixture = yield* shop()
    const opened = yield* fixture.open()
    opened.faux.setResponses([
      call('pay', { amount: 500 }, 'pay'),
      fauxAssistantMessage('Detached completion.'),
    ])
    yield* park(opened)
    // The stream has ended; deciding must drive the run without continueRun or another HTTP request.
    const resolved11 = yield* hold(opened.harness, opened.root.id, 'pay', context)
    yield* Effect.promise(() =>
      decide(opened.harness, opened.root.id, { holdId: resolved11, approved: true }, context),
    )
    yield* Effect.promise(() => opened.root.waitForIdle(context))
    expect(fixture.paid).toEqual([500])
    expect(
      modelText(
        (yield* Effect.promise(() => opened.root.context(context))).entries.flatMap((entry) =>
          entry.model === undefined ? [] : entry.model,
        ),
      ),
    ).toContain('Detached completion.')
    expect(yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context))).toEqual(
      [],
    )
  }),
)

// Cloudflare packages/think/src/tests/actions-durable-pause.test.ts: does not double-execute across a duplicate approve when idempotency-keyed.
// A repeated decision returns the detached first settlement after Pi commits its overlay.
it.live('repeated decisions return the first settlement and execute once', () =>
  Effect.gen(function* () {
    const fixture = yield* shop()
    const opened = yield* fixture.open()
    opened.faux.setResponses([call('pay', { amount: 500 }, 'pay'), fauxAssistantMessage('Once.')])
    yield* park(opened)
    const decision = {
      holdId: yield* hold(opened.harness, opened.root.id, 'pay', context),
      approved: true,
    }
    expect(
      yield* Effect.promise(() => decide(opened.harness, opened.root.id, decision, context)),
    ).toEqual({
      kind: 'approved',
    })
    const repeated = yield* Effect.promise(() =>
      decide(opened.harness, opened.root.id, decision, context),
    )
    const conflicting = yield* Effect.promise(() =>
      decide(
        opened.harness,
        opened.root.id,
        { holdId: decision.holdId, approved: false, reason: 'Late denial' },
        context,
      ),
    )
    yield* Effect.promise(() => opened.root.waitForIdle(context))
    expect(fixture.paid).toEqual([500])
    expect(repeated).toEqual({ kind: 'approved' })
    expect(conflicting).toEqual({ kind: 'approved' })
  }),
)

// Cloudflare packages/think/src/tests/actions-durable-pause.test.ts: picks a single winner under concurrent approves.
// Concurrent decisions return the same detached first settlement.
it.live('concurrent decisions return usable settlements and execute once', () =>
  Effect.gen(function* () {
    const fixture = yield* shop()
    const opened = yield* fixture.open()
    opened.faux.setResponses([call('pay', { amount: 500 }, 'pay'), fauxAssistantMessage('Once.')])
    yield* park(opened)
    const decision = {
      holdId: yield* hold(opened.harness, opened.root.id, 'pay', context),
      approved: true,
    }
    const results = yield* Effect.all(
      [
        Effect.promise(() => decide(opened.harness, opened.root.id, decision, context)),
        Effect.promise(() => decide(opened.harness, opened.root.id, decision, context)),
      ],
      { concurrency: 'unbounded' },
    )
    yield* Effect.promise(() => opened.root.waitForIdle(context))
    expect(fixture.paid).toEqual([500])
    expect(results).toEqual([{ kind: 'approved' }, { kind: 'approved' }])
  }),
)

// Cloudflare packages/think/src/tests/execute-hitl.test.ts: approveExecution works after the in-memory handle is lost (DO restart path).
it.live('a decision after restart settles the original hold', () =>
  Effect.gen(function* () {
    const fixture = yield* shop()
    const before = yield* fixture.open()
    before.faux.setResponses([call('pay', { amount: 500 }, 'pay')])
    yield* park(before)
    yield* fixture.close(before.harness)
    const after = yield* fixture.open()
    after.faux.setResponses([fauxAssistantMessage('Restarted completion.')])
    expect(
      yield* Effect.promise(() => waiting(after.harness, after.root.id, context)),
    ).toMatchObject([{ callId: 'pay', kind: 'approval' }])
    const resolved12 = yield* hold(after.harness, after.root.id, 'pay', context)
    yield* Effect.promise(() =>
      decide(after.harness, after.root.id, { holdId: resolved12, approved: true }, context),
    )
    yield* Effect.promise(() => after.root.waitForIdle(context))
    expect(fixture.paid).toEqual([500])
    expect(yield* Effect.promise(() => waiting(after.harness, after.root.id, context))).toEqual([])
    expect(
      modelText(
        (yield* Effect.promise(() => after.root.context(context))).entries.flatMap((entry) =>
          entry.model === undefined ? [] : entry.model,
        ),
      ),
    ).toContain('Restarted completion.')
  }),
)

// Cloudflare packages/think/src/tests/execute-hitl.test.ts: supports concurrent paused executions — one approval card per part.
it.live('two holds in one round settle independently', () =>
  Effect.gen(function* () {
    const fixture = yield* shop()
    const opened = yield* fixture.open()
    opened.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('pay', { amount: 100 }, { id: 'one' }),
          fauxToolCall('pay', { amount: 200 }, { id: 'two' }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('Both resolved.'),
    ])
    const parked = yield* park(opened)
    expect(
      yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context)),
    ).toHaveLength(2)
    expect(parked.message.parts.filter((part) => part.type === 'tool-pay')).toHaveLength(2)
    const resolved13 = yield* hold(opened.harness, opened.root.id, 'one', context)
    yield* Effect.promise(() =>
      decide(opened.harness, opened.root.id, { holdId: resolved13, approved: true }, context),
    )
    expect(
      yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context)),
    ).toMatchObject([{ callId: 'two', kind: 'approval' }])
    const resolved14 = yield* hold(opened.harness, opened.root.id, 'two', context)
    yield* Effect.promise(() =>
      decide(
        opened.harness,
        opened.root.id,
        {
          holdId: resolved14,
          approved: false,
          reason: 'Only one',
        },
        context,
      ),
    )
    const stream = yield* Effect.promise(() =>
      continueRun(
        opened.harness,
        opened.root.id,
        { messageId: parked.message.id, known: new Set(['one', 'two']) },
        context,
      ),
    )
    if (stream === undefined) throw new Error('Expected the held run')
    const result = yield* consume(stream, Option.some(parked.message))
    expect(fixture.paid).toEqual([100])
    expect(
      result.message.parts.find((part) => 'toolCallId' in part && part.toolCallId === 'one'),
    ).toMatchObject({ state: 'output-available' })
    expect(
      result.message.parts.find((part) => 'toolCallId' in part && part.toolCallId === 'two'),
    ).toMatchObject({ state: 'output-denied' })
    expect(texts(result.message)).toEqual(['Both resolved.'])
  }),
)

// Cloudflare packages/think/src/tests/execute-hitl.test.ts: double-approve is graceful: the second returns an error and leaves the transcript alone.
// Adapt stale/non-pending interaction validation to the package's person-answered tool API.
// Unsolicited answers fail with the tagged CallNotWaiting domain error.
it.live('rejects an answer for a call that is not waiting', () =>
  Effect.gen(function* () {
    const fixture = yield* shop()
    const opened = yield* fixture.open()
    expect(yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context))).toEqual(
      [],
    )
    expect(
      (yield* rejected(() =>
        answer(
          opened.harness,
          opened.root.id,
          { holdId: parseHoldId('hold:99999999'), output: 'unsolicited' },
          context,
        ),
      )).raise,
    ).toThrow()
    expect(
      (yield* rejected(() =>
        answer(
          opened.harness,
          opened.root.id,
          { holdId: parseHoldId('hold:99999999'), output: 'unsolicited' },
          context,
        ),
      )).cause,
    ).toBeInstanceOf(CallNotWaiting)
  }),
)

// Cloudflare packages/think/src/tests/actions-durable-pause.test.ts: does not resolve a later paused call that reuses the toolCallId (#1992).
// A settlement authorizes its durable Pi task; a reused provider id starts a fresh hold.
it.live('a reused call id in a new run needs its own approval', () =>
  Effect.gen(function* () {
    const fixture = yield* shop()
    const opened = yield* fixture.open()
    opened.faux.setResponses([
      call('pay', { amount: 100 }, 'reused'),
      fauxAssistantMessage('First paid.'),
      call('pay', { amount: 200 }, 'reused'),
      fauxAssistantMessage('Second paid.'),
    ])
    yield* park(opened)
    const resolved15 = yield* hold(opened.harness, opened.root.id, 'reused', context)
    yield* Effect.promise(() =>
      decide(opened.harness, opened.root.id, { holdId: resolved15, approved: true }, context),
    )
    yield* Effect.promise(() => opened.root.waitForIdle(context))
    expect(fixture.paid).toEqual([100])
    yield* consume(
      yield* Effect.promise(() =>
        streamRun(
          opened.harness,
          { conversationId: opened.root.id, content: 'Pay again', requestId: 'again' },
          context,
        ),
      ),
      Option.none(),
    )
    expect(fixture.paid).toEqual([100])
    expect(
      yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context)),
    ).toMatchObject([{ kind: 'approval', callId: 'reused', input: { amount: 200 } }])
  }),
)

// Cloudflare packages/think/src/tests/submissions.test.ts: detached notify submits a follow-up turn that drains to a model response;
// detached milestone notify submits once and is idempotent across re-delivery.
it.live('a detached late answer creates one follow-up model turn across redelivery', () =>
  Effect.gen(function* () {
    const fixture = yield* shop()
    const opened = yield* fixture.open()
    const prompts: string[] = []
    opened.faux.setResponses([
      call('later', { question: 'Account?' }, 'later'),
      fauxAssistantMessage('Continuing.'),
      (request) => {
        prompts.push(modelText(request.messages))
        return fauxAssistantMessage('Using savings.')
      },
    ])
    yield* consume(
      yield* Effect.promise(() =>
        streamRun(
          opened.harness,
          { conversationId: opened.root.id, content: 'Ask', requestId: 'ask' },
          context,
        ),
      ),
      Option.none(),
    )
    yield* Effect.promise(() => opened.root.waitForIdle(context))
    const holdId = yield* hold(opened.harness, opened.root.id, 'later', context)
    yield* Effect.promise(() =>
      answer(opened.harness, opened.root.id, { holdId, output: 'savings' }, context),
    )
    yield* Effect.promise(() =>
      answer(opened.harness, opened.root.id, { holdId, output: 'savings' }, context),
    )
    yield* Effect.promise(() => opened.root.waitForIdle(context))
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('[answer to later] savings')
    expect(
      (yield* Effect.promise(() => opened.root.context(context))).entries.filter(
        (entry) => entry.kind === 'pi.user',
      ),
    ).toHaveLength(2)
    expect(yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context))).toEqual(
      [],
    )
  }),
)

// Cloudflare packages/think/src/tests/submissions.test.ts: detached notify created during an active turn drains after that turn.
it.live('a detached late answer waits behind the active run', () =>
  Effect.gen(function* () {
    const fixture = yield* shop()
    const opened = yield* fixture.open()
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const order: string[] = []
    opened.faux.setResponses([
      call('later', { question: 'Account?' }, 'later'),
      () =>
        runForPi(
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
            order.push('current')
            return fauxAssistantMessage('Current finished.')
          }),
          undefined,
        ),
      (request) => {
        expect(modelText(request.messages)).toContain('[answer to later] savings')
        order.push('delivery')
        return fauxAssistantMessage('Late finished.')
      },
    ])
    const stream = yield* Effect.promise(() =>
      streamRun(
        opened.harness,
        { conversationId: opened.root.id, content: 'Ask', requestId: 'ask' },
        context,
      ),
    )
    yield* Deferred.await(entered)
    const resolved16 = yield* hold(opened.harness, opened.root.id, 'later', context)
    yield* Effect.promise(() =>
      answer(opened.harness, opened.root.id, { holdId: resolved16, output: 'savings' }, context),
    )
    expect(order).toEqual([])
    yield* Deferred.succeed(release, undefined)
    const result = yield* consume(stream, Option.none())
    yield* Effect.promise(() => opened.root.waitForIdle(context))
    expect(texts(result.message)).toEqual(['Current finished.'])
    expect(order).toEqual(['current', 'delivery'])
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
