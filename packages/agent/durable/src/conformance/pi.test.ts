import * as NodeChildProcess from 'node:child_process'
import * as NodeEvents from 'node:events'
import * as NodeURL from 'node:url'

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { registerStorageConformance } from '@earendil-works/pi-durable/testing'
import { tool } from 'ai'
import { describe, expect, it, onTestFinished } from 'vitest'
import { z } from 'zod'

import { attachRun, followRun, streamRun } from '../main.ts'
import { consume, context, host, modelText, signal, texts } from './fixtures/host.ts'

/**
 * Pi: packages/durable/test/memory-storage.test.ts, registerStorageConformance.
 * Each generated test keeps its upstream name from src/testing/storage-conformance.ts.
 * Use the real SQLite adapter used by recovery.test.ts, with a fresh database per case.
 * No environment conformance: this package does not supply an ExecutionEnv.
 */
registerStorageConformance({ describe, expect, it }, 'Pi SQLite storage', async (use) => {
  const storage = await openNodeSqliteStorage(':memory:')
  try {
    await use(storage)
  } finally {
    await storage.close(BACKGROUND_CONTEXT)
  }
})

// Pi packages/durable/test/harness-events.test.ts: streams a run as lifecycle events and text deltas that rebuild the answer.
it('watch before submit loses no event from an immediate response', async () => {
  const fixture = await host({}, {})
  const { harness, root, faux } = await fixture.open()
  const text = 'A complete answer with its first and last character.'
  faux.setResponses([fauxAssistantMessage(text)])
  const result = await consume(
    await streamRun(
      harness,
      { conversationId: root.id, content: 'Answer', requestId: 'instant' },
      context,
    ),
  )
  expect(result.chunks.at(0)).toMatchObject({ type: 'start', messageId: result.message.id })
  expect(result.chunks.at(-1)).toMatchObject({ type: 'finish' })
  expect(result.chunks.filter((chunk) => chunk.type === 'start')).toHaveLength(1)
  expect(texts(result.message)).toEqual([text])
})

// Pi packages/durable/test/harness-inbox.test.ts: queues busy submissions and places writes before user items at the final boundary, one follow-up per run.
it('streams a busy follow-up as its own run', async () => {
  const fixture = await host({}, {})
  const { harness, root, faux } = await fixture.open()
  const entered = signal()
  const release = signal()
  faux.setResponses([
    async () => {
      entered.resolve()
      await release.promise
      return fauxAssistantMessage('First.')
    },
    fauxAssistantMessage('Second.'),
  ])
  const first = await streamRun(
    harness,
    { conversationId: root.id, content: 'First', requestId: 'first' },
    context,
  )
  await entered.promise
  const second = streamRun(
    harness,
    { conversationId: root.id, content: 'Second', requestId: 'second' },
    context,
  )
  // submit() is asynchronous inside stream start; the model gate makes both admissions observable.
  release.resolve()
  const a = await consume(first)
  const b = await consume(await second)
  expect(texts(a.message)).toEqual(['First.'])
  expect(texts(b.message)).toEqual(['Second.'])
  expect(b.message.id).not.toBe(a.message.id)
  expect(b.chunks.filter((chunk) => chunk.type === 'start')).toHaveLength(1)
})

// Pi packages/durable/test/harness-inbox.test.ts: returns a queued submission for its repeated request ID without a second item.
it('joins repeated request ids while queued without a second model response', async () => {
  const fixture = await host({}, {})
  const { harness, root, faux } = await fixture.open()
  const entered = signal()
  const release = signal()
  let calls = 0
  faux.setResponses([
    async () => {
      entered.resolve()
      await release.promise
      return fauxAssistantMessage('First.')
    },
    () => {
      calls++
      return fauxAssistantMessage('Once.')
    },
  ])
  const first = await streamRun(
    harness,
    { conversationId: root.id, content: 'First', requestId: 'first' },
    context,
  )
  await entered.promise
  const input = { conversationId: root.id, content: 'Repeat', requestId: 'repeat' }
  const one = streamRun(harness, input, context)
  const two = streamRun(harness, input, context)
  release.resolve()
  await consume(first)
  const a = await consume(await one)
  const b = await consume(await two)
  await root.waitForIdle(context)
  expect(a.message).toEqual(b.message)
  expect(texts(a.message)).toEqual(['Once.'])
  expect(calls).toBe(1)
  expect(
    (await root.context(context)).entries.filter((entry) => entry.kind === 'pi.user'),
  ).toHaveLength(2)
})

