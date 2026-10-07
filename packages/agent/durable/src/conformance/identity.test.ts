import { Deferred, Effect, Option, Fiber } from 'effect'
import { FixtureFailed } from '../fixtures/harness.ts'
import { consumeReadable, hold } from '../fixtures/reading.ts'
import { runForPi } from '../pi.ts'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from '@effect/vitest'
import { defineExtension, hook, LiveDoc, ToolTask, type TaskId } from '@earendil-works/pi-durable'
import { tool } from 'ai'
import { z } from 'zod'
import * as Pi from '../pi.ts'
import type { HoldId } from '../main.ts'
import {
  CallNotWaiting,
  attachRun,
  holdId as parseHoldId,
  answer,
  continueRun,
  decide,
  respond,
  streamRun,
  waiting,
} from '../main.ts'
import { call, context, host, modelText, shop } from './fixtures/host.ts'
type Opened = Effect.Success<ReturnType<Effect.Success<ReturnType<typeof shop>>['open']>>
/** A finite initial response captures the actual durable approval id before the client decides. */
const park = Effect.fn('Test.park')(function* (opened: Opened, requestId: string) {
  return yield* consumeReadable(
    yield* Effect.promise(() =>
      streamRun(
        opened.harness,
        {
          conversationId: opened.root.id,
          content: 'Act',
          requestId,
        },
        context,
      ),
    ),
    Option.none(),
  )
})
/** Keep exactly the SDK approval wire shape, including its echoed task identity. */
function approvalBody(holdId: HoldId, messageId: string) {
  return JSON.stringify({
    messages: [
      {
        role: 'assistant',
        id: messageId,
        parts: [
          {
            type: 'tool-pay',
            toolCallId: 'reused',
            state: 'approval-responded',
            approval: { id: holdId, approved: true },
          },
        ],
      },
    ],
  })
}
/** A stale HTTP retry must not consume the hold that a successor tool task owns. */
it.live(
  'replaying the identical approval POST leaves a same-run successor unpaid and waiting',
  () =>
    Effect.gen(function* () {
      const fixture = yield* shop()
      const opened = yield* fixture.open()
      const entered = yield* Deferred.make<void, FixtureFailed>()
      const release = yield* Deferred.make<void, FixtureFailed>()
      opened.faux.setResponses([
        call('pay', { amount: 100 }, 'reused'),
        () =>
          runForPi(
            Effect.gen(function* () {
              Deferred.doneUnsafe(entered, Effect.void)
              yield* Deferred.await(release)
              return call('pay', { amount: 999 }, 'reused')
            }),
            undefined,
          ),
        fauxAssistantMessage('Done.'),
      ])
      const first = yield* park(opened, 'retry')
      const firstHold = yield* hold(opened.harness, opened.root.id, 'reused', context)
      expect(first.chunks.find((chunk) => chunk.type === 'tool-approval-request')).toMatchObject({
        approvalId: firstHold,
      })
      const body = approvalBody(firstHold, first.message.id)
      const response = yield* Effect.promise(() =>
        respond(
          opened.harness,
          opened.root.id,
          new Request('http://durable.test/chat', { method: 'POST', body }),
          context,
        ),
      )
      expect(response.status).toBe(200)
      try {
        yield* Deferred.await(entered)
        Deferred.doneUnsafe(release, Effect.void)
        expect(yield* Effect.promise(() => response.text())).toContain('tool-approval-request')
        const secondHold = yield* hold(opened.harness, opened.root.id, 'reused', context)
        expect(secondHold).not.toBe(firstHold)
        const repeated = yield* Effect.promise(() =>
          respond(
            opened.harness,
            opened.root.id,
            new Request('http://durable.test/chat', { method: 'POST', body }),
            context,
          ),
        )
        expect(repeated.status).toBe(200)
        const repeatedBody = repeated.body
        if (repeatedBody === null) throw new Error('Expected an observation stream')
        yield* Effect.promise(() => repeatedBody.cancel())
        expect(fixture.paid).toEqual([100])
        expect(
          yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context)),
        ).toMatchObject([{ holdId: secondHold, callId: 'reused', input: { amount: 999 } }])
        // A second tab changes its old decision; the first task keeps its first settlement.
        expect(
          yield* Effect.promise(() =>
            decide(
              opened.harness,
              opened.root.id,
              { holdId: firstHold, approved: false, reason: 'old tab' },
              context,
            ),
          ),
        ).toEqual({ kind: 'approved' })
        expect(fixture.paid).toEqual([100])
        yield* Effect.promise(() =>
          decide(opened.harness, opened.root.id, { holdId: secondHold, approved: false }, context),
        )
        const final = yield* consumeReadable(
          yield* Effect.promise(() =>
            continueRun(
              opened.harness,
              opened.root.id,
              { messageId: first.message.id, known: new Set(['reused']) },
              context,
            ),
          ),
          Option.some(first.message),
        )
        expect(final.chunks.some((chunk) => chunk.type === 'tool-output-denied')).toBe(true)
        expect(fixture.paid).toEqual([100])
      } finally {
        Deferred.doneUnsafe(release, Effect.void)
      }
    }),
)
/** J6: a hook can leave a plain task pending, but possessing its task id never creates a hold. */
it.live('rejects a pending plain tool task used as a hold id', () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void, FixtureFailed>()
    const release = yield* Deferred.make<void, FixtureFailed>()
    let task = Option.none<TaskId>()
    const fixture = yield* host(
      {
        plain: tool({
          inputSchema: z.object({}),
          execute: () => runForPi(Effect.succeed('done'), undefined),
        }),
      },
      {},
    )
    const opened = yield* fixture.open([
      defineExtension({
        name: 'observe-plain',
        hooks: [
          hook(ToolTask, {
            beforeTool: (_call, api, callbackContext) =>
              Pi.runForPi(
                Effect.sync(() => {
                  task = Option.some(api.taskId)
                  Deferred.doneUnsafe(entered, Effect.void)
                }).pipe(Effect.andThen(Deferred.await(release)), Effect.as(undefined)),
                callbackContext.abortSignal,
              ),
          }),
        ],
      }),
    ])
    opened.faux.setResponses([call('plain', {}, 'plain'), fauxAssistantMessage('Done.')])
    const observing = yield* consumeReadable(
      yield* Effect.promise(() =>
        streamRun(
          opened.harness,
          { conversationId: opened.root.id, content: 'Act', requestId: 'plain-task' },
          context,
        ),
      ),
      Option.none(),
    ).pipe(Effect.forkScoped({ startImmediately: true }))
    try {
      yield* Deferred.await(entered)
      const id = Option.getOrThrow(task)
      const live = yield* Effect.promise(() =>
        opened.harness.snapshot(LiveDoc, opened.root.id, context),
      )
      if (live === undefined) throw new Error('Expected pending live task')
      expect(live.tools).toMatchObject([{ taskId: id, status: 'pending' }])
      expect(yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context))).toEqual(
        [],
      )
      const rejection1 = yield* Effect.tryPromise({
        try: () =>
          decide(
            opened.harness,
            opened.root.id,
            { holdId: parseHoldId(`hold:${id}`), approved: true },
            context,
          ),
        catch: (cause) => new FixtureFailed({ cause }),
      }).pipe(Effect.flip)
      expect(rejection1.cause).toBeInstanceOf(CallNotWaiting)
      const rejection2 = yield* Effect.tryPromise({
        try: () =>
          answer(
            opened.harness,
            opened.root.id,
            { holdId: parseHoldId(`hold:${id}`), output: 'wrong' },
            context,
          ),
        catch: (cause) => new FixtureFailed({ cause }),
      }).pipe(Effect.flip)
      expect(rejection2.cause).toBeInstanceOf(CallNotWaiting)
    } finally {
      Deferred.doneUnsafe(release, Effect.void)
      yield* Fiber.join(observing)
    }
  }),
)
/** J6: snapshot presentation retains each generation's own result-task provenance for reused ids. */
it.live('replays reused call generations with their own approval ids', () =>
  Effect.gen(function* () {
    const fixture = yield* shop()
    const started = yield* Deferred.make<void, FixtureFailed>()
    let rounds = 0
    const opened = yield* fixture.open([
      defineExtension({
        name: 'observe-reused',
        hooks: [
          hook(ToolTask, {
            beforeTool: (_call, _api, callbackContext) =>
              Pi.runForPi(
                Effect.sync(() => {
                  rounds++
                  if (rounds === 2) Deferred.doneUnsafe(started, Effect.void)
                  return undefined
                }),
                callbackContext.abortSignal,
              ),
          }),
        ],
      }),
    ])
    opened.faux.setResponses([
      call('pay', { amount: 100 }, 'same'),
      call('pay', { amount: 999 }, 'same'),
      fauxAssistantMessage('Done.'),
    ])
    yield* park(opened, 'replay-generations')
    const first = yield* hold(opened.harness, opened.root.id, 'same', context)
    yield* Effect.promise(() =>
      decide(opened.harness, opened.root.id, { holdId: first, approved: false }, context),
    )
    yield* Deferred.await(started)
    const second = yield* hold(opened.harness, opened.root.id, 'same', context)
    expect(second).not.toBe(first)
    const attached = yield* Effect.promise(() => attachRun(opened.harness, opened.root.id, context))
    if (attached.status !== 'running') throw new Error('Expected waiting second generation')
    const replayed = yield* consumeReadable(attached.stream, Option.none())
    expect(replayed.chunks.filter((chunk) => chunk.type === 'tool-approval-request')).toEqual([
      { type: 'tool-approval-request', toolCallId: 'same', approvalId: first },
      { type: 'tool-approval-request', toolCallId: 'same', approvalId: second },
    ])
    expect(replayed.chunks.filter((chunk) => chunk.type === 'tool-approval-response')).toEqual([
      {
        type: 'tool-approval-response',
        approvalId: first,
        approved: false,
        reason: 'The person denied this call',
      },
    ])
    expect(replayed.chunks.filter((chunk) => chunk.type === 'tool-output-denied')).toHaveLength(1)
    expect(fixture.paid).toEqual([])
  }),
)
/** Separate tasks with a reused call id must each admit their own late-answer submission. */
it.live('delivers the second late answer when a later run reuses the call id', () =>
  Effect.gen(function* () {
    const fixture = yield* shop()
    const opened = yield* fixture.open()
    const received: string[] = []
    opened.faux.setResponses([
      call('later', { question: 'First?' }, 'x'),
      fauxAssistantMessage('Asked first.'),
      (request) => {
        received.push(modelText(request.messages))
        return fauxAssistantMessage('First answered.')
      },
      call('later', { question: 'Second?' }, 'x'),
      fauxAssistantMessage('Asked second.'),
      (request) => {
        received.push(modelText(request.messages))
        return fauxAssistantMessage('Second answered.')
      },
    ])
    yield* park(opened, 'first-question')
    yield* Effect.promise(() => opened.root.waitForIdle(context))
    const firstHold = yield* hold(opened.harness, opened.root.id, 'x', context)
    yield* Effect.promise(() =>
      answer(opened.harness, opened.root.id, { holdId: firstHold, output: 'savings' }, context),
    )
    yield* Effect.promise(() => opened.root.waitForIdle(context))
    yield* park(opened, 'second-question')
    yield* Effect.promise(() => opened.root.waitForIdle(context))
    const secondHold = yield* hold(opened.harness, opened.root.id, 'x', context)
    expect(secondHold).not.toBe(firstHold)
    yield* Effect.promise(() =>
      answer(opened.harness, opened.root.id, { holdId: secondHold, output: 'checking' }, context),
    )
    yield* Effect.promise(() => opened.root.waitForIdle(context))
    expect(received).toHaveLength(2)
    expect(received[1]).toContain('[answer to later] checking')
    expect(yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context))).toEqual(
      [],
    )
    expect(
      (yield* Effect.promise(() => opened.root.context(context))).entries.filter(
        (entry) => entry.kind === 'pi.user',
      ),
    ).toHaveLength(4)
  }),
)
/** An unanswered question is owned by its task, even while a payment reuses the same provider id. */
it.live('keeps a late question answerable after approving another task with the same call id', () =>
  Effect.gen(function* () {
    const fixture = yield* shop()
    const opened = yield* fixture.open()
    let delivered = ''
    opened.faux.setResponses([
      call('later', { question: 'Account?' }, 'x'),
      fauxAssistantMessage('Asked.'),
      call('pay', { amount: 100 }, 'x'),
      fauxAssistantMessage('Paid.'),
      (request) => {
        delivered = modelText(request.messages)
        return fauxAssistantMessage('Answered.')
      },
    ])
    yield* park(opened, 'question')
    yield* Effect.promise(() => opened.root.waitForIdle(context))
    const question = yield* hold(opened.harness, opened.root.id, 'x', context)
    yield* park(opened, 'payment')
    const rows = yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context))
    const payment = rows.find((row) => row.kind === 'approval')
    if (payment === undefined) throw new Error('Expected payment hold')
    expect(rows).toHaveLength(2)
    yield* Effect.promise(() =>
      decide(opened.harness, opened.root.id, { holdId: payment.holdId, approved: true }, context),
    )
    yield* Effect.promise(() => opened.root.waitForIdle(context))
    expect(
      yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context)),
    ).toMatchObject([{ holdId: question, kind: 'later' }])
    yield* Effect.promise(() =>
      answer(opened.harness, opened.root.id, { holdId: question, output: 'savings' }, context),
    )
    yield* Effect.promise(() => opened.root.waitForIdle(context))
    expect(delivered).toContain('[answer to later] savings')
    expect(fixture.paid).toEqual([100])
  }),
)
/** Both unsettled and settled tasks reject the wrong interaction kind. */
it.live('never returns another hold kind settlement', () =>
  Effect.gen(function* () {
    const fixture = yield* shop()
    const opened = yield* fixture.open()
    opened.faux.setResponses([
      call('pay', { amount: 100 }, 'pay'),
      fauxAssistantMessage('Paid.'),
      call('ask', { question: 'Account?' }, 'ask'),
      fauxAssistantMessage('Answered.'),
    ])
    yield* park(opened, 'pay')
    const payment = yield* hold(opened.harness, opened.root.id, 'pay', context)
    const rejection3 = yield* Effect.tryPromise({
      try: () =>
        answer(opened.harness, opened.root.id, { holdId: payment, output: 'wrong' }, context),
      catch: (cause) => new FixtureFailed({ cause }),
    }).pipe(Effect.flip)
    expect(rejection3.cause).toBeInstanceOf(CallNotWaiting)
    yield* Effect.promise(() =>
      decide(opened.harness, opened.root.id, { holdId: payment, approved: true }, context),
    )
    yield* Effect.promise(() => opened.root.waitForIdle(context))
    const rejection4 = yield* Effect.tryPromise({
      try: () =>
        answer(opened.harness, opened.root.id, { holdId: payment, output: 'wrong' }, context),
      catch: (cause) => new FixtureFailed({ cause }),
    }).pipe(Effect.flip)
    expect(rejection4.cause).toBeInstanceOf(CallNotWaiting)
    yield* park(opened, 'ask')
    const question = yield* hold(opened.harness, opened.root.id, 'ask', context)
    const rejection5 = yield* Effect.tryPromise({
      try: () =>
        decide(opened.harness, opened.root.id, { holdId: question, approved: true }, context),
      catch: (cause) => new FixtureFailed({ cause }),
    }).pipe(Effect.flip)
    expect(rejection5.cause).toBeInstanceOf(CallNotWaiting)
    yield* Effect.promise(() =>
      answer(opened.harness, opened.root.id, { holdId: question, output: 'savings' }, context),
    )
    yield* Effect.promise(() => opened.root.waitForIdle(context))
    const rejection6 = yield* Effect.tryPromise({
      try: () =>
        decide(opened.harness, opened.root.id, { holdId: question, approved: true }, context),
      catch: (cause) => new FixtureFailed({ cause }),
    }).pipe(Effect.flip)
    expect(rejection6.cause).toBeInstanceOf(CallNotWaiting)
  }),
)
/** An old tab's changed decision and the new tab's decision refer to distinct durable invocations. */
it.live('two tabs cannot cross-settle generations of the same call id', () =>
  Effect.gen(function* () {
    const fixture = yield* shop()
    const opened = yield* fixture.open()
    opened.faux.setResponses([
      call('pay', { amount: 100 }, 'reused'),
      fauxAssistantMessage('First.'),
      call('pay', { amount: 999 }, 'reused'),
      fauxAssistantMessage('Second.'),
    ])
    yield* park(opened, 'tab-one')
    const oldHold = yield* hold(opened.harness, opened.root.id, 'reused', context)
    yield* Effect.promise(() =>
      decide(opened.harness, opened.root.id, { holdId: oldHold, approved: true }, context),
    )
    yield* Effect.promise(() => opened.root.waitForIdle(context))
    yield* park(opened, 'tab-two')
    const newHold = yield* hold(opened.harness, opened.root.id, 'reused', context)
    expect(
      yield* Effect.promise(() =>
        decide(opened.harness, opened.root.id, { holdId: oldHold, approved: false }, context),
      ),
    ).toEqual({ kind: 'approved' })
    expect(
      yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context)),
    ).toMatchObject([{ holdId: newHold }])
    expect(fixture.paid).toEqual([100])
    yield* Effect.promise(() =>
      decide(
        opened.harness,
        opened.root.id,
        { holdId: newHold, approved: false, reason: 'new tab' },
        context,
      ),
    )
    yield* Effect.promise(() => opened.root.waitForIdle(context))
    expect(
      yield* Effect.promise(() =>
        decide(opened.harness, opened.root.id, { holdId: newHold, approved: true }, context),
      ),
    ).toEqual({ kind: 'denied', reason: 'new tab' })
    expect(fixture.paid).toEqual([100])
  }),
)
/** Missing or mismatched approval ids are skipped without invalidating the assistant turn. */
it.live.each(['missing', 'wrong-call', 'unknown-task'])('skips a %s approval identity', (kind) =>
  Effect.gen(function* () {
    const fixture = yield* shop()
    const opened = yield* fixture.open()
    // Separate rounds keep this focused on ownership, independent of Pi's duplicate-id guard.
    opened.faux.setResponses([call('pay', { amount: 100 }, 'reused')])
    const first = yield* park(opened, 'bad-identity')
    const holdId = yield* hold(opened.harness, opened.root.id, 'reused', context)
    const approval =
      kind === 'missing'
        ? { approved: true }
        : { id: kind === 'unknown-task' ? 'hold:99999999' : holdId, approved: true }
    const response = yield* Effect.promise(() =>
      respond(
        opened.harness,
        opened.root.id,
        new Request('http://durable.test/chat', {
          method: 'POST',
          body: JSON.stringify({
            messages: [
              {
                role: 'assistant',
                id: first.message.id,
                parts: [
                  {
                    type: 'tool-pay',
                    toolCallId: kind === 'wrong-call' ? 'other' : 'reused',
                    state: 'approval-responded',
                    approval,
                  },
                  { type: 'tool-pay', toolCallId: 'reused' },
                ],
              },
            ],
          }),
        }),
        context,
      ),
    )
    expect(response.status).toBe(200)
    const responseBody = response.body
    if (responseBody === null) throw new Error('Expected observation stream')
    yield* Effect.promise(() => responseBody.cancel())
    expect(fixture.paid).toEqual([])
    expect(
      yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context)),
    ).toMatchObject([{ holdId }])
  }),
)
/** Compaction removes model-visible task provenance; the durable receipt still answers repeats. */
it.live('keeps the first decision after compaction removes the original call', () =>
  Effect.gen(function* () {
    const fixture = yield* shop({
      compaction: {
        enabled: false,
        reserveTokens: 1000,
        keepRecentTokens: 1,
        backgroundTokens: 0,
      },
    })
    const opened = yield* fixture.open()
    opened.faux.setResponses([
      call('pay', { amount: 100 }, 'old'),
      fauxAssistantMessage('Denied.'),
      fauxAssistantMessage('A long unrelated answer. '.repeat(30)),
      fauxAssistantMessage('Summary.'),
    ])
    yield* park(opened, 'original')
    const holdId = yield* hold(opened.harness, opened.root.id, 'old', context)
    yield* Effect.promise(() =>
      decide(
        opened.harness,
        opened.root.id,
        { holdId, approved: false, reason: 'original denial' },
        context,
      ),
    )
    yield* Effect.promise(() => opened.root.waitForIdle(context))
    yield* park(opened, 'unrelated')
    yield* Effect.promise(() => opened.root.waitForIdle(context))
    const task = yield* Effect.promise(() => opened.root.compact(undefined, context))
    const result = yield* Effect.promise(() => opened.harness.waitForTask(task, context))
    expect(result.state.outcome.status).toBe('completed')
    const entries = (yield* Effect.promise(() => opened.root.context(context))).entries
    expect(
      entries.some((entry) =>
        (entry.model ?? []).some(
          (message) =>
            message.role === 'assistant' &&
            message.content.some((part) => part.type === 'toolCall' && part.id === 'old'),
        ),
      ),
    ).toBe(false)
    expect(
      yield* Effect.promise(() =>
        decide(opened.harness, opened.root.id, { holdId, approved: true }, context),
      ),
    ).toEqual({
      kind: 'denied',
      reason: 'original denial',
    })
    expect(fixture.paid).toEqual([])
  }),
)
