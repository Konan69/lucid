import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { LiveDoc, watchEvents } from '@earendil-works/pi-durable'
import { expect, it } from '@effect/vitest'
import { tool } from 'ai'
import { Effect } from 'effect'
import { onTestFinished } from 'vitest'
import { runForPi } from '../pi.ts'
import { z } from 'zod'
import { abort, streamRun } from '../main.ts'
import { context, host, signal } from './fixtures/host.ts'

/**
 * generation.js startToolRound reads runtime.settings.toolExecution, supplied from HarnessImpl's
 * private #options. agent.js resolveAgent returns registrations, not modes defaulted
 * from settings. Prove the public agents cannot distinguish the two global modes before a round.
 */
it.live('does not expose the global execution mode through the public agent', () =>
  Effect.promise(async () => {
    const payment = tool({
      inputSchema: z.object({ amount: z.number() }),
      execute: async ({ amount }) => amount,
    })
    const sequential = await (
      await host({ pay: payment }, { approval: { pay: true } }, { toolExecution: 'sequential' })
    ).open()
    const parallel = await (
      await host({ pay: payment }, { approval: { pay: true } }, { toolExecution: 'parallel' })
    ).open()
    const first = await sequential.root.agent(context)
    const second = await parallel.root.agent(context)
    expect(first.tools.map((entry) => ({ name: entry.name, mode: entry.executionMode }))).toEqual(
      second.tools.map((entry) => ({ name: entry.name, mode: entry.executionMode })),
    )
    expect(first.tools.map((entry) => entry.executionMode)).toEqual(['parallel'])
    expect(await sequential.harness.snapshot(LiveDoc, sequential.root.id, context)).toEqual(
      await parallel.harness.snapshot(LiveDoc, parallel.root.id, context),
    )
  }),
)

/**
 * Capture the observable failing precondition without hanging sendMessage or adding it.fails:
 * A host omitting execution declares parallel. After message_end, c2 is already visible but its
 * committed sequential slot has no task, preventing parking. Observe that settled state, then abort.
 */
it.live('shows the unobservable-mode gap during slow sequential generation', () =>
  Effect.promise(async () => {
    const fixture = await host(
      {
        pay: tool({
          inputSchema: z.object({ amount: z.number() }),
          execute: async ({ amount }) => amount,
        }),
      },
      { approval: { pay: true } },
      { toolExecution: 'sequential', progress: { partialIntervalMs: 0 } },
      { commitFrames: true, tokenSize: { min: 1, max: 1 } },
    )
    const opened = await fixture.open()
    const ended = signal()
    const shown = signal()
    const events = await watchEvents(opened.harness, opened.root.id, context)
    onTestFinished(async () => {
      await events.stop()
    })
    events.start((batch) =>
      runForPi(
        Effect.sync(() => {
          if (
            batch.some(
              (event) => event.type === 'message_end' && event.entry.kind === 'pi.assistant',
            )
          )
            ended.resolve()
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
    const stream = await streamRun(
      opened.harness,
      { conversationId: opened.root.id, content: 'Pay', requestId: 'mode' },
      context,
    )
    const starts: string[] = []
    const reader = stream.getReader()
    onTestFinished(() => reader.cancel())
    let finished = false
    const drain = (async () => {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        const chunk = next.value
        if (chunk.type === 'tool-input-start') {
          starts.push(chunk.toolCallId)
          if (chunk.toolCallId === 'c2') shown.resolve()
        }
      }
      finished = true
    })()
    await ended.promise
    await shown.promise
    const live = await opened.harness.snapshot(LiveDoc, opened.root.id, context)
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
    await abort(opened.harness, opened.root.id, context)
    await drain
  }),
)
