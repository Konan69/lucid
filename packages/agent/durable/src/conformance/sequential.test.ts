import { FixtureFailed } from '../fixtures/harness.ts'
import { consumeReadable as consume, hold } from '../fixtures/reading.ts'
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
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
import { expect, it } from '@effect/vitest'
import { Effect, Option, Deferred } from 'effect'
import * as Pi from '../pi.ts'
import { z } from 'zod'

import { decide, streamRun, waiting } from '../main.ts'
import { context, host } from './fixtures/host.ts'
import { providerFamilies } from '../fixtures/provider.ts'

/**
 * Pi 1.0.4 generation.tools allocates c2 in a separate commit after c1 ends, but events.translate
 * emits starts only for running slots. Observe all public channels, then append a receipt to drain
 * prior event delivery without sleeping or polling. This is evidence, not a presentation workaround.
 */
it.live('exposes sequential task allocation on document watches but not watchEvents', () =>
  Effect.gen(function* () {
    const atSecondHook = yield* Deferred.make<void>()
    const throughReceipt = yield* Deferred.make<void>()
    const documentSawTask = yield* Deferred.make<void>()
    const viewSawTask = yield* Deferred.make<void>()
    const fixture = yield* host(
      {
        pay: tool({
          inputSchema: z.object({ amount: z.number() }),
          execute: ({ amount }) => Promise.resolve(amount),
        }),
      },
      { execution: 'sequential', approval: { pay: true } },
      { toolExecution: 'sequential' },
    )
    const opened = yield* fixture.open([
      defineExtension({
        name: 'observe-sequential',
        hooks: [
          hook(ToolTask, {
            beforeTool: (call, api, callbackContext) =>
              Pi.runForPi(
                Effect.sync(() => {
                  if (call.id === 'c2') {
                    secondTask = Option.some(api.taskId)
                    Deferred.doneUnsafe(atSecondHook, Effect.void)
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
    yield* consume(
      yield* Effect.promise(() =>
        streamRun(
          opened.harness,
          {
            conversationId: opened.root.id,
            content: 'Pay',
            requestId: 'sequential-observation',
          },
          context,
        ),
      ),
      Option.none(),
    )
    const batches: AgentEvent[][] = []
    const publications: CommitPublication[] = []
    const unsubscribe = opened.harness.subscribeCommits((publication) => {
      publications.push(publication)
    })
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))
    const events = yield* Effect.promise(() => watchEvents(opened.harness, opened.root.id, context))
    yield* Effect.addFinalizer(() => Effect.promise(() => events.stop()))
    events.start((batch) => {
      batches.push([...batch])
      if (
        batch.some(
          (event) => event.type === 'entry_appended' && event.entry.kind === 'observation.receipt',
        )
      )
        Deferred.doneUnsafe(throughReceipt, Effect.void)
      return Promise.resolve()
    })
    const document = yield* Effect.promise(() =>
      opened.harness.watchDoc(LiveDoc, opened.root.id, context),
    )
    if (document === undefined) throw new Error('Expected live document watch')
    yield* Effect.addFinalizer(() => Effect.promise(() => document.stop()))
    document.start((live) => {
      if (
        live !== null &&
        (live.tools ?? []).some(
          (slot) => slot.callId === 'c2' && slot.taskId !== undefined && slot.status === 'pending',
        )
      )
        Deferred.doneUnsafe(documentSawTask, Effect.void)
      return Promise.resolve()
    })
    const view = yield* Effect.promise(() => opened.root.watch(context))
    yield* Effect.addFinalizer(() => Effect.promise(() => view.stop()))
    view.start((_value, ops) => {
      if (
        ops.some(
          (op) =>
            JSON.stringify(op[1]).includes('pi.live') && JSON.stringify(op[1]).includes('taskId'),
        )
      )
        Deferred.doneUnsafe(viewSawTask, Effect.void)
      return Promise.resolve()
    })
    const resolved2 = yield* hold(opened.harness, opened.root.id, 'c1', context)
    yield* Effect.promise(() =>
      decide(
        opened.harness,
        opened.root.id,
        {
          holdId: resolved2,
          approved: true,
        },
        context,
      ),
    )
    yield* Deferred.await(atSecondHook)
    yield* Effect.promise(() =>
      opened.root.commit(
        (tx) => tx.appendEntry(opened.root.id, { kind: 'observation.receipt' }),
        context,
      ),
    )
    yield* Effect.all(
      [
        Deferred.await(throughReceipt),
        Deferred.await(documentSawTask),
        Deferred.await(viewSawTask),
      ],
      { concurrency: 'unbounded' },
    )
    expect(Option.isSome(secondTask)).toBe(true)
    expect(
      yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context)),
    ).toMatchObject([{ callId: 'c2' }])
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
  }),
)

/** Stock SDK automatic sending observes only admitted calls, never queued sequential inputs. */
function chatClient(transport: DefaultChatTransport<UIMessage>) {
  let completion = Deferred.makeUnsafe<void, FixtureFailed>()
  const chat = new PlainChat({
    transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onFinish: () => Deferred.doneUnsafe(completion, Effect.void),
    onError: (error) =>
      Deferred.doneUnsafe(completion, Effect.fail(new FixtureFailed({ cause: error }))),
  })
  return {
    chat,
    next: () => {
      completion = Deferred.makeUnsafe<void, FixtureFailed>()
      return Deferred.await(completion)
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
it.live.each(['held-held', 'held-plain', 'plain-held', 'denied-held'] as const)(
  'automatically completes sequential %s in call order',
  (kind) =>
    Effect.gen(function* () {
      const paid: number[] = []
      const payment = tool({
        inputSchema: z.object({ amount: z.number() }),
        execute: ({ amount }) => {
          paid.push(amount)
          return Promise.resolve(amount)
        },
      })
      const fixture = yield* host(
        { pay: payment, plain: payment },
        { execution: 'sequential', approval: { pay: true } },
        { toolExecution: 'sequential' },
      )
      const opened = yield* fixture.open()
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
      yield* Effect.promise(() => chat.sendMessage({ text: 'Pay both' }))
      if (kind !== 'plain-held') {
        expect(callParts(chat).map((part) => part.toolCallId)).toEqual(['c1'])
        const first = next()
        yield* Effect.promise(() =>
          Promise.resolve(
            chat.addToolApprovalResponse({
              id: approval(chat, 'c1'),
              approved: kind !== 'denied-held',
            }),
          ),
        )
        yield* first
      }
      if (kind !== 'held-plain') {
        expect(callParts(chat)).toMatchObject([
          {
            toolCallId: 'c1',
            state: kind === 'denied-held' ? 'output-denied' : 'output-available',
          },
          { toolCallId: 'c2', state: 'approval-requested' },
        ])
        const second = next()
        yield* Effect.promise(() =>
          Promise.resolve(
            chat.addToolApprovalResponse({ id: approval(chat, 'c2'), approved: true }),
          ),
        )
        yield* second
      }
      expect(paid).toEqual(kind === 'denied-held' ? [2] : [1, 2])
      expect(callParts(chat).map((part) => part.toolCallId)).toEqual(['c1', 'c2'])
      expect(callParts(chat).map((part) => part.state)).toEqual([
        kind === 'denied-held' ? 'output-denied' : 'output-available',
        'output-available',
      ])
    }),
)

const families = providerFamilies
const streamingRounds = [
  { kind: 'held-held', execution: 'sequential', override: false, round: 'sequential' },
  { kind: 'held-plain', execution: 'sequential', override: false, round: 'sequential' },
  { kind: 'plain-held', execution: 'sequential', override: false, round: 'sequential' },
  { kind: 'held-held', execution: 'parallel', override: true, round: 'sequential' },
  { kind: 'held-held', execution: 'parallel', override: false, round: 'parallel' },
] as const

/** Slow provider scratch updates must never expose a queued successor to the stock predicate. */
for (const partialFamily of families)
  it.live.each(streamingRounds)(
    `streams $execution $kind with override=$override through ${partialFamily} in one assistant`,
    ({ kind, execution, override, round }) =>
      Effect.gen(function* () {
        const paid: number[] = []
        const payment = tool({
          inputSchema: z.object({ amount: z.number() }),
          execute: ({ amount }) => {
            paid.push(amount)
            return Promise.resolve(amount)
          },
        })
        const fixture = yield* host(
          { pay: payment, plain: payment },
          { execution, sequential: override ? ['pay'] : [], approval: { pay: true } },
          { toolExecution: execution, progress: { partialIntervalMs: 0 } },
          { partialFamily, commitFrames: true, tokenSize: { min: 1, max: 1 } },
        )
        const opened = yield* fixture.open()
        expect(
          (yield* Effect.promise(() => opened.root.agent(context))).tools.map(
            (entry) => entry.executionMode,
          ),
        ).toEqual([override ? 'sequential' : execution, execution])
        opened.faux.setResponses([
          fauxAssistantMessage(
            [
              fauxText('Before '.repeat(20)),
              fauxToolCall(kind === 'plain-held' ? 'plain' : 'pay', { amount: 1 }, { id: 'c1' }),
              fauxToolCall(kind === 'held-plain' ? 'plain' : 'pay', { amount: 2 }, { id: 'c2' }),
              fauxText('After '.repeat(20)),
            ],
            { stopReason: 'toolUse' },
          ),
          fauxAssistantMessage('Done.'),
        ])
        const { chat, next } = chatClient(opened.transport)
        yield* Effect.promise(() => chat.sendMessage({ text: 'Pay both' }))
        if (round === 'parallel') {
          expect(callParts(chat).map((part) => part.toolCallId)).toEqual(['c1', 'c2'])
          const message = chat.lastMessage
          if (message === undefined) throw new Error('Expected an assistant message')
          expect(message.parts.map((part) => part.type)).toEqual([
            'step-start',
            'text',
            'tool-pay',
            'tool-pay',
            'text',
          ])
          const done = next()
          yield* Effect.promise(() =>
            Promise.resolve(
              chat.addToolApprovalResponse({ id: approval(chat, 'c1'), approved: true }),
            ),
          )
          yield* Effect.promise(() =>
            Promise.resolve(
              chat.addToolApprovalResponse({ id: approval(chat, 'c2'), approved: true }),
            ),
          )
          yield* done
        } else {
          if (kind !== 'plain-held') {
            expect(callParts(chat).map((part) => part.toolCallId)).toEqual(['c1'])
            const done = next()
            yield* Effect.promise(() =>
              Promise.resolve(
                chat.addToolApprovalResponse({ id: approval(chat, 'c1'), approved: true }),
              ),
            )
            yield* done
          }
          if (kind !== 'held-plain') {
            expect(callParts(chat)).toMatchObject([
              { toolCallId: 'c1', state: 'output-available' },
              { toolCallId: 'c2', state: 'approval-requested' },
            ])
            const done = next()
            yield* Effect.promise(() =>
              Promise.resolve(
                chat.addToolApprovalResponse({ id: approval(chat, 'c2'), approved: true }),
              ),
            )
            yield* done
          }
        }
        expect(paid).toEqual([1, 2])
        expect(callParts(chat).map((part) => part.toolCallId)).toEqual(['c1', 'c2'])
        expect(callParts(chat).map((part) => part.state)).toEqual([
          'output-available',
          'output-available',
        ])
      }),
  )

// HttpChatTransport.reconnectToStream GET and AbstractChat.resumeStream use the captured live snapshot.
it.live('GET reconnect withholds c2 while c1 waits and presents c1 result while c2 waits', () =>
  Effect.gen(function* () {
    const fixture = yield* host(
      {
        pay: tool({
          inputSchema: z.object({ amount: z.number() }),
          execute: ({ amount }) => Promise.resolve(amount),
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
    const { chat, next } = chatClient(opened.transport)
    yield* Effect.promise(() => chat.sendMessage({ text: 'Pay both' }))
    const first = chatClient(opened.transport).chat
    yield* Effect.promise(() => first.resumeStream())
    expect(callParts(first)).toMatchObject([{ toolCallId: 'c1', state: 'approval-requested' }])
    expect(callParts(first)).toHaveLength(1)
    const progress = next()
    yield* Effect.promise(() =>
      Promise.resolve(chat.addToolApprovalResponse({ id: approval(chat, 'c1'), approved: true })),
    )
    yield* progress
    const second = chatClient(opened.transport).chat
    yield* Effect.promise(() => second.resumeStream())
    expect(callParts(second)).toMatchObject([
      { toolCallId: 'c1', state: 'output-available', output: 1 },
      { toolCallId: 'c2', state: 'approval-requested' },
    ])
    const done = next()
    yield* Effect.promise(() =>
      Promise.resolve(chat.addToolApprovalResponse({ id: approval(chat, 'c2'), approved: true })),
    )
    yield* done
  }),
)

// recovery.test.ts: SIGKILL a captured child, then recover its second sequential approval with the real SDK.
it.live(
  'recovers c2 after a crash without repeating c1',
  () =>
    Effect.gen(function* () {
      const paid: number[] = []
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
        { execution: 'sequential', approval: { pay: true } },
        { toolExecution: 'sequential' },
      )
      const child = NodeChildProcess.spawn(
        process.execPath,
        [
          NodeURL.fileURLToPath(new URL('../fixtures/sequential.ts', import.meta.url)),
          fixture.file,
        ],
        { stdio: ['ignore', 'pipe', 'inherit'] },
      )
      // Register the exit listener before killing this captured child; storage cleanup follows death.
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          if (child.exitCode !== null || child.signalCode !== null) return
          const exited = NodeEvents.EventEmitter.once(child, 'exit')
          child.kill('SIGKILL')
          yield* Effect.promise(() => exited)
        }),
      )
      const [line] = yield* Effect.promise(() => NodeEvents.EventEmitter.once(child.stdout, 'data'))
      expect(String(line)).toContain('c2-waiting')
      const exited = NodeEvents.EventEmitter.once(child, 'exit')
      child.kill('SIGKILL')
      yield* Effect.promise(() => exited)
      const opened = yield* fixture.open()
      opened.faux.setResponses([fauxAssistantMessage('Done.')])
      const { chat, next } = chatClient(opened.transport)
      yield* Effect.promise(() => chat.resumeStream())
      expect(callParts(chat)).toMatchObject([
        { toolCallId: 'c1', state: 'output-available', output: 1 },
        { toolCallId: 'c2', state: 'approval-requested' },
      ])
      const done = next()
      yield* Effect.promise(() =>
        Promise.resolve(chat.addToolApprovalResponse({ id: approval(chat, 'c2'), approved: true })),
      )
      yield* done
      expect(paid).toEqual([2])
      expect(callParts(chat).map((part) => part.state)).toEqual([
        'output-available',
        'output-available',
      ])
    }),
  30_000,
)
