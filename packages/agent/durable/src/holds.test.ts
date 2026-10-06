import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Message } from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { createRegistry, Harness } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { tool } from 'ai'
import { expect, it } from '@effect/vitest'
import { Array as Arr, Effect, Option, Predicate } from 'effect'
import { z } from 'zod'

import { answer, decide, waiting, continueRun, streamRun, toolsExtension } from './core.ts'
import { consume, hold } from './fixtures/reading.ts'

const context = BACKGROUND_CONTEXT

/** Register disposable SQLite cleanup before its first write, including setup and assertion failures. */
const storageFile = Effect.fn('Test.storageFile')(function* () {
  const directory = yield* Effect.acquireRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'durable-holds-'))),
    (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
  )
  return NodePath.join(directory, 'session.sqlite')
})

/**
 * The parts a process builds at start: tools, registry and a scripted model. `paid` records every
 * execution of the tool with a side effect, across restarts.
 */
const host = Effect.fn('Test.holdHost')(function* (paid: { amount: number }[]) {
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const registry = createRegistry()
  registry.install(
    yield* toolsExtension(
      'shop',
      {
        pay: tool({
          description: 'Pay an invoice',
          inputSchema: z.object({ amount: z.number() }),
          execute: async (input) => {
            paid.push(input)
            return { receipt: `paid ${input.amount}` }
          },
        }),
        ask_person: tool({
          description: 'Ask the person a question',
          inputSchema: z.object({ question: z.string() }),
        }),
        ask_later: tool({
          description: 'Ask the person, without waiting',
          inputSchema: z.object({ question: z.string() }),
        }),
      },
      {
        approval: {
          pay: (input) =>
            Predicate.isObject(input) && Predicate.isNumber(input.amount) && input.amount > 100,
        },
        answers: { ask_later: 'later' },
      },
    ),
  )
  const open = Effect.fn('Test.openSqlite')(function* (file: string) {
    const storage = yield* Effect.promise(() => openNodeSqliteStorage(file))
    const harness = yield* Effect.acquireRelease(
      Effect.promise(() => Harness.open(storage, { models, registry }, context)),
      (opened) => Effect.promise(() => opened.close(context)),
    )
    const root = yield* Effect.promise(() =>
      harness.root(context, {
        agent: { model: { provider: 'faux', modelId: 'faux-1' } },
      }),
    )
    return { harness, root }
  })
  return { faux, open }
})

const callTool = (name: string, input: Record<string, string | number>, id: string) =>
  fauxAssistantMessage([fauxToolCall(name, input, { id })], { stopReason: 'toolUse' })

/** Text of the newest message the model was given: what it reads before it answers. */
const lastText = (messages: readonly Message[]) => {
  const last = Option.getOrThrow(Arr.last(messages))
  return Predicate.isString(last.content)
    ? last.content
    : last.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
}

