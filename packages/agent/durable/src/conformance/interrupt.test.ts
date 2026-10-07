import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from '@effect/vitest'
import {
  DefaultChatTransport,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
  tool,
  type UIMessage,
} from 'ai'
import { Effect, Option, Predicate, Schema } from 'effect'
import { onTestFinished } from 'vitest'
import { z } from 'zod'
import { PlainChat } from '../fixtures/chat.ts'
import { waitForFrame } from '../fixtures/provider.ts'
import { abort, respond } from '../main.ts'
import { context, host, signal } from './fixtures/host.ts'

const partial = Schema.decodeUnknownOption(Schema.Struct({ input: Schema.String }))

/** Abort after a real growing SDK input receipt closes it honestly and never loops automatic POSTs. */
it.live.each([
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
])('aborts a growing input with %s', (predicate) =>
  Effect.promise(async () => {
    const release = signal()
    const started = signal()
    onTestFinished(() => release.resolve())
    let gated = false
    const ran: string[] = []
    const fixture = await host(
      {
        work: tool({
          inputSchema: z.object({ input: z.string() }),
          execute: async ({ input }) => {
            ran.push(input)
            return input
          },
        }),
      },
      { approval: { work: true } },
      { progress: { partialIntervalMs: 1 } },
      {
        partialFamily: 'anthropic',
        tokenSize: { min: 1, max: 1 },
        onFrame: (event, abortSignal) => {
          if (event.type !== 'toolcall_delta' || gated) return Effect.void
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
    opened.faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('work', { input: 'abcdefghijklmnopqrstuvwxyz' }, { id: 'wire' })],
        { stopReason: 'toolUse' },
      ),
    ])
    let posts = 0
    const transport = new DefaultChatTransport<UIMessage>({
      api: 'http://durable.test/chat',
      fetch: (url, init) => {
        posts += 1
        if (posts > 2) throw new Error('Unexpected automatic POST loop')
        return respond(opened.harness, opened.root.id, new Request(url, init), context)
      },
    })
    const chat = new PlainChat({
      transport,
      sendAutomaticallyWhen: predicate,
      onMessage: (message) => {
        const part = message.parts.find(isToolUIPart)
        if (part === undefined || part.state !== 'input-streaming') return
        const input = partial(part.input)
        if (Option.isSome(input) && input.value.input.length >= 5) started.resolve()
      },
    })
    const sent = chat.sendMessage({ text: 'Work' })
    await started.promise
    await abort(opened.harness, opened.root.id, context)
    release.resolve()
    await sent
    expect(chat.status).toBe('ready')
    expect(posts).toBe(predicate === lastAssistantMessageIsCompleteWithToolCalls ? 2 : 1)
    if (chat.lastMessage === undefined) throw new Error('Expected aborted assistant')
    expect(chat.lastMessage.parts.find(isToolUIPart)).toMatchObject({
      state: 'output-error',
      errorText: 'Tool input was interrupted before it completed',
    })
    expect(ran).toEqual([])
    expect(opened.faux.state.callCount).toBe(1)
  }),
)
