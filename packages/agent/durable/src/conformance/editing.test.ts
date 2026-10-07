import type { AssistantMessageEvent } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from '@effect/vitest'
import { isToolUIPart, readUIMessageStream, tool } from 'ai'
import { Effect, Option, Predicate, Schema } from 'effect'
import { onTestFinished } from 'vitest'
import { z } from 'zod'
import { rawArguments } from '../arguments.ts'
import { waitForFrame } from '../fixtures/provider.ts'
import { streamRun } from '../main.ts'
import { consume, context, host, signal } from './fixtures/host.ts'

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
    Effect.promise(async () => {
      const release = signal()
      const releaseEdit = signal()
      let gated = false
      let replacing = false
      let edited = false
      onTestFinished(() => {
        release.resolve()
        releaseEdit.resolve()
      })
      const fixture = await host(
        {
          work: tool({
            inputSchema: z.object({ input: z.string() }),
            execute: async (args) => args,
          }),
        },
        {},
        { progress: { partialIntervalMs: 1 } },
        {
          partialFamily: 'anthropic',
          tokensPerSecond: 1500,
          tokenSize: { min: 1, max: 1 },
          rewriteFrame: (event) => (replacing ? editFrame(event, edit) : event),
          onFrame: (event, abortSignal) => {
            if (event.type !== 'toolcall_delta') return Effect.void
            if (gated) {
              if (edit === 'changed' || edited) return Effect.void
              edited = true
              return waitForFrame(
                Effect.promise(() => releaseEdit.promise),
                abortSignal,
              )
            }
            const block = event.partial.content[event.contentIndex]
            if (block === undefined || block.type !== 'toolCall') throw new Error('Expected tool')
            if (!Predicate.isString(block.arguments.input) || block.arguments.input.length < 5)
              return Effect.void
            gated = true
            return waitForFrame(
              Effect.promise(() => release.promise),
              abortSignal,
            )
          },
        },
      )
      const opened = await fixture.open()
      const input = { input: 'abcdefghijklmnopqrstuvwxyz'.repeat(10) }
      opened.faux.setResponses([
        fauxAssistantMessage([fauxText('Context.'), fauxToolCall('work', input, { id: 'wire' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('Done.'),
      ])
      const stream = await streamRun(
        opened.harness,
        { conversationId: opened.root.id, content: 'Work', requestId: 'edit' },
        context,
      )
      let offered = ''
      const observed = stream.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            if (chunk.type === 'tool-input-delta') offered += chunk.inputTextDelta
            if (chunk.type === 'reset-step') releaseEdit.resolve()
            controller.enqueue(chunk)
          },
        }),
      )
      const [raw, folded] = observed.tee()
      const collected = consume(raw)
      const visible = signal()
      const reading = (async () => {
        for await (const message of readUIMessageStream({ stream: folded })) {
          const part = message.parts.find(isToolUIPart)
          if (part === undefined || part.state !== 'input-streaming') continue
          const current = decodePartial(part.input)
          if (Option.isSome(current) && current.value.input.length >= 5) visible.resolve()
        }
      })()
      await visible.promise
      const prefix = offered
      replacing = true
      release.resolve()
      await reading
      const result = await collected
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
