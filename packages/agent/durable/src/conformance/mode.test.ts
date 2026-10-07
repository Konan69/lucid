import { Deferred, Effect, Fiber } from 'effect'
import { FixtureFailed } from '../fixtures/harness.ts'
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { LiveDoc, watchEvents } from '@earendil-works/pi-durable'
import { expect, it } from '@effect/vitest'
import { tool } from 'ai'
import { runForPi } from '../pi.ts'
import { z } from 'zod'
import { abort, streamRun } from '../main.ts'
import { context, host } from './fixtures/host.ts'
/**
 * generation.js startToolRound reads runtime.settings.toolExecution, supplied from HarnessImpl's
 * private #options. agent.js resolveAgent returns registrations, not modes defaulted
 * from settings. Prove the public agents cannot distinguish the two global modes before a round.
 */
it.live('does not expose the global execution mode through the public agent', () =>
  Effect.gen(function* () {
    const payment = tool({
      inputSchema: z.object({ amount: z.number() }),
      execute: ({ amount }) => runForPi(Effect.succeed(amount), undefined),
    })
    const sequential = yield* (yield* host(
      { pay: payment },
      { approval: { pay: true } },
      { toolExecution: 'sequential' },
    )).open()
    const parallel = yield* (yield* host(
      { pay: payment },
      { approval: { pay: true } },
      { toolExecution: 'parallel' },
    )).open()
    const first = yield* Effect.promise(() => sequential.root.agent(context))
    const second = yield* Effect.promise(() => parallel.root.agent(context))
    expect(first.tools.map((entry) => ({ name: entry.name, mode: entry.executionMode }))).toEqual(
      second.tools.map((entry) => ({ name: entry.name, mode: entry.executionMode })),
    )
    expect(first.tools.map((entry) => entry.executionMode)).toEqual(['parallel'])
    expect(
      yield* Effect.promise(() =>
        sequential.harness.snapshot(LiveDoc, sequential.root.id, context),
      ),
    ).toEqual(
      yield* Effect.promise(() => parallel.harness.snapshot(LiveDoc, parallel.root.id, context)),
    )
  }),
)
/**
 * Capture the observable failing precondition without hanging sendMessage or adding it.fails:
 * A host omitting execution declares parallel. After message_end, c2 is already visible but its
 * committed sequential slot has no task, preventing parking. Observe that settled state, then abort.
 */
it.live('shows the unobservable-mode gap during slow sequential generation', () =>
  Effect.gen(function* () {
    const fixture = yield* host(
      {
        pay: tool({
          inputSchema: z.object({ amount: z.number() }),
          execute: ({ amount }) => runForPi(Effect.succeed(amount), undefined),
        }),
      },
      { approval: { pay: true } },
      { toolExecution: 'sequential', progress: { partialIntervalMs: 0 } },
      { commitFrames: true, tokenSize: { min: 1, max: 1 } },
    )
    const opened = yield* fixture.open()
    const ended = yield* Deferred.make<void, FixtureFailed>()
    const shown = yield* Deferred.make<void, FixtureFailed>()
    const events = yield* Effect.promise(() => watchEvents(opened.harness, opened.root.id, context))
    yield* Effect.addFinalizer(() => Effect.promise(() => events.stop()))
    events.start((batch) =>
      runForPi(
        Effect.sync(() => {
          if (
            batch.some(
              (event) => event.type === 'message_end' && event.entry.kind === 'pi.assistant',
            )
          )
            Deferred.doneUnsafe(ended, Effect.void)
        }),
        context.abortSignal,
      ),
    )
    opened.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxText('Before '.repeat(20)),
          fauxToolCall('pay', { amount: 1 }, { id: 'c1' }),
          fauxToolCall('pay', { amount: 2 }, { id: 'c2' }),
          fauxText('After '.repeat(100)),
        ],
        { stopReason: 'toolUse' },
      ),
    ])
    const stream = yield* Effect.promise(() =>
      streamRun(
        opened.harness,
        { conversationId: opened.root.id, content: 'Pay', requestId: 'mode' },
        context,
      ),
    )
    const starts: string[] = []
    const reader = stream.getReader()
    yield* Effect.addFinalizer(() => Effect.promise(() => reader.cancel()))
    let finished = false
    const drain = yield* Effect.gen(function* () {
      for (;;) {
        const next = yield* Effect.promise(() => reader.read())
        if (next.done) break
        const chunk = next.value
        if (chunk.type === 'tool-input-start') {
          starts.push(chunk.toolCallId)
          if (chunk.toolCallId === 'c2') Deferred.doneUnsafe(shown, Effect.void)
        }
      }
      finished = true
    }).pipe(Effect.forkScoped({ startImmediately: true }))
    yield* Deferred.await(ended)
    yield* Deferred.await(shown)
    const live = yield* Effect.promise(() =>
      opened.harness.snapshot(LiveDoc, opened.root.id, context),
    )
    if (live === undefined || live.tools === undefined) throw new Error('Expected committed round')
    expect(starts).toEqual(['c1', 'c2'])
    expect(live.tools.find((slot) => slot.callId === 'c2')).toEqual({
      callId: 'c2',
      name: 'pay',
      status: 'pending',
    })
    expect(live.run).toBeDefined()
    // This records openness at the committed observation with c2 visible and unstarted; it
    // does not prove the stream would stay open indefinitely. Explicit abort supplies termination.
    expect(finished).toBe(false)
    yield* Effect.promise(() => abort(opened.harness, opened.root.id, context))
    yield* Fiber.join(drain)
  }),
)
