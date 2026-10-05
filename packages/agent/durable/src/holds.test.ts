import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
import { readUIMessageStream, tool, type UIMessage, type UIMessageChunk } from 'ai'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'

import { answer, decide } from './holds.ts'
import { continueRun, streamRun } from './stream.ts'
import { toolsExtension } from './tools.ts'
import { waiting } from './waiting.ts'

const context = BACKGROUND_CONTEXT

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

/** A SQLite file that survives a harness being closed and opened again, as a process restart does. */
async function storageFile() {
  const directory = await mkdtemp(join(tmpdir(), 'durable-holds-'))
  directories.push(directory)
  return join(directory, 'session.sqlite')
}

/**
 * The parts a process builds at start: tools, registry and a scripted model. `paid` records every
 * execution of the tool with a side effect, across restarts.
 */
async function host(paid: unknown[]) {
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const registry = createRegistry()
  registry.install(
    await toolsExtension(
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
        approval: { pay: (input) => (input as { amount: number }).amount > 100 },
        answers: { ask_later: 'later' },
      },
    ),
  )
  const open = async (file: string) => {
    const harness = await Harness.open(
      await openNodeSqliteStorage(file),
      { models, registry },
      context,
    )
    const root = await harness.root(context, {
      agent: { model: { provider: 'faux', modelId: 'faux-1' } },
    })
    return { harness, root }
  }
  return { faux, open }
}

/** Every chunk type of a stream, and the message the AI SDK's own reader builds, continuing `from`. */
async function consume(stream: ReadableStream<UIMessageChunk>, from?: UIMessage) {
  const [forTypes, forMessage] = stream.tee()
  const types: string[] = []
  const collecting = (async () => {
    for await (const chunk of forTypes) types.push(chunk.type)
  })()
  let message = from
  const reading =
    from === undefined ? { stream: forMessage } : { stream: forMessage, message: from }
  for await (const next of readUIMessageStream(reading)) message = next
  await collecting
  return { types, message }
}

const callTool = (name: string, input: Record<string, string | number>, id: string) =>
  fauxAssistantMessage([fauxToolCall(name, input, { id })], { stopReason: 'toolUse' })

/** Text of the newest message the model was given: what it reads before it answers. */
const lastText = (messages: readonly Message[]) => {
  const last = messages.at(-1)
  if (last === undefined) return ''
  return typeof last.content === 'string'
    ? last.content
    : last.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
}

it('holds a call for approval across a restart, then runs it once', async () => {
  const paid: unknown[] = []
  const file = await storageFile()
  const first = await host(paid)
  first.faux.setResponses([callTool('pay', { amount: 500 }, 'call-pay')])
  const before = await first.open(file)

  const parkedStream = await streamRun(
    before.harness,
    { conversationId: before.root.id, content: 'Pay the invoice', requestId: 'm1' },
    context,
  )
  const parkedRun = await consume(parkedStream)

  // The stream finished, the run did not: the call waits and the tool has not run.
  expect(parkedRun.types.at(-1)).toBe('finish')
  expect(parkedRun.message?.parts.find((part) => part.type === 'tool-pay')).toMatchObject({
    state: 'approval-requested',
    input: { amount: 500 },
    approval: { id: 'call-pay' },
  })
  expect(paid).toEqual([])
  expect(await waiting(before.harness, before.root.id, context)).toEqual([
    { kind: 'approval', callId: 'call-pay', toolName: 'pay', input: { amount: 500 } },
  ])

  // The process stops with the approval open. A new process builds everything again.
  await before.harness.close(context)
  const second = await host(paid)
  second.faux.setResponses([fauxAssistantMessage('Paid.')])
  const after = await second.open(file)

  expect(await waiting(after.harness, after.root.id, context)).toEqual([
    { kind: 'approval', callId: 'call-pay', toolName: 'pay', input: { amount: 500 } },
  ])
  await decide(after.harness, after.root.id, { callId: 'call-pay', approved: true }, context)
  const stream = await continueRun(after.harness, after.root.id, new Set(['call-pay']), context)
  if (stream === undefined) throw new Error('expected a run to continue')
  const finished = await consume(stream, parkedRun.message)

  expect(paid).toEqual([{ amount: 500 }])
  expect(finished.message?.parts.find((part) => part.type === 'tool-pay')).toMatchObject({
    state: 'output-available',
    output: { receipt: 'paid 500' },
  })
  expect(finished.message?.parts.filter((part) => part.type === 'text')).toEqual([
    expect.objectContaining({ text: 'Paid.' }),
  ])
  expect(await waiting(after.harness, after.root.id, context)).toEqual([])
  await after.harness.close(context)
})

