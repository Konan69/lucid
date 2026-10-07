import { runForPi } from '../pi.ts'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { InboxDoc } from '@earendil-works/pi-durable'
import { expect, it } from '@effect/vitest'
import { DefaultChatTransport, tool, type UIMessage } from 'ai'
import { Deferred, Effect, Option } from 'effect'
import { z } from 'zod'
import { PlainChat } from '../fixtures/chat.ts'
import { respond } from '../main.ts'
import { call, context, host, modelText, texts } from './fixtures/host.ts'

/** Pi inbox.js:44 places steers at the post-tools boundary, while follow-ups wait for final.
 * A real pending SDK tool leaves time for a second Chat to POST; durable queue publication releases
 * the first tool, so these three host choices require no scheduler or token-rate timing assumption. */
for (const whenBusy of ['steer', 'followUp', 'default'] as const)
  it.live(`applies host ${whenBusy} policy through Chat and the native input boundary`, () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const released = yield* Deferred.make<void>()
      const admitted = yield* Deferred.make<void>()
      const fixture = yield* host(
        {
          work: tool({
            inputSchema: z.object({}),
            execute: () =>
              runForPi(
                Effect.gen(function* () {
                  yield* Deferred.succeed(entered, undefined)
                  yield* Deferred.await(released)
                  return 'worked'
                }),
                undefined,
              ),
          }),
        },
        {},
      )
      const opened = yield* fixture.open()
      // Registered after the host: release its tool before the host finalizer waits for idle.
      yield* Effect.addFinalizer(() => Deferred.succeed(released, undefined))
      let afterTools = ''
      opened.faux.setResponses([
        call('work', {}, 'work'),
        (transcript) => {
          afterTools = modelText(transcript.messages)
          return fauxAssistantMessage('First finished.')
        },
        fauxAssistantMessage('Second finished.'),
      ])
      const first = new PlainChat({ transport: opened.transport })
      const sending = first.sendMessage({ text: 'First input' })
      yield* Deferred.await(entered)
      const unsubscribe = opened.harness.subscribeCommits((publication) => {
        if (
          publication.changes.some(
            (change) =>
              change.type === 'submission' &&
              change.value.requestId === 'busy-second' &&
              change.value.status === 'queued',
          )
        )
          Deferred.doneUnsafe(admitted, Effect.void)
      })
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))
      const second = new PlainChat({
        generateId: () => 'busy-second',
        transport: new DefaultChatTransport<UIMessage>({
          api: 'http://durable.test/chat',
          fetch: (url, init) => {
            const request = new Request(url, init)
            return whenBusy === 'default'
              ? respond(opened.harness, opened.root.id, request, context)
              : respond(opened.harness, opened.root.id, { request, options: { whenBusy } }, context)
          },
        }),
      })
      const posting = second.sendMessage({ text: 'Second input' })
      yield* Deferred.await(admitted)
      const inbox = Option.getOrThrow(
        Option.fromNullishOr(
          yield* Effect.promise(() => opened.harness.snapshot(InboxDoc, opened.root.id, context)),
        ),
      )
      const item = Option.getOrThrow(
        Option.fromNullishOr(inbox.items.find((candidate) => candidate.mode !== 'write')),
      )
      expect(item.mode).toBe(whenBusy === 'default' ? 'followUp' : whenBusy)
      yield* Deferred.succeed(released, undefined)
      yield* Effect.all([Effect.promise(() => sending), Effect.promise(() => posting)], {
        concurrency: 'unbounded',
      })
      expect(first.status).toBe('ready')
      expect(second.status).toBe('ready')
      const firstMessage = Option.getOrThrow(Option.fromNullishOr(first.lastMessage))
      const secondMessage = Option.getOrThrow(Option.fromNullishOr(second.lastMessage))
      expect(texts(firstMessage)).toEqual(['First finished.'])
      expect(first.messages.filter((message) => message.role === 'assistant')).toHaveLength(1)
      expect(second.messages.filter((message) => message.role === 'assistant')).toHaveLength(1)
      if (whenBusy === 'steer') {
        expect(afterTools).toContain('Second input')
        expect(second.lastMessage).toEqual(first.lastMessage)
        expect(opened.faux.state.callCount).toBe(2)
      } else {
        expect(afterTools).not.toContain('Second input')
        expect(texts(secondMessage)).toEqual(['Second finished.'])
        expect(secondMessage.id).not.toBe(firstMessage.id)
        expect(opened.faux.state.callCount).toBe(3)
      }
    }),
  )
