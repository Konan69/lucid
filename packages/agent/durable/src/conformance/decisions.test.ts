import { ToolApprovalUnsupported } from '../main.ts'
import * as NodeChildProcess from 'node:child_process'
import * as NodeEvents from 'node:events'
import * as NodeURL from 'node:url'
type SdkInput = Parameters<NonNullable<ReturnType<typeof import('ai').asSchema>['validate']>>[0]
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
import { tool, isToolUIPart, lastAssistantMessageIsCompleteWithApprovalResponses } from 'ai'
import { Effect, Option, Predicate } from 'effect'
import { z } from 'zod'
import { PlainChat } from '../fixtures/chat.ts'
import { waiting, history, toolsExtension, abort, decide } from '../main.ts'
import { call, context, host, signal } from './fixtures/host.ts'

/** Hook and presentation must use identical Pi coercion and SDK defaults/transforms. */
for (const policy of ['host', 'sdk'] as const)
  for (const parsing of ['coercion', 'default', 'transform'] as const)
    it.live(`holds ${policy} approval with SDK ${parsing}`, () =>
      Effect.promise(async () => {
        const observed: number[] = []
        let executions = 0
        const schema =
          parsing === 'default'
            ? z.object({ amount: z.number().default(5) })
            : z.object({
                amount: z
                  .number()
                  .transform((value) => (parsing === 'transform' ? value * 2 : value)),
              })
        const predicate = (input: SdkInput) => {
          if (!Predicate.hasProperty(input, 'amount') || !Predicate.isNumber(input.amount))
            return false
          observed.push(input.amount)
          return input.amount > 3
        }
        const definition = tool({
          inputSchema: schema,
          needsApproval: policy === 'sdk' ? predicate : false,
          execute: async () => {
            executions++
            return 'paid'
          },
        })
        const fixture = await host(
          { pay: definition },
          policy === 'host' ? { approval: { pay: predicate } } : {},
        )
        const opened = await fixture.open()
        opened.faux.setResponses([
          call(
            'pay',
            parsing === 'default' ? {} : { amount: parsing === 'transform' ? 2 : '5' },
            'pay',
          ),
          fauxAssistantMessage('Resolved.'),
        ])
        const completed = signal()
        const chat = new PlainChat({
          transport: opened.transport,
          sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
          onFinish: () => {
            if (opened.faux.state.callCount === 2) completed.resolve()
          },
          onError: (error) => completed.reject(error),
        })
        await chat.sendMessage({ text: 'Pay' })
        const part = Option.fromNullishOr(chat.lastMessage).pipe(
          Option.map((message) => message.parts.find(isToolUIPart)),
          Option.getOrUndefined,
        )
        expect(part).toMatchObject({ state: 'approval-requested' })
        expect(await waiting(opened.harness, opened.root.id, context)).toHaveLength(1)
        expect(executions).toBe(0)
        expect(observed.every((value) => value === (parsing === 'transform' ? 4 : 5))).toBe(true)
        if (part === undefined || part.state !== 'approval-requested')
          throw new Error('Expected approval')
        await chat.addToolApprovalResponse({ id: part.approval.id, approved: true })
        await completed.promise
        expect(executions).toBe(1)
      }),
    )