it('does not hold a call the approval test lets through', async () => {
  const paid: unknown[] = []
  const { faux, open } = await host(paid)
  faux.setResponses([callTool('pay', { amount: 20 }, 'call-small'), fauxAssistantMessage('Paid.')])
  const { harness, root } = await open(await storageFile())

  const { message } = await consume(
    await streamRun(
      harness,
      { conversationId: root.id, content: 'Pay it', requestId: 'm1' },
      context,
    ),
  )

  expect(paid).toEqual([{ amount: 20 }])
  expect(message?.parts.find((part) => part.type === 'tool-pay')).toMatchObject({
    state: 'output-available',
  })
  await harness.close(context)
})

it('never runs a denied call and tells the model why', async () => {
  const paid: unknown[] = []
  const { faux, open } = await host(paid)
  let told = ''
  faux.setResponses([
    callTool('pay', { amount: 900 }, 'call-deny'),
    (request) => {
      told = lastText(request.messages)
      return fauxAssistantMessage('I did not pay.')
    },
  ])
  const { harness, root } = await open(await storageFile())

  const parkedRun = await consume(
    await streamRun(
      harness,
      { conversationId: root.id, content: 'Pay it', requestId: 'm1' },
      context,
    ),
  )
  await decide(
    harness,
    root.id,
    { callId: 'call-deny', approved: false, reason: 'Too much' },
    context,
  )
  const stream = await continueRun(harness, root.id, new Set(['call-deny']), context)
  if (stream === undefined) throw new Error('expected a run to continue')
  const finished = await consume(stream, parkedRun.message)

  expect(paid).toEqual([])
  expect(told).toContain('Too much')
  expect(finished.message?.parts.find((part) => part.type === 'tool-pay')).toMatchObject({
    state: 'output-denied',
  })
  await harness.close(context)
})

it('keeps the model inside a call until a person answers it', async () => {
  const { faux, open } = await host([])
  faux.setResponses([
    callTool('ask_person', { question: 'Which account?' }, 'call-ask'),
    (request) => fauxAssistantMessage(`Using ${lastText(request.messages)}.`),
  ])
  const { harness, root } = await open(await storageFile())

  const parkedRun = await consume(
    await streamRun(
      harness,
      { conversationId: root.id, content: 'Pay it', requestId: 'm1' },
      context,
    ),
  )
  expect(parkedRun.message?.parts.find((part) => part.type === 'tool-ask_person')).toMatchObject({
    state: 'input-available',
  })
  expect(await waiting(harness, root.id, context)).toMatchObject([
    { kind: 'answer', callId: 'call-ask' },
  ])

  await answer(harness, root.id, { callId: 'call-ask', output: 'savings' }, context)
  const stream = await continueRun(harness, root.id, new Set(['call-ask']), context)
  if (stream === undefined) throw new Error('expected a run to continue')
  const finished = await consume(stream, parkedRun.message)

  expect(finished.message?.parts.find((part) => part.type === 'tool-ask_person')).toMatchObject({
    state: 'output-available',
    output: 'savings',
  })
  expect(finished.message?.parts.filter((part) => part.type === 'text')).toEqual([
    expect.objectContaining({ text: 'Using savings.' }),
  ])
  await harness.close(context)
})

it('lets the model finish its answer and delivers a late answer as a new run', async () => {
  const { faux, open } = await host([])
  let late = ''
  faux.setResponses([
    callTool('ask_later', { question: 'Which account?' }, 'call-later'),
    fauxAssistantMessage('I asked. I will carry on with the rest.'),
    (request) => {
      late = lastText(request.messages)
      return fauxAssistantMessage('Thanks, using savings.')
    },
  ])
  const { harness, root } = await open(await storageFile())

  // The run ends by itself: the model did not wait for the answer.
  const first = await consume(
    await streamRun(
      harness,
      { conversationId: root.id, content: 'Pay it', requestId: 'm1' },
      context,
    ),
  )
  expect(first.message?.parts.filter((part) => part.type === 'text')).toEqual([
    expect.objectContaining({ text: 'I asked. I will carry on with the rest.' }),
  ])
  await root.waitForIdle(context)
  expect(await waiting(harness, root.id, context)).toEqual([
    { kind: 'later', callId: 'call-later', toolName: 'ask_later' },
  ])

  // Answering twice delivers once: the request id is the call id.
  await answer(harness, root.id, { callId: 'call-later', output: 'savings' }, context)
  await answer(harness, root.id, { callId: 'call-later', output: 'savings' }, context)
  await root.waitForIdle(context)

  expect(late).toBe('[answer to ask_later] savings')
  expect(await waiting(harness, root.id, context)).toEqual([])
  const inputs = (await root.context(context)).entries.filter((entry) => entry.kind === 'pi.user')
  expect(inputs).toHaveLength(2)
  await harness.close(context)
})
