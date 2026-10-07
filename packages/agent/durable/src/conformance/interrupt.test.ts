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
import { Effect, Option, Predicate, Schema, Deferred } from 'effect'
import { z } from 'zod'
import { PlainChat } from '../fixtures/chat.ts'
import { waitForFrame } from '../fixtures/provider.ts'
import { abort, respond } from '../main.ts'
import { context, host } from './fixtures/host.ts'

const partial = Schema.decodeUnknownOption(Schema.Struct({ input: Schema.String }))

/** Abort after a real growing SDK input receipt closes it honestly and never loops automatic POSTs. */
it.live.each([
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
])('aborts a growing input with %s', (predicate) =>
  Effect.gen(function* () {
    const release = yield* Deferred.make<void>()
    const started = yield* Deferred.make<void>()
    let gated = false
    const ran: string[] = []
    const fixture = yield* host(
      {
        work: tool({
          inputSchema: z.object({ input: z.string() }),
          execute: ({ input }) => {
            ran.push(input)
            return Promise.resolve(input)
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
          return waitForFrame(Deferred.await(release), abortSignal)
        },
      },
    )
    const opened = yield* fixture.open()
    // Release provider gates before the scoped harness waits for its running work.
    yield* Effect.addFinalizer(() => Effect.sync(() => Deferred.doneUnsafe(release, Effect.void)))
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
        if (Option.isSome(input) && input.value.input.length >= 5)
          Deferred.doneUnsafe(started, Effect.void)
      },
    })
    const sent = chat.sendMessage({ text: 'Work' })
    yield* Deferred.await(started)
    yield* Effect.promise(() => abort(opened.harness, opened.root.id, context))
    yield* Deferred.succeed(release, undefined)
    yield* Effect.promise(() => sent)
    expect(chat.status).toBe('ready')
    expect(posts).toBe(1)
    if (chat.lastMessage === undefined) throw new Error('Expected aborted assistant')
    expect(chat.lastMessage.parts.find(isToolUIPart)).toMatchObject({
      state: 'output-error',
      errorText: 'Tool input was interrupted before it completed',
    })
    expect(ran).toEqual([])
    expect(opened.faux.state.callCount).toBe(1)
  }),
)