/** Broken input-only policies block one call while stock Chat, history and the model remain healthy. */
for (const policy of ['host', 'sdk'] as const)
  for (const failure of ['throw', 'value', 'promise', 'options'] as const)
    it.live(`contains ${policy} approval ${failure} as a named tool error`, () =>
      Effect.promise(async () => {
        let executions = 0
        const predicate = (_input: SdkInput, options: { toolCallId: string }) => {
          if (failure === 'throw') throw new Error('Policy failed')
          if (failure === 'value') return 'yes'
          if (failure === 'promise') return Promise.reject(new Error('Unsupported promise'))
          return options.toolCallId.length > 0
        }
        const definition = tool({
          inputSchema: z.object({}),
          execute: async () => {
            executions++
            return 'paid'
          },
        })
        const options = {}
        if (policy === 'sdk')
          Object.defineProperty(definition, 'needsApproval', { value: predicate })
        else
          Object.defineProperty(options, 'approval', {
            value: { pay: predicate },
            enumerable: true,
          })
        const fixture = await host({ pay: definition }, options)
        const opened = await fixture.open()
        opened.faux.setResponses([
          call('pay', {}, 'pay'),
          (request) => {
            expect(request.messages.at(-1)).toMatchObject({ role: 'toolResult', isError: true })
            return fauxAssistantMessage('Recovered.')
          },
        ])
        const chat = new PlainChat({ transport: opened.transport })
        await chat.sendMessage({ text: 'Pay' })
        expect(chat.status).toBe('ready')
        expect(
          Option.fromNullishOr(chat.lastMessage).pipe(
            Option.map((message) => message.parts.find(isToolUIPart)),
            Option.getOrUndefined,
          ),
        ).toMatchObject({
          state: 'output-error',
          errorText: expect.stringContaining('pay'),
        })
        if (failure === 'value') {
          if (chat.lastMessage === undefined) throw new Error('Expected assistant')
          const part = chat.lastMessage.parts.find(isToolUIPart)
          expect(part).toMatchObject({
            errorText: expect.stringContaining('must return a boolean'),
          })
          if (part === undefined || !('errorText' in part)) throw new Error('Expected tool error')
          expect(part.errorText).not.toContain('asynchronous')
        }
        expect(executions).toBe(0)
        expect(await waiting(opened.harness, opened.root.id, context)).toEqual([])
        await opened.root.waitForIdle(context)
        const saved = await history(opened.harness, opened.root.id, { limit: 10 }, context)
        expect(
          Option.fromNullishOr(saved.messages.at(-1)).pipe(
            Option.map((message) => message.parts.find(isToolUIPart)),
            Option.getOrUndefined,
          ),
        ).toMatchObject({
          state: 'output-error',
        })
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

/** Durable receipts, rather than today's policy or registration, restore approval and denial history. */
for (const approved of [true, false])
  for (const changed of ['policy', 'registration', 'duplicates'] as const)
    it.live(`keeps approved=${approved} history after changing ${changed}`, () =>
      Effect.promise(async () => {
        const tools = {
          pay: tool({
            inputSchema: z.object({}),
            needsApproval: true,
            execute: async () => 'paid',
          }),
        }
        const fixture = await host(tools, {})
        const opened = await fixture.open()
        opened.faux.setResponses([call('pay', {}, 'pay'), fauxAssistantMessage('Settled.')])
        const finished = signal()
        const chat = new PlainChat({
          transport: opened.transport,
          sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
          onFinish: () => {
            if (opened.faux.state.callCount === 2) finished.resolve()
          },
          onError: (error) => finished.reject(error),
        })
        await chat.sendMessage({ text: 'Pay' })
        if (chat.lastMessage === undefined) throw new Error('Expected assistant')
        const part = chat.lastMessage.parts.find(isToolUIPart)
        if (part === undefined || part.state !== 'approval-requested')
          throw new Error('Expected approval')
        await chat.addToolApprovalResponse({
          id: part.approval.id,
          approved,
          reason: approved ? undefined : 'Budget closed',
        })
        await finished.promise
        await opened.root.waitForIdle(context)
        const expected = chat.lastMessage.parts.find(isToolUIPart)
        await fixture.close(opened.harness)
        if (changed === 'policy')
          Object.defineProperty(tools.pay, 'needsApproval', {
            value: () => {
              throw new Error('History evaluated current policy')
            },
          })
        else if (changed === 'registration') Reflect.deleteProperty(tools, 'pay')
        const observers =
          changed === 'duplicates'
            ? [
                await toolsExtension('later-duplicate', {
                  pay: tool({
                    inputSchema: z.object({}),
                    needsApproval: () => {
                      throw new Error('New duplicate policy')
                    },
                    execute: async () => 'different',
                  }),
                }),
              ]
            : []
        const reopened = await fixture.open(observers)
        const saved = await history(reopened.harness, reopened.root.id, { limit: 10 }, context)
        const assistant = saved.messages.at(-1)
        if (assistant === undefined) throw new Error('Expected history')
        expect(assistant.parts.find(isToolUIPart)).toEqual(expected)
      }),
    )

/** An impure rule violates the contract, but pull admission still trusts the hook's pinned decision. */
it.live('waiting stays exact through a pinned memo after an impure policy changes', () =>
  Effect.promise(async () => {
    let allow = true
    let policies = 0
    let executions = 0
    const fixture = await host(
      {
        pay: tool({
          inputSchema: z.object({}),
          needsApproval: () => {
            policies++
            return allow
          },
          execute: async () => {
            executions++
            return 'paid'
          },
        }),
      },
      {},
    )
    const opened = await fixture.open()
    opened.faux.setResponses([call('pay', {}, 'pay'), fauxAssistantMessage('Settled.')])
    const finished = signal()
    const chat = new PlainChat({
      transport: opened.transport,
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
      onFinish: () => {
        if (opened.faux.state.callCount === 2) finished.resolve()
      },
      onError: (error) => finished.reject(error),
    })
    await chat.sendMessage({ text: 'Pay' })
    allow = false
    const before = policies
    const rows = await waiting(opened.harness, opened.root.id, context)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'approval' })
    expect(policies).toBe(before)
    if (rows[0] === undefined) throw new Error('Expected pinned approval')
    await chat.addToolApprovalResponse({ id: rows[0].holdId, approved: true })
    await finished.promise
    expect(executions).toBe(1)
  }),
)

/** The composed agent exposes duplicate registrations even though HookApi cannot select their winner. */
it.live('fails a duplicate bridged name on first presentation without hanging', () =>
  Effect.promise(async () => {
    const first = await toolsExtension(
      'first',
      { pay: tool({ inputSchema: z.object({}), execute: async () => 'first' }) },
      { approval: { pay: true } },
    )
    const fixture = await host(
      { pay: tool({ inputSchema: z.object({}), execute: async () => 'last' }) },
      {},
    )
    const opened = await fixture.open([first])
    opened.faux.setResponses([call('pay', {}, 'pay')])
    const chat = new PlainChat({ transport: opened.transport })
    await chat.sendMessage({ text: 'Pay' })
    expect(chat.status).toBe('error')
    expect(chat.error).toMatchObject({ message: expect.stringContaining('pay') })
    await abort(opened.harness, opened.root.id, context)
    await opened.root.waitForIdle(context)
  }),
)

/** Host asynchronous declarations are rejected before a task can invoke them. */
it.live('refuses a recognized async host approval policy at registration', () =>
  Effect.promise(async () => {
    await expect(
      toolsExtension(
        'host',
        { pay: tool({ inputSchema: z.object({}), execute: async () => 'paid' }) },
        Object.defineProperty({}, 'approval', {
          value: { pay: async () => true },
          enumerable: true,
        }),
      ),
    ).rejects.toBeInstanceOf(ToolApprovalUnsupported)
  }),
)

/** Actual process death loses closures. Resume without a reader isolates hook calls from presentation.
 * A following public hook is the receipt that the bridge reused its memo and passed approval. */
it.live('pins a held decision across process death without rerunning its hook policy', () =>
  Effect.promise(async () => {
    let policies = 0
    let executions = 0
    const passed = signal()
    const fixture = await host(
      {
        pay: tool({
          inputSchema: z.object({}),
          needsApproval: () => {
            policies++
            return true
          },
          execute: async () => {
            executions++
            return 'paid'
          },
        }),
      },
      {},
    )
    const child = NodeChildProcess.spawn(
      process.execPath,
      [
        '--experimental-transform-types',
        NodeURL.fileURLToPath(new URL('./fixtures/toolsapproval.mjs', import.meta.url)),
        fixture.file,
      ],
      { stdio: ['pipe', 'pipe', 'inherit'] },
    )
    onTestFinished(async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = NodeEvents.EventEmitter.once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    })
    await Promise.race([
      NodeEvents.EventEmitter.once(child.stdout, 'data'),
      NodeEvents.EventEmitter.once(child, 'exit').then(() => {
        throw new Error('Crash fixture exited before pin')
      }),
    ])
    const exited = NodeEvents.EventEmitter.once(child, 'exit')
    expect(child.exitCode).toBeNull()
    expect(child.kill('SIGKILL')).toBe(true)
    await exited
    expect(child.signalCode).toBe('SIGKILL')
    const after = defineExtension({
      name: 'after-pin',
      hooks: [
        hook(ToolTask, {
          beforeTool: () => {
            passed.resolve()
          },
        }),
      ],
    })
    const reopened = await fixture.open([after])
    const bridge = (await reopened.root.agent(context)).extensions.find(
      (extension) => extension.name === 'conformance',
    )
    if (bridge === undefined) throw new Error('Expected bridge extension')
    await reopened.root.configure({ extensions: [bridge, after] }, context)
    reopened.faux.setResponses([fauxAssistantMessage('Recovered.')])
    const rows = await waiting(reopened.harness, reopened.root.id, context)
    expect(rows).toHaveLength(1)
    expect(policies).toBe(0)
    reopened.harness.resume()
    if (rows[0] === undefined) throw new Error('Expected durable approval')
    await decide(
      reopened.harness,
      reopened.root.id,
      { holdId: rows[0].holdId, approved: true },
      context,
    )
    await passed.promise
    expect(policies).toBe(0)
    await reopened.root.waitForIdle(context)
    expect(executions).toBe(1)
    const saved = await history(reopened.harness, reopened.root.id, { limit: 10 }, context)
    const assistant = saved.messages.at(-1)
    if (assistant === undefined) throw new Error('Expected history')
    expect(assistant.parts.find(isToolUIPart)).toMatchObject({
      state: 'output-available',
      output: 'paid',
      approval: { approved: true },
    })
    expect(policies).toBe(0)
  }),
)

/** Aborting a held task produces its existing tool error, even after the policy becomes broken. */
it.live('reads an aborted held call without evaluating the current policy', () =>
  Effect.promise(async () => {
    const definition = tool({
      inputSchema: z.object({}),
      needsApproval: true,
      execute: async () => 'paid',
    })
    const fixture = await host({ pay: definition }, {})
    const opened = await fixture.open()
    opened.faux.setResponses([call('pay', {}, 'pay')])
    const chat = new PlainChat({ transport: opened.transport })
    await chat.sendMessage({ text: 'Pay' })
    await abort(opened.harness, opened.root.id, context)
    await opened.root.waitForIdle(context)
    await fixture.close(opened.harness)
    Object.defineProperty(definition, 'needsApproval', {
      value: () => {
        throw new Error('Aborted history evaluated policy')
      },
    })
    const reopened = await fixture.open()
    const saved = await history(reopened.harness, reopened.root.id, { limit: 10 }, context)
    const assistant = saved.messages.at(-1)
    if (assistant === undefined) throw new Error('Expected aborted history')
    expect(assistant.parts.find(isToolUIPart)).toMatchObject({ state: 'output-error' })
  }),
)