// Pi packages/durable/test/harness-generation.test.ts: retries a retryable error after a durable backoff and then answers.
it('retries a failed partial response without duplicate parts', async () => {
  const fixture = await host({}, {})
  const { harness, root, faux } = await fixture.open()
  faux.setResponses([
    fauxAssistantMessage('Discard this partial.', {
      stopReason: 'error',
      errorMessage: '503 Service Unavailable',
    }),
    fauxAssistantMessage('Recovered.'),
  ])
  const result = await consume(
    await streamRun(
      harness,
      { conversationId: root.id, content: 'Try', requestId: 'retry' },
      context,
    ),
  )
  expect(texts(result.message)).toEqual(['Recovered.'])
  expect(result.chunks.filter((chunk) => chunk.type === 'reset-step')).toHaveLength(1)
  expect(result.chunks.filter((chunk) => chunk.type === 'error')).toEqual([])
  expect(result.chunks.filter((chunk) => chunk.type === 'start')).toHaveLength(1)
})

/** Kill only the child spawned here, after its execution signal proves the durable intent exists. */
async function crash(file: string, policy: 'safe' | 'unsafe') {
  const child = NodeChildProcess.spawn(
    process.execPath,
    [NodeURL.fileURLToPath(new URL('./fixtures/crash.ts', import.meta.url)), file, policy],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  )
  onTestFinished(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = NodeEvents.EventEmitter.once(child, 'exit')
    child.kill('SIGKILL')
    await exited
  })
  const [data] = await NodeEvents.EventEmitter.once(child.stdout, 'data')
  if (!Buffer.isBuffer(data)) throw new Error('Expected an execution signal')
  expect(data.toString()).toContain('executing')
  const exited = NodeEvents.EventEmitter.once(child, 'exit')
  child.kill('SIGKILL')
  await exited
}

// Pi packages/durable/test/harness-tools-recovery.test.ts: answers an unsafe tool interrupted after intent with its durable partial output;
// reruns a tool only when both the stored and the current replay policy are safe.
it.each(['unsafe', 'safe'] as const)(
  'reports interrupted %s tools through the public stream',
  async (policy) => {
    let executions = 0
    let prompt = ''
    const fixture = await host(
      {
        work: tool({
          description: 'Build a report',
          inputSchema: z.object({}),
          execute: async () => {
            executions++
            return '12 pages'
          },
        }),
      },
      { replay: { work: policy } },
    )
    await crash(fixture.file, policy)
    const { harness, root, faux } = await fixture.open()
    faux.setResponses([
      (request) => {
        prompt = modelText(request.messages)
        return fauxAssistantMessage('Finished.')
      },
    ])
    const attachedRun = await attachRun(harness, root.id, context)
    if (attachedRun.status === 'idle') throw new Error('Expected the interrupted run')
    harness.resume()
    const result = await consume(attachedRun.stream)
    const part = result.message.parts.find((candidate) => candidate.type === 'tool-work')
    if (policy === 'safe') {
      expect(executions).toBe(1)
      expect(part).toMatchObject({ state: 'output-available', output: '12 pages' })
      expect(prompt).toContain('12 pages')
    } else {
      expect(executions).toBe(0)
      expect(part).toMatchObject({
        state: 'output-error',
        errorText: expect.stringContaining('was interrupted and may have partially run'),
      })
      expect(prompt).toContain('was interrupted and may have partially run')
    }
    expect(texts(result.message)).toEqual(['Finished.'])
  },
)

/** A real process dies after durable tool intent; request-only recovery replays the same run. */
it('follows a host request after process restart and harness.resume', async () => {
  const fixture = await host(
    { work: tool({ inputSchema: z.object({}), execute: async () => 'recovered' }) },
    { replay: { work: 'safe' } },
  )
  await crash(fixture.file, 'safe')
  const opened = await fixture.open()
  opened.faux.setResponses([fauxAssistantMessage('Recovered host run.')])
  const stream = await followRun(opened.harness, opened.root.id, 'crash', context)
  opened.harness.resume()
  const result = await consume(stream)
  expect(texts(result.message)).toEqual(['Recovered host run.'])
  expect(result.message.parts).toContainEqual(
    expect.objectContaining({ type: 'tool-work', state: 'output-available', output: 'recovered' }),
  )
})
