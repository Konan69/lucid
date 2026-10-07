import { expect, it } from '@effect/vitest'
import { onTestFinished } from 'vitest'
import {
  type CommitPublication,
  type TaskId,
  defineExtension,
  hook,
  ToolTask,
} from '@earendil-works/pi-durable'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { tool } from 'ai'
import { Effect, Option, Predicate } from 'effect'
import { z } from 'zod'
import { PlainChat } from '../fixtures/chat.ts'
import { abort, waiting } from '../main.ts'
import { call, context, host, signal } from './fixtures/host.ts'

/** Diagnostic evidence for B3: the established host option also hides a Pi-coerced approval hold.
 * This deliberately documents the unresolved reproduction; replace it with the recorded-decision
 * regression when the core-owned notification/phase-authority seam is available. */
it.live('reproduces B3 with the existing host approval option without using a timer', () =>
  Effect.promise(async () => {
    const entered = signal()
    const observed: unknown[] = []
    let executions = 0
    const fixture = await host(
      {
        pay: tool({
          inputSchema: z.object({ amount: z.number() }),
          execute: async () => {
            executions++
            return 'paid'
          },
        }),
      },
      {
        approval: {
          pay: (input) => {
            const amount = Predicate.hasProperty(input, 'amount') ? input.amount : undefined
            observed.push(amount)
            if (Predicate.isNumber(amount)) entered.resolve()
            return Predicate.isNumber(amount) && amount > 3
          },
        },
      },
    )
    const opened = await fixture.open()
    opened.faux.setResponses([
      call('pay', { amount: '5' }, 'pay'),
      fauxAssistantMessage('Aborted.'),
    ])
    const chat = new PlainChat({ transport: opened.transport })
    let finished = false
    const sending = chat.sendMessage({ text: 'Pay' }).then(() => {
      finished = true
    })
    await entered.promise
    expect(await waiting(opened.harness, opened.root.id, context)).toEqual([])
    expect(observed).toContain(5)
    expect(observed).toContain('5')
    expect(executions).toBe(0)
    expect(finished).toBe(false)
    await abort(opened.harness, opened.root.id, context)
    await sending
    await opened.root.waitForIdle(context)
  }),
)

/** Public getTask exposes live memos, but task-only publications cannot refresh a LiveDoc watch.
 * Pi types.ts:541–551 and scheduler.ts:1297–1301 also remove memos at terminal settlement. */
it.live('proves the public memo read and its notification and terminal limits', () =>
  Effect.promise(async () => {
    const recorded = signal()
    const release = signal()
    onTestFinished(() => release.resolve())
    let taskId = Option.none<TaskId>()
    let publication = Option.none<CommitPublication>()
    const observer = defineExtension({
      name: 'memo-probe',
      hooks: [
        hook(ToolTask, {
          beforeTool: async (_call, api, hookContext) => {
            taskId = Option.some(api.taskId)
            await api.memo('review.approval', { held: true, kind: 'approval' }, hookContext)
            recorded.resolve()
            await release.promise
            return { block: 'Memo probe complete' }
          },
        }),
      ],
    })
    const fixture = await host(
      { pay: tool({ inputSchema: z.object({}), execute: async () => 'unreachable' }) },
      {},
    )
    const opened = await fixture.open([observer])
    const unsubscribe = opened.harness.subscribeCommits((commit) => {
      if (
        commit.changes.some(
          (change) =>
            change.type === 'task' &&
            change.value.memos !== undefined &&
            Object.hasOwn(change.value.memos, 'review.approval'),
        )
      )
        publication = Option.some(commit)
    })
    onTestFinished(unsubscribe)
    opened.faux.setResponses([call('pay', {}, 'pay'), fauxAssistantMessage('Probe complete.')])
    const chat = new PlainChat({ transport: opened.transport })
    const sending = chat.sendMessage({ text: 'Probe' })
    await recorded.promise
    if (Option.isNone(taskId) || Option.isNone(publication))
      throw new Error('Expected committed memo')
    const live = await opened.harness.getTask(taskId.value, context)
    expect(live).toMatchObject({ memos: { 'review.approval': { held: true, kind: 'approval' } } })
    expect(publication.value.changes.map((change) => change.type)).toEqual(['task'])
    release.resolve()
    await sending
    await opened.root.waitForIdle(context)
    const terminal = await opened.harness.getTask(taskId.value, context)
    expect(terminal).toMatchObject({ state: { status: 'terminal' } })
    if (terminal === undefined) throw new Error('Expected terminal task')
    expect(Object.hasOwn(terminal, 'memos')).toBe(false)
  }),
)
