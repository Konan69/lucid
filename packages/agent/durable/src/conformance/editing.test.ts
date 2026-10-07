import type { AssistantMessageEvent } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from '@effect/vitest'
import { isToolUIPart, readUIMessageStream, tool } from 'ai'
import { Effect, Option, Predicate, Schema, Deferred, Fiber, Stream } from 'effect'
import { consumeReadable, ReadFailed } from '../fixtures/reading.ts'

import { z } from 'zod'
import { rawArguments } from '../arguments.ts'
import { waitForFrame } from '../fixtures/provider.ts'
import { streamRun } from '../main.ts'
import { context, host } from './fixtures/host.ts'

type Edit = 'changed' | 'shortened' | 'removed'
const decodePartial = Schema.decodeUnknownOption(Schema.Struct({ input: Schema.String }))

/** Provider argument-done replacements can change a prefix; whole updates may remove its block. */
function editFrame(event: AssistantMessageEvent, edit: Edit): AssistantMessageEvent {
  if (event.type !== 'toolcall_delta') return event
  const block = event.partial.content[event.contentIndex]
  if (block === undefined || block.type !== 'toolCall') throw new Error('Expected tool')
  const raw = rawArguments(block)
  if (
    Option.isNone(raw) ||
    !Predicate.isString(block.arguments.input) ||
    block.arguments.input.length <= 5
  )
    return event
  if (edit !== 'changed' && block.arguments.input.length > 10) return event
  const text = edit === 'changed' ? raw.value.replace('abcde', 'VWXYZ') : '{"input":"x'
  const replacement = { ...block, partialJson: text }
  return {
    ...event,
    partial: {
      ...event.partial,
      content:
        edit === 'removed'
          ? event.partial.content.filter((_part, index) => index !== event.contentIndex)
          : event.partial.content.map((part, index) =>
              index === event.contentIndex ? replacement : part,
            ),
    },
  }
}

/** A replacement reaches SQLite/SDK before the final scripted input; no stale streaming part remains. */
it.live.each(['changed', 'shortened', 'removed'] as const)(
  'handles a %s raw tool replacement honestly',
  (edit) =>
    Effect.gen(function* () {
      const release = Deferred.makeUnsafe<void>()
      const releaseEdit = Deferred.makeUnsafe<void>()
      let gated = false
      let replacing = false
      let edited = false
      const fixture = yield* host(
        {
          work: tool({
            inputSchema: z.object({ input: z.string() }),
            execute: (args) => {
              return Promise.resolve(args)
            },
          }),
        },
        {},
        { progress: { partialIntervalMs: 0 } },
        {
          partialFamily: 'anthropic',
          commitFrames: true,
          tokenSize: { min: 1, max: 1 },
          rewriteFrame: (event) => (replacing ? editFrame(event, edit) : event),
          onFrame: (event, abortSignal) => {
            if (event.type !== 'toolcall_delta') return Effect.void
            if (gated) {
              if (edit === 'changed' || edited) return Effect.void
              edited = true
              return waitForFrame(Deferred.await(releaseEdit), abortSignal)
            }
            const block = event.partial.content[event.contentIndex]
            if (block === undefined || block.type !== 'toolCall') throw new Error('Expected tool')
            if (!Predicate.isString(block.arguments.input) || block.arguments.input.length < 5)
              return Effect.void
            gated = true
            return waitForFrame(Deferred.await(release), abortSignal)
          },
        },
      )
      const opened = yield* fixture.open()
      // Failure must release both frames before the harness finalizer joins its provider.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          Deferred.doneUnsafe(release, Effect.void)
          Deferred.doneUnsafe(releaseEdit, Effect.void)
        }),
      )
      const input = { input: 'abcdefghijklmnopqrstuvwxyz'.repeat(10) }
      opened.faux.setResponses([
        fauxAssistantMessage([fauxText('Context.'), fauxToolCall('work', input, { id: 'wire' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('Done.'),
      ])
      const stream = yield* Effect.promise(() =>
        Promise.resolve(
          streamRun(
            opened.harness,
            { conversationId: opened.root.id, content: 'Work', requestId: 'edit' },
            context,
          ),
        ),
      )
      let offered = ''
      const observed = stream.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            if (chunk.type === 'tool-input-delta') offered += chunk.inputTextDelta
            if (chunk.type === 'reset-step') Deferred.doneUnsafe(releaseEdit, Effect.void)
            controller.enqueue(chunk)
          },
        }),
      )
      const [raw, folded] = observed.tee()
      const collected = yield* Effect.forkScoped(consumeReadable(raw, Option.none()))
      const visible = Deferred.makeUnsafe<void>()
      const reading = yield* Effect.forkScoped(
        Stream.runForEach(
          Stream.fromAsyncIterable(
            readUIMessageStream({ stream: folded }),
            (cause) => new ReadFailed({ cause }),
          ),
          (message) =>
            Effect.sync(() => {
              const part = message.parts.find(isToolUIPart)
              if (part === undefined || part.state !== 'input-streaming') return
              const current = decodePartial(part.input)
              if (Option.isSome(current) && current.value.input.length >= 5)
                Deferred.doneUnsafe(visible, Effect.void)
            }),
        ),
      )
      yield* Deferred.await(visible)
      const prefix = offered
      replacing = true
      Deferred.doneUnsafe(release, Effect.void)
      yield* Fiber.join(reading)
      const result = yield* Fiber.join(collected)
      expect(result.message.parts.filter(isToolUIPart)).toHaveLength(1)
      expect(result.message.parts.find(isToolUIPart)).toMatchObject({
        state: 'output-available',
        input,
      })
      const deltas = result.chunks.flatMap((chunk) =>
        chunk.type === 'tool-input-delta' ? [chunk.inputTextDelta] : [],
      )
      if (edit === 'changed') {
        expect(deltas.join('')).toBe(prefix)
        expect(result.chunks.filter((chunk) => chunk.type === 'reset-step')).toHaveLength(0)
      } else expect(result.chunks.some((chunk) => chunk.type === 'reset-step')).toBe(true)
      expect(result.chunks.filter((chunk) => chunk.type === 'tool-input-available')).toHaveLength(1)
    }),
)
