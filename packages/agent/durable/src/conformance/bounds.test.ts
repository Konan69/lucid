import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from '@effect/vitest'
import { Effect, Option, Stream } from 'effect'
import { tool } from 'ai'
import { z } from 'zod'
import { abort, continueRun, respond, streamRun, RunMissing } from '../main.ts'
import { consumeReadable, ReadFailed } from '../fixtures/reading.ts'
import { call, context, host } from './fixtures/host.ts'

/** Each turn has another generation task; a closed run still owns calls of all its turns. */
it.live(
  'locates each known-call subset in a second-turn abort without borrowing the next run',
  () =>
    Effect.gen(function* () {
      const fixture = yield* host(
        {
          work: tool({ inputSchema: z.object({}), execute: () => Promise.resolve('worked') }),
          pay: tool({ inputSchema: z.object({}), execute: () => Promise.resolve('paid') }),
        },
        { approval: { pay: true } },
      )
      const opened = yield* fixture.open()
      opened.faux.setResponses([
        call('work', {}, 'a'),
        call('pay', {}, 'b'),
        fauxAssistantMessage('Next'),
      ])
      const first = yield* consumeReadable(
        yield* Effect.promise(() =>
          streamRun(
            opened.harness,
            { conversationId: opened.root.id, content: 'First', requestId: 'first' },
            context,
          ),
        ),
        Option.none(),
      )
      yield* Effect.promise(() => abort(opened.harness, opened.root.id, context))
      yield* consumeReadable(
        yield* Effect.promise(() =>
          streamRun(
            opened.harness,
            { conversationId: opened.root.id, content: 'Next', requestId: 'next' },
            context,
          ),
        ),
        Option.none(),
      )
      for (const known of [['a'], ['b'], ['a', 'b']]) {
        const stream = yield* Effect.promise(() =>
          continueRun(
            opened.harness,
            opened.root.id,
            { messageId: first.message.id, known: new Set(known) },
            context,
          ),
        )
        const chunks = yield* Stream.runCollect(
          Stream.fromReadableStream({
            evaluate: () => stream,
            onError: (cause) => new ReadFailed({ cause }),
          }),
        )
        expect(chunks.at(-1)).toEqual({ type: 'finish', messageMetadata: first.message.metadata })
        const response = yield* Effect.promise(() =>
          respond(
            opened.harness,
            opened.root.id,
            new Request('http://durable.test/chat', {
              method: 'POST',
              body: JSON.stringify({
                messages: [
                  {
                    id: first.message.id,
                    role: 'assistant',
                    parts: known.map((toolCallId) => ({ type: 'tool-pay', toolCallId })),
                  },
                ],
              }),
            }),
            context,
          ),
        )
        expect(response.status).toBe(200)
        yield* Effect.promise(() => response.text())
      }
      yield* Effect.promise(() =>
        expect(
          continueRun(
            opened.harness,
            opened.root.id,
            { messageId: first.message.id, known: new Set(['not-made']) },
            context,
          ),
        ).rejects.toBeInstanceOf(RunMissing),
      )
    }),
)
