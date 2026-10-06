import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import {
  defineExtension,
  hook,
  LiveDoc,
  ToolTask,
  watchEvents,
  type AgentEvent,
  type CommitPublication,
  type TaskId,
} from '@earendil-works/pi-durable'
import { tool } from 'ai'
import { expect, it, onTestFinished } from 'vitest'
import { Effect, Option } from 'effect'
import * as Pi from '../pi.ts'
import { z } from 'zod'

import { decide, streamRun, waiting } from '../main.ts'
import { consume, context, hold, host, signal } from './fixtures/host.ts'

/**
 * Pi 1.0.4 generation.tools allocates c2 in a separate commit after c1 ends, but events.translate
 * emits starts only for running slots. Observe all public channels, then append a receipt to drain
 * prior event delivery without sleeping or polling. This is evidence, not a presentation workaround.
 */
it('exposes sequential task allocation on document watches but not watchEvents', async () => {
  const atSecondHook = signal()
  const throughReceipt = signal()
  const documentSawTask = signal()
  const viewSawTask = signal()
  const fixture = await host(
    {
      pay: tool({
        inputSchema: z.object({ amount: z.number() }),
        execute: async ({ amount }) => amount,
      }),
    },
    { approval: { pay: true } },
    { toolExecution: 'sequential' },
  )
  const opened = await fixture.open([
    defineExtension({
      name: 'observe-sequential',
      hooks: [
        hook(ToolTask, {
          beforeTool: (call, api, callbackContext) =>
            Pi.runForPi(
              Effect.sync(() => {
                if (call.id === 'c2') {
                  secondTask = Option.some(api.taskId)
                  atSecondHook.resolve()
                }
                return undefined
              }),
              callbackContext.abortSignal,
            ),
        }),
      ],
    }),
  ])
  let secondTask = Option.none<TaskId>()
  opened.faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall('pay', { amount: 1 }, { id: 'c1' }),
        fauxToolCall('pay', { amount: 2 }, { id: 'c2' }),
      ],
      { stopReason: 'toolUse' },
    ),
  ])
  await consume(
    await streamRun(
      opened.harness,
      {
        conversationId: opened.root.id,
        content: 'Pay',
        requestId: 'sequential-observation',
      },
      context,
    ),
  )
  const batches: AgentEvent[][] = []
  const publications: CommitPublication[] = []
  const unsubscribe = opened.harness.subscribeCommits((publication) => {
    publications.push(publication)
  })
  onTestFinished(unsubscribe)
  const events = await watchEvents(opened.harness, opened.root.id, context)
  onTestFinished(async () => {
    await events.stop()
  })
  events.start(async (batch) => {
    batches.push([...batch])
    if (
      batch.some(
        (event) => event.type === 'entry_appended' && event.entry.kind === 'observation.receipt',
      )
    )
      throughReceipt.resolve()
  })
  const document = await opened.harness.watchDoc(LiveDoc, opened.root.id, context)
  if (document === undefined) throw new Error('Expected live document watch')
  onTestFinished(async () => {
    await document.stop()
  })
  document.start(async (live) => {
    if (
      live !== null &&
      (live.tools ?? []).some(
        (slot) => slot.callId === 'c2' && slot.taskId !== undefined && slot.status === 'pending',
      )
    )
      documentSawTask.resolve()
  })
  const view = await opened.root.watch(context)
  onTestFinished(async () => {
    await view.stop()
  })
  view.start(async (_value, ops) => {
    if (
      ops.some(
        (op) =>
          JSON.stringify(op[1]).includes('pi.live') && JSON.stringify(op[1]).includes('taskId'),
      )
    )
      viewSawTask.resolve()
  })
  await decide(
    opened.harness,
    opened.root.id,
    {
      holdId: await hold(opened.harness, opened.root.id, 'c1'),
      approved: true,
    },
    context,
  )
  await atSecondHook.promise
  await opened.root.commit(
    (tx) => tx.appendEntry(opened.root.id, { kind: 'observation.receipt' }),
    context,
  )
  await Promise.all([throughReceipt.promise, documentSawTask.promise, viewSawTask.promise])
  expect(Option.isSome(secondTask)).toBe(true)
  expect(await waiting(opened.harness, opened.root.id, context)).toMatchObject([{ callId: 'c2' }])
  const allocation = publications.find((publication) =>
    publication.changes.some(
      (change) =>
        change.type === 'task' &&
        Option.contains(secondTask, change.value.id) &&
        change.value.state.status === 'pending',
    ),
  )
  if (allocation === undefined) throw new Error('Expected allocation commit')
  expect(
    allocation.changes.some(
      (change) =>
        change.type === 'document' &&
        change.ops.some((op) => JSON.stringify(op[1]).includes('taskId')),
    ),
  ).toBe(true)
  const delivered = batches.flat()
  expect(
    delivered
      .filter((event) => event.type === 'tool_execution_start')
      .map((event) => event.toolCallId),
  ).toEqual(['c1'])
  expect(
    delivered
      .filter((event) => event.type === 'tool_execution_end')
      .map((event) => event.toolCallId),
  ).toEqual(['c1'])
  expect(delivered.some((event) => event.type === 'entry_appended')).toBe(true)
})
