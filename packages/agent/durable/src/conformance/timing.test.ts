import { expect, it } from '@effect/vitest'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { defineExtension, GenerationTask, hook } from '@earendil-works/pi-durable'
import { tool } from 'ai'
import { Effect, Option, Schema } from 'effect'
import { z } from 'zod'
import * as Core from '../core.ts'
import { continueRun, decide, history, streamRun, waiting } from '../main.ts'
import { consumeReadable } from '../fixtures/reading.ts'
import { call, context, host } from './fixtures/host.ts'

const decodeMetadata = Schema.decodeUnknownSync(Core.Metadata)

/** Pi 1.1.0 CHANGELOG Added (#10549): public afterResponse hooks can retain
 * deterministic response timings; real execute timings are compared to their
 * persisted records. Reused provider ids must retain separate attempt entries. */
it.live('carries each response and tool duration through live and both history APIs', () =>
  Effect.gen(function* () {
    const fixture = yield* host(
      {
        work: tool({
          inputSchema: z.object({}),
          execute: () => Promise.resolve('done'),
        }),
      },
      {},
    )
    let response = 0
    const opened = yield* fixture.open([
      defineExtension({
        name: 'timing',
        hooks: [
          hook(GenerationTask, {
            afterResponse: (message) => {
              message.durationMs = ++response * 125
            },
          }),
        ],
      }),
    ])
    opened.faux.setResponses([
      call('work', {}, 'reused'),
      call('work', {}, 'reused'),
      fauxAssistantMessage('Finished.'),
    ])
    const streamed = yield* consumeReadable(
      yield* Effect.promise(() =>
        streamRun(
          opened.harness,
          { conversationId: opened.root.id, content: 'Work twice', requestId: 'timed' },
          context,
        ),
      ),
      Option.none(),
    )
    yield* Effect.promise(() => opened.root.waitForIdle(context))
    const raw = yield* Effect.promise(() =>
      opened.root.entries({ order: 'ascending' }, 100, undefined, context),
    )
    const responses = raw.items.flatMap((entry) =>
      (entry.model ?? []).flatMap((message) =>
        message.role === 'assistant' ? [{ entryId: entry.id, durationMs: message.durationMs }] : [],
      ),
    )
    const tools = raw.items.flatMap((entry) =>
      (entry.model ?? []).flatMap((message) =>
        message.role === 'toolResult'
          ? [
              {
                entryId: entry.id,
                toolCallId: message.toolCallId,
                toolName: message.toolName,
                durationMs: message.durationMs,
              },
            ]
          : [],
      ),
    )
    expect(responses.map((item) => item.durationMs)).toEqual([125, 250, 375])
    expect(tools).toHaveLength(2)
    expect(tools.map((item) => item.toolCallId)).toEqual(['reused', 'reused'])
    for (const item of tools) expect(item.durationMs).toBeGreaterThanOrEqual(0)
    const metadata = decodeMetadata(streamed.message.metadata)
    expect(metadata.responses).toEqual(responses)
    expect(metadata.tools).toEqual(tools)
    const promise = yield* Effect.promise(() =>
      history(opened.harness, opened.root.id, { limit: 10 }, context),
    )
    const core = yield* Core.history(
      opened.harness,
      opened.root.id,
      { limit: 10, before: Option.none() },
      context,
    )
    for (const page of [promise, core]) {
      const assistant = page.messages.find((message) => message.role === 'assistant')
      if (assistant === undefined) throw new Error('Expected stored assistant')
      expect(assistant.metadata).toEqual(metadata)
    }
    yield* fixture.close(opened.harness)
    const restarted = yield* fixture.open()
    const saved = yield* Effect.promise(() =>
      history(restarted.harness, restarted.root.id, { limit: 10 }, context),
    )
    expect(saved.messages).toEqual(promise.messages)
  }),
)

/** Pi 1.1.0 CHANGELOG Added (#10549): legacy/native messages and calls denied
 * before execute have no duration. Neither API may invent zero for them. */
it.live('omits absent response and unexecuted tool timings', () =>
  Effect.gen(function* () {
    let executions = 0
    const fixture = yield* host(
      {
        work: tool({
          inputSchema: z.object({}),
          execute: () => {
            executions++
            return Promise.resolve('done')
          },
        }),
      },
      { approval: { work: true } },
    )
    const opened = yield* fixture.open([
      defineExtension({
        name: 'untimed',
        hooks: [
          hook(GenerationTask, {
            afterResponse: (message) => {
              delete message.durationMs
            },
          }),
        ],
      }),
    ])
    opened.faux.setResponses([call('work', {}, 'denied'), fauxAssistantMessage('Untimed.')])
    const streamed = yield* consumeReadable(
      yield* Effect.promise(() =>
        streamRun(
          opened.harness,
          { conversationId: opened.root.id, content: 'Reply', requestId: 'untimed' },
          context,
        ),
      ),
      Option.none(),
    )
    const held = (yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context)))[0]
    if (held === undefined) throw new Error('Expected approval')
    yield* Effect.promise(() =>
      decide(
        opened.harness,
        opened.root.id,
        { holdId: held.holdId, approved: false, reason: 'No' },
        context,
      ),
    )
    const closed = yield* consumeReadable(
      yield* Effect.promise(() =>
        continueRun(
          opened.harness,
          opened.root.id,
          { messageId: streamed.message.id, known: new Set(['denied']) },
          context,
        ),
      ),
      Option.some(streamed.message),
    )
    expect(executions).toBe(0)
    const metadata = decodeMetadata(closed.message.metadata)
    expect(metadata).not.toHaveProperty('responses')
    expect(metadata).not.toHaveProperty('tools')
    const page = yield* Core.history(
      opened.harness,
      opened.root.id,
      { limit: 10, before: Option.none() },
      context,
    )
    const assistant = page.messages.find((message) => message.role === 'assistant')
    if (assistant === undefined) throw new Error('Expected stored assistant')
    expect(assistant.metadata).toEqual(metadata)
  }),
)
