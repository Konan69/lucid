import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { LiveDoc } from '@earendil-works/pi-durable'
import { expect, it } from '@effect/vitest'
import { tool } from 'ai'
import { Effect } from 'effect'
import { z } from 'zod'
import { abort, streamRun } from '../main.ts'
import { context, host } from './fixtures/host.ts'

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
 * a host omitting execution declares parallel, so both starts are visible while its global-sequential response still has no committed tool slots.
 * Cancel observation and explicitly abort the isolated run after this bounded prefix.
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
      { toolExecution: 'sequential', progress: { partialIntervalMs: 1 } },
      { tokensPerSecond: 1500, tokenSize: { min: 1, max: 1 } },
    )
    const opened = await fixture.open()
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
    for await (const chunk of stream) {
      if (chunk.type !== 'tool-input-start') continue
      starts.push(chunk.toolCallId)
      if (starts.length === 2) break
    }
    const live = await opened.harness.snapshot(LiveDoc, opened.root.id, context)
    if (live === undefined || live.generation === undefined)
      throw new Error('Expected in-flight generation')
    expect(starts).toEqual(['c1', 'c2'])
    expect(live.tools ?? []).toEqual([])
    await abort(opened.harness, opened.root.id, context)
  }),
)
