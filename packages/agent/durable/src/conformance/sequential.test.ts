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
import {
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  tool,
  type DefaultChatTransport,
  type UIMessage,
} from 'ai'
import * as NodeChildProcess from 'node:child_process'
import * as NodeEvents from 'node:events'
import * as NodeURL from 'node:url'
import { PlainChat } from '../fixtures/chat.ts'
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
  expect(batches.map((batch) => batch.map((event) => event.type))).toEqual([
    ['tool_execution_start'],
    ['tool_execution_end', 'message_start', 'message_end'],
    ['entry_appended'],
  ])
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
})

/** Stock SDK automatic sending observes only admitted calls, never queued sequential inputs. */
function chatClient(transport: DefaultChatTransport<UIMessage>) {
  let completion = signal()
  const chat = new PlainChat({
    transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onFinish: () => completion.resolve(),
    onError: (error) => completion.reject(error),
  })
  return {
    chat,
    next: () => {
      completion = signal()
      return completion.promise
    },
  }
}

/** The app copies the SDK part's opaque approval identity without consulting waiting(). */
function approval(chat: PlainChat, callId: string) {
  if (chat.lastMessage === undefined) throw new Error('Expected assistant message')
  const part = chat.lastMessage.parts.find(
    (candidate) => isToolUIPart(candidate) && candidate.toolCallId === callId,
  )
  if (part === undefined || !isToolUIPart(part) || part.state !== 'approval-requested')
    throw new Error(`Expected approval for ${callId}`)
  return part.approval.id
}

/** Preserve call order and prove exactly one assistant message across automatic POSTs. */
function callParts(chat: PlainChat) {
  if (chat.lastMessage === undefined) throw new Error('Expected assistant message')
  expect(chat.messages.filter((message) => message.role === 'assistant')).toHaveLength(1)
  return chat.lastMessage.parts.filter(isToolUIPart)
}

// ai/src/ui/last-assistant-message-is-complete-with-approval-responses.ts: stock all-parts predicate.
it.each(['held-held', 'held-plain', 'plain-held', 'denied-held'] as const)(
  'automatically completes sequential %s in call order',
  async (kind) => {
    const paid: number[] = []
    const payment = tool({
      inputSchema: z.object({ amount: z.number() }),
      execute: async ({ amount }) => {
        paid.push(amount)
        return amount
      },
    })
    const fixture = await host(
      { pay: payment, plain: payment },
      { approval: { pay: true } },
      { toolExecution: 'sequential' },
    )
    const opened = await fixture.open()
    opened.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(kind === 'plain-held' ? 'plain' : 'pay', { amount: 1 }, { id: 'c1' }),
          fauxToolCall(kind === 'held-plain' ? 'plain' : 'pay', { amount: 2 }, { id: 'c2' }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('Done.'),
    ])
    const { chat, next } = chatClient(opened.transport)
    await chat.sendMessage({ text: 'Pay both' })
    if (kind !== 'plain-held') {
      expect(callParts(chat).map((part) => part.toolCallId)).toEqual(['c1'])
      const first = next()
      await chat.addToolApprovalResponse({
        id: approval(chat, 'c1'),
        approved: kind !== 'denied-held',
      })
      await first
    }
    if (kind !== 'held-plain') {
      expect(callParts(chat)).toMatchObject([
        { toolCallId: 'c1', state: kind === 'denied-held' ? 'output-denied' : 'output-available' },
        { toolCallId: 'c2', state: 'approval-requested' },
      ])
      const second = next()
      await chat.addToolApprovalResponse({ id: approval(chat, 'c2'), approved: true })
      await second
    }
    expect(paid).toEqual(kind === 'denied-held' ? [2] : [1, 2])
    expect(callParts(chat).map((part) => part.toolCallId)).toEqual(['c1', 'c2'])
    expect(callParts(chat).map((part) => part.state)).toEqual([
      kind === 'denied-held' ? 'output-denied' : 'output-available',
      'output-available',
    ])
  },
)

// HttpChatTransport.reconnectToStream GET and AbstractChat.resumeStream use the captured live snapshot.
it('GET reconnect withholds c2 while c1 waits and presents c1 result while c2 waits', async () => {
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
  const opened = await fixture.open()
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
  const { chat, next } = chatClient(opened.transport)
  await chat.sendMessage({ text: 'Pay both' })
  const first = chatClient(opened.transport).chat
  await first.resumeStream()
  expect(callParts(first)).toMatchObject([{ toolCallId: 'c1', state: 'approval-requested' }])
  expect(callParts(first)).toHaveLength(1)
  const progress = next()
  await chat.addToolApprovalResponse({ id: approval(chat, 'c1'), approved: true })
  await progress
  const second = chatClient(opened.transport).chat
  await second.resumeStream()
  expect(callParts(second)).toMatchObject([
    { toolCallId: 'c1', state: 'output-available', output: 1 },
    { toolCallId: 'c2', state: 'approval-requested' },
  ])
  const done = next()
  await chat.addToolApprovalResponse({ id: approval(chat, 'c2'), approved: true })
  await done
})

// recovery.test.ts: SIGKILL a captured child, then recover its second sequential approval with the real SDK.
it('recovers c2 after a crash without repeating c1', async () => {
  const paid: number[] = []
  const fixture = await host(
    {
      pay: tool({
        inputSchema: z.object({ amount: z.number() }),
        execute: async ({ amount }) => {
          paid.push(amount)
          return amount
        },
      }),
    },
    { approval: { pay: true } },
    { toolExecution: 'sequential' },
  )
  const child = NodeChildProcess.spawn(
    process.execPath,
    [NodeURL.fileURLToPath(new URL('../fixtures/sequential.ts', import.meta.url)), fixture.file],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  )
  onTestFinished(() => {
    child.kill('SIGKILL')
  })
  const [line] = await NodeEvents.EventEmitter.once(child.stdout, 'data')
  expect(String(line)).toContain('c2-waiting')
  const exited = NodeEvents.EventEmitter.once(child, 'exit')
  child.kill('SIGKILL')
  await exited
  const opened = await fixture.open()
  opened.faux.setResponses([fauxAssistantMessage('Done.')])
  const { chat, next } = chatClient(opened.transport)
  await chat.resumeStream()
  expect(callParts(chat)).toMatchObject([
    { toolCallId: 'c1', state: 'output-available', output: 1 },
    { toolCallId: 'c2', state: 'approval-requested' },
  ])
  const done = next()
  await chat.addToolApprovalResponse({ id: approval(chat, 'c2'), approved: true })
  await done
  expect(paid).toEqual([2])
  expect(callParts(chat).map((part) => part.state)).toEqual([
    'output-available',
    'output-available',
  ])
}, 30_000)