it.live('holds a call for approval across a restart, then runs it once', () =>
  Effect.gen(function* () {
    const paid: { amount: number }[] = []
    const file = yield* storageFile()
    const first = yield* host(paid)
    first.faux.setResponses([callTool('pay', { amount: 500 }, 'call-pay')])
    const before = yield* first.open(file)

    const parkedStream = streamRun(
      before.harness,
      { conversationId: before.root.id, content: 'Pay the invoice', requestId: 'm1' },
      context,
    )
    const parkedRun = yield* consume(parkedStream, Option.none())

    // The stream finished, the run did not: the call waits and the tool has not run.
    expect(parkedRun.types.at(-1)).toBe('finish')
    expect(parkedRun.message.parts.find((part) => part.type === 'tool-pay')).toMatchObject({
      state: 'approval-requested',
      input: { amount: 500 },
      approval: { id: expect.stringMatching(/^hold:/u) },
    })
    expect(paid).toEqual([])
    expect(yield* waiting(before.harness, before.root.id, context)).toEqual([
      {
        holdId: expect.stringMatching(/^hold:/u),
        kind: 'approval',
        callId: 'call-pay',
        toolName: 'pay',
        input: { amount: 500 },
      },
    ])

    // The process stops with the approval open. A new process builds everything again.
    yield* Effect.promise(() => before.harness.close(context))
    const second = yield* host(paid)
    second.faux.setResponses([fauxAssistantMessage('Paid.')])
    const after = yield* second.open(file)

    expect(yield* waiting(after.harness, after.root.id, context)).toEqual([
      {
        holdId: expect.stringMatching(/^hold:/u),
        kind: 'approval',
        callId: 'call-pay',
        toolName: 'pay',
        input: { amount: 500 },
      },
    ])
    yield* decide(
      after.harness,
      after.root.id,
      { holdId: yield* hold(after.harness, after.root.id, 'call-pay', context), approved: true },
      context,
    )
    const stream = yield* continueRun(
      after.harness,
      after.root.id,
      { messageId: parkedRun.message.id, known: new Set(['call-pay']) },
      context,
    )
    const finished = yield* consume(stream, Option.some(parkedRun.message))

    expect(paid).toEqual([{ amount: 500 }])
    expect(finished.message.parts.find((part) => part.type === 'tool-pay')).toMatchObject({
      state: 'output-available',
      output: { receipt: 'paid 500' },
    })
    expect(finished.message.parts.filter((part) => part.type === 'text')).toEqual([
      expect.objectContaining({ text: 'Paid.' }),
    ])
    expect(yield* waiting(after.harness, after.root.id, context)).toEqual([])
    yield* Effect.promise(() => after.harness.close(context))
  }),
)
it.live('does not hold a call the approval test lets through', () =>
  Effect.gen(function* () {
    const paid: { amount: number }[] = []
    const { faux, open } = yield* host(paid)
    faux.setResponses([
      callTool('pay', { amount: 20 }, 'call-small'),
      fauxAssistantMessage('Paid.'),
    ])
    const { harness, root } = yield* Effect.flatMap(storageFile(), (file) => open(file))

    const { message } = yield* consume(
      streamRun(harness, { conversationId: root.id, content: 'Pay it', requestId: 'm1' }, context),
      Option.none(),
    )

    expect(paid).toEqual([{ amount: 20 }])
    expect(message.parts.find((part) => part.type === 'tool-pay')).toMatchObject({
      state: 'output-available',
    })
    yield* Effect.promise(() => harness.close(context))
  }),
)
it.live('never runs a denied call and tells the model why', () =>
  Effect.gen(function* () {
    const paid: { amount: number }[] = []
    const { faux, open } = yield* host(paid)
    let told = ''
    faux.setResponses([
      callTool('pay', { amount: 900 }, 'call-deny'),
      (request) => {
        told = lastText(request.messages)
        return fauxAssistantMessage('I did not pay.')
      },
    ])
    const { harness, root } = yield* Effect.flatMap(storageFile(), (file) => open(file))

    const parkedRun = yield* consume(
      streamRun(harness, { conversationId: root.id, content: 'Pay it', requestId: 'm1' }, context),
      Option.none(),
    )
    yield* decide(
      harness,
      root.id,
      {
        holdId: yield* hold(harness, root.id, 'call-deny', context),
        approved: false,
        reason: 'Too much',
      },
      context,
    )
    const stream = yield* continueRun(
      harness,
      root.id,
      { messageId: parkedRun.message.id, known: new Set(['call-deny']) },
      context,
    )
    const finished = yield* consume(stream, Option.some(parkedRun.message))

    expect(paid).toEqual([])
    expect(told).toContain('Too much')
    expect(finished.message.parts.find((part) => part.type === 'tool-pay')).toMatchObject({
      state: 'output-denied',
    })
    yield* Effect.promise(() => harness.close(context))
  }),
)
it.live('keeps the model inside a call until a person answers it', () =>
  Effect.gen(function* () {
    const { faux, open } = yield* host([])
    faux.setResponses([
      callTool('ask_person', { question: 'Which account?' }, 'call-ask'),
      (request) => fauxAssistantMessage(`Using ${lastText(request.messages)}.`),
    ])
    const { harness, root } = yield* Effect.flatMap(storageFile(), (file) => open(file))

    const parkedRun = yield* consume(
      streamRun(harness, { conversationId: root.id, content: 'Pay it', requestId: 'm1' }, context),
      Option.none(),
    )
    expect(parkedRun.message.parts.find((part) => part.type === 'tool-ask_person')).toMatchObject({
      state: 'input-available',
    })
    expect(yield* waiting(harness, root.id, context)).toMatchObject([
      { kind: 'answer', callId: 'call-ask' },
    ])

    yield* answer(
      harness,
      root.id,
      { holdId: yield* hold(harness, root.id, 'call-ask', context), output: 'savings' },
      context,
    )
    const stream = yield* continueRun(
      harness,
      root.id,
      { messageId: parkedRun.message.id, known: new Set(['call-ask']) },
      context,
    )
    const finished = yield* consume(stream, Option.some(parkedRun.message))

    expect(finished.message.parts.find((part) => part.type === 'tool-ask_person')).toMatchObject({
      state: 'output-available',
      output: 'savings',
    })
    expect(finished.message.parts.filter((part) => part.type === 'text')).toEqual([
      expect.objectContaining({ text: 'Using savings.' }),
    ])
    yield* Effect.promise(() => harness.close(context))
  }),
)
it.live('lets the model finish its answer and delivers a late answer as a new run', () =>
  Effect.gen(function* () {
    const { faux, open } = yield* host([])
    let late = ''
    faux.setResponses([
      callTool('ask_later', { question: 'Which account?' }, 'call-later'),
      fauxAssistantMessage('I asked. I will carry on with the rest.'),
      (request) => {
        late = lastText(request.messages)
        return fauxAssistantMessage('Thanks, using savings.')
      },
    ])
    const { harness, root } = yield* Effect.flatMap(storageFile(), (file) => open(file))

    // The run ends by itself: the model did not wait for the answer.
    const first = yield* consume(
      streamRun(harness, { conversationId: root.id, content: 'Pay it', requestId: 'm1' }, context),
      Option.none(),
    )
    expect(first.message.parts.filter((part) => part.type === 'text')).toEqual([
      expect.objectContaining({ text: 'I asked. I will carry on with the rest.' }),
    ])
    yield* Effect.promise(() => root.waitForIdle(context))
    expect(yield* waiting(harness, root.id, context)).toEqual([
      {
        holdId: expect.stringMatching(/^hold:/u),
        kind: 'later',
        callId: 'call-later',
        toolName: 'ask_later',
      },
    ])

    // Repeating this exact hold delivers once; a successor task has its own request id.
    const holdId = yield* hold(harness, root.id, 'call-later', context)
    yield* answer(harness, root.id, { holdId, output: 'savings' }, context)
    yield* answer(harness, root.id, { holdId, output: 'savings' }, context)
    yield* Effect.promise(() => root.waitForIdle(context))

    expect(late).toBe('[answer to ask_later] savings')
    expect(yield* waiting(harness, root.id, context)).toEqual([])
    const inputs = (yield* Effect.promise(() => root.context(context))).entries.filter(
      (entry) => entry.kind === 'pi.user',
    )
    expect(inputs).toHaveLength(2)
    yield* Effect.promise(() => harness.close(context))
  }),
)
